import {prepareIr} from './ir-validation.js';

const argumentRegisters = Array.from({length: 8}, (_, index) => `x${index}`);
const floatArgumentRegisters = Array.from({length: 8}, (_, index) => index);

/** Initial AArch64 backend for primitive programs. */
export class AArch64Backend {
    generate(program, {optimizationLevel = 1, moduleId = null, includeRuntime = true} = {}) {
        if (![0, 1].includes(optimizationLevel)) throw new Error(`Unsupported optimization level '-O${optimizationLevel}'`);
        prepareIr(program, {optimize: optimizationLevel === 1, requireEntry: includeRuntime});
        if (program.externals.length) throw new Error('aarch64-linux bootstrap backend does not yet support native or foreign calls');
        this.program = program;
        this.runtimeLabel = 0;
        this.fieldOffsets = new Map();
        this.typeSizes = new Map();
        for (const type of program.types) {
            let offset = 16, alignment = 1;
            for (const field of type.fields) {
                if (field.ownership === 'member-weak') throw new Error('aarch64-linux bootstrap backend does not yet support weak object fields');
                const size = this.sizeOf(field.type), fieldAlignment = Math.min(size, 8);
                offset = this.align(offset, fieldAlignment);
                this.fieldOffsets.set(field.symbol, {offset, type: field.type, ownership: field.ownership});
                offset += size;
                alignment = Math.max(alignment, fieldAlignment);
            }
            this.typeSizes.set(type.name, Math.max(8, this.align(offset, alignment)));
        }
        this.symbols = new Map(program.functions.map(fn => [fn.name, this.mangle(fn.name)]));
        this.emittedTypes = moduleId === null ? program.types : program.types.filter(type => type.moduleId === moduleId);
        const functions = moduleId === null ? program.functions : program.functions.filter(fn => fn.moduleId === moduleId);
        this.stringLiterals = new Map();
        for (const instruction of functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions))) {
            if (instruction.op === 'string_constant') this.internString(instruction.value);
        }
        const lines = ['.text'];
        for (const fn of functions) lines.push(...this.generateFunction(fn));
        if (includeRuntime) lines.push(...this.generateStart(), ...this.allocationRuntime(), ...this.arrayRuntime(), ...this.stringRuntime());
        lines.push('.Larray_bounds_error:', '    mov x0, #70', '    mov x8, #93', '    svc #0',
            '.Ldivision_by_zero_error:', '    mov x0, #73', '    mov x8, #93', '    svc #0',
            '.Loptional_unwrap_error:', '    mov x0, #71', '    mov x8, #93', '    svc #0',
            '.Lcontract_dispatch_error:', '    mov x0, #75', '    mov x8, #93', '    svc #0',
            '.Lfloat_conversion_error:', '    mov x0, #76', '    mov x8, #93', '    svc #0', '');
        lines.push(...this.typeData(this.emittedTypes), ...this.stringData());
        lines.push('.section .note.GNU-stack,"",@progbits');
        return `${lines.join('\n')}\n`;
    }

    generateFunction(fn) {
        this.fn = fn;
        this.slots = new Map();
        this.outgoingSize = this.outgoingStackSize(fn);
        let slotOffset = this.outgoingSize;
        const reserve = key => {
            if (!this.slots.has(key)) {
                this.slots.set(key, slotOffset);
                slotOffset += 8;
            }
        };
        for (const parameter of fn.parameters) reserve(`name:${parameter.name}`);
        for (const instruction of fn.blocks.flatMap(block => block.instructions)) {
            if (instruction.result) reserve(`temp:${instruction.result}`);
            if (instruction.op === 'declare_local' || instruction.op === 'store_local') reserve(`name:${instruction.name}`);
        }
        const frameSize = this.align(slotOffset, 16);
        if (frameSize > 4064) throw new Error(`aarch64-linux bootstrap backend function '${fn.displayName}' needs an unsupported large stack frame`);
        const total = frameSize + 16;
        const symbol = this.symbols.get(fn.name);
        const end = `${symbol}__return`;
        const lines = [`.globl ${symbol}`, `.type ${symbol}, %function`, `${symbol}:`, `    sub sp, sp, #${total}`,
            `    str x29, [sp, #${frameSize}]`, `    str x30, [sp, #${frameSize + 8}]`, `    add x29, sp, #${frameSize}`];
        for (const location of this.argumentLocations(fn.parameters)) {
            if (location.kind === 'stack') lines.push(`    ldr x9, [x29, #${16 + location.stackIndex * 8}]`,
                `    str x9, ${this.named(location.value.name)}`);
            else if (location.kind === 'float') lines.push(
                `    fmov ${location.value.type === 'f32' ? 'w9' : 'x9'}, ${location.value.type === 'f32' ? 's' : 'd'}${location.register}`,
                `    str x9, ${this.named(location.value.name)}`);
            else lines.push(`    str ${location.register}, ${this.named(location.value.name)}`);
        }
        for (const block of fn.blocks) {
            if (block.label !== 'entry') lines.push(`${this.blockLabel(block.label)}:`);
            for (const instruction of block.instructions) lines.push(...this.instruction(instruction, end));
        }
        lines.push(`${end}:`, `    ldr x29, [sp, #${frameSize}]`, `    ldr x30, [sp, #${frameSize + 8}]`,
            `    add sp, sp, #${total}`, '    ret', `.size ${symbol}, .-${symbol}`, '');
        return lines;
    }

    instruction(instruction, end) {
        switch (instruction.op) {
            case 'constant':
                return [...this.constant('x9', instruction.value), ...this.normalize('x9', instruction.type),
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'float_constant':
                return [...this.floatConstant('x9', instruction.value, instruction.type),
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'string_constant':
                return [...this.address('x9', this.internString(instruction.value).descriptor),
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'declare_local':
                return instruction.value
                    ? [...this.load(instruction.value, 'x9'), `    str x9, ${this.named(instruction.name)}`]
                    : ['    str xzr, ' + this.named(instruction.name)];
            case 'load_local':
                return [`    ldr x9, ${this.named(instruction.name)}`, `    str x9, ${this.temp(instruction.result)}`];
            case 'store_local':
                return [...this.load(instruction.value, 'x9'), `    str x9, ${this.named(instruction.name)}`];
            case 'load_field': {
                const field = this.requireField(instruction.field);
                return [...this.load(instruction.object, 'x9'), `    ${this.loadMnemonic(field.type)} ${this.valueRegister('x9', field.type)}, [x9, #${field.offset}]`,
                    ...this.normalize('x9', field.type), `    str x9, ${this.temp(instruction.result)}`];
            }
            case 'store_field': {
                const field = this.requireField(instruction.field);
                return [...this.load(instruction.object, 'x9'), ...this.load(instruction.value, 'x10'),
                    `    ${this.storeMnemonic(field.type)} ${this.valueRegister('x10', field.type)}, [x9, #${field.offset}]`];
            }
            case 'unary': {
                const lines = this.load(instruction.operand, 'x9');
                if (instruction.operator === '-' && this.isFloat(instruction.type)) {
                    lines.push(...this.constant('x10', instruction.type === 'f32' ? 0x80000000n : 0x8000000000000000n),
                        '    eor x9, x9, x10');
                } else if (instruction.operator === '-') lines.push('    neg x9, x9');
                else if (instruction.operator === '!') lines.push('    cmp x9, #0', '    cset x9, eq');
                else throw new Error(`aarch64-linux bootstrap backend does not support unary '${instruction.operator}'`);
                lines.push(...this.normalize('x9', instruction.type));
                lines.push(`    str x9, ${this.temp(instruction.result)}`);
                return lines;
            }
            case 'binary':
                return this.binary(instruction);
            case 'allocate':
                return [...this.constant('x0', this.typeSizes.get(instruction.objectType) ?? 16), '    bl valen_alloc',
                    ...this.address('x9', this.typeLabel(instruction.objectType)), '    str x9, [x0, #0]',
                    ...this.constant('x9', 1), '    str x9, [x0, #8]',
                    `    str x0, ${this.temp(instruction.result)}`];
            case 'destroy_object': {
                const done = `${this.blockLabel(`destroy_done_${instruction.value.name}`)}`;
                return [...this.load(instruction.value, 'x9'), `    cbz x9, ${done}`, '    str xzr, [x9, #8]', `${done}:`];
            }
            case 'destroy_array': {
                const done = `.Larray_destroy_done_${this.runtimeLabel++}`;
                return [...this.load(instruction.value, 'x9'), `    cbz x9, ${done}`, '    str xzr, [x9, #32]', `${done}:`];
            }
            case 'array_new':
                return [...this.constant('x0', this.sizeOf(instruction.elementType)), ...this.load(instruction.length, 'x1'),
                    '    bl valen_array_new', `    str x0, ${this.temp(instruction.result)}`];
            case 'array_length':
                return [...this.load(instruction.array, 'x9'), '    ldr x9, [x9, #0]',
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'array_capacity':
                return [...this.load(instruction.array, 'x9'), '    ldr x9, [x9, #8]',
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'array_load': {
                if (instruction.elementOwnership === 'weak') throw new Error('aarch64-linux bootstrap backend does not yet support weak array elements');
                return [...this.load(instruction.array, 'x0'), ...this.load(instruction.index, 'x1'),
                    ...this.constant('x2', this.sizeOf(instruction.elementType)), '    bl valen_array_address',
                    `    ${this.loadMnemonic(instruction.elementType)} ${this.valueRegister('x9', instruction.elementType)}, [x0, #0]`,
                    ...this.normalize('x9', instruction.elementType), `    str x9, ${this.temp(instruction.result)}`];
            }
            case 'array_store': {
                if (instruction.elementOwnership === 'weak') throw new Error('aarch64-linux bootstrap backend does not yet support weak array elements');
                const lines = [...this.load(instruction.array, 'x0'), ...this.load(instruction.index, 'x1'),
                    ...this.constant('x2', this.sizeOf(instruction.elementType)), '    bl valen_array_address'];
                const baseType = instruction.elementType?.endsWith('?') ? instruction.elementType.slice(0, -1) : instruction.elementType;
                if (instruction.elementOwnership === 'owned' && this.typeSizes.has(baseType)) {
                    const empty = `.Larray_replace_empty_${this.runtimeLabel++}`;
                    lines.push('    ldr x9, [x0, #0]', `    cbz x9, ${empty}`, '    str xzr, [x9, #8]', `${empty}:`);
                }
                lines.push(...this.load(instruction.value, 'x9'),
                    `    ${this.storeMnemonic(instruction.elementType)} ${this.valueRegister('x9', instruction.elementType)}, [x0, #0]`);
                return lines;
            }
            case 'array_append':
                return [...this.load(instruction.array, 'x0'), ...this.load(instruction.value, 'x1'),
                    ...this.constant('x2', this.sizeOf(instruction.elementType)), '    bl valen_array_append'];
            case 'array_insert':
                return [...this.load(instruction.array, 'x0'), ...this.load(instruction.index, 'x1'),
                    ...this.load(instruction.value, 'x2'), ...this.constant('x3', this.sizeOf(instruction.elementType)),
                    '    bl valen_array_insert'];
            case 'array_remove':
                return [...this.load(instruction.array, 'x0'), ...this.load(instruction.index, 'x1'),
                    ...this.constant('x2', this.sizeOf(instruction.elementType)), '    bl valen_array_remove',
                    ...this.normalize('x0', instruction.type), `    str x0, ${this.temp(instruction.result)}`];
            case 'array_reserve':
                return [...this.load(instruction.array, 'x0'), ...this.load(instruction.capacity, 'x1'),
                    ...this.constant('x2', this.sizeOf(instruction.elementType)), '    bl valen_array_reserve'];
            case 'array_shrink':
                return [...this.load(instruction.array, 'x0'), ...this.constant('x1', this.sizeOf(instruction.elementType)),
                    '    bl valen_array_shrink_to_fit'];
            case 'array_slice':
                if (instruction.elementOwnership === 'weak') throw new Error('aarch64-linux bootstrap backend does not yet support weak array slices');
                if (instruction.elementOwnership === 'owned' && this.isManagedReferenceType(instruction.elementType)) {
                    throw new Error('aarch64-linux bootstrap backend does not yet support deep-copying owned managed array slices');
                }
                return [...this.load(instruction.array, 'x0'), ...this.load(instruction.start, 'x1'),
                    ...this.load(instruction.length, 'x2'), ...this.constant('x3', this.sizeOf(instruction.elementType)),
                    '    bl valen_array_slice', `    str x0, ${this.temp(instruction.result)}`];
            case 'string_length':
                return [...this.load(instruction.string, 'x9'), '    ldr x9, [x9, #8]',
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'string_codepoint_length':
                return [...this.load(instruction.string, 'x0'), '    bl valen_string_codepoint_length',
                    `    str x0, ${this.temp(instruction.result)}`];
            case 'string_codepoint_at':
                return [...this.load(instruction.string, 'x0'), ...this.load(instruction.index, 'x1'),
                    '    bl valen_string_codepoint_at', `    str x0, ${this.temp(instruction.result)}`];
            case 'string_grapheme_length':
                return [...this.load(instruction.string, 'x0'), '    bl valen_string_grapheme_length',
                    `    str x0, ${this.temp(instruction.result)}`];
            case 'string_grapheme_at':
                return [...this.load(instruction.string, 'x0'), ...this.load(instruction.index, 'x1'),
                    '    bl valen_string_grapheme_at', `    str x0, ${this.temp(instruction.result)}`];
            case 'string_load':
                return [...this.load(instruction.array, 'x0'), ...this.load(instruction.index, 'x1'),
                    '    bl valen_string_address', '    ldrb w9, [x0, #0]', `    str x9, ${this.temp(instruction.result)}`];
            case 'string_equal': {
                const lines = [...this.load(instruction.left, 'x0'), ...this.load(instruction.right, 'x1'), '    bl valen_string_equal'];
                if (instruction.negate) lines.push('    mov x9, #1', '    eor x0, x0, x9');
                lines.push(`    str x0, ${this.temp(instruction.result)}`);
                return lines;
            }
            case 'string_concat':
                return [...this.load(instruction.left, 'x0'), ...this.load(instruction.right, 'x1'),
                    '    bl valen_string_concat', `    str x0, ${this.temp(instruction.result)}`];
            case 'string_slice':
                return [...this.load(instruction.string, 'x0'), ...this.load(instruction.start, 'x1'),
                    ...this.load(instruction.length, 'x2'), '    bl valen_string_slice',
                    `    str x0, ${this.temp(instruction.result)}`];
            case 'string_to_bytes':
                return [...this.load(instruction.value, 'x0'), '    bl valen_string_to_bytes',
                    `    str x0, ${this.temp(instruction.result)}`];
            case 'bytes_to_string':
                return [...this.load(instruction.value, 'x0'), '    bl valen_bytes_to_string',
                    `    str x0, ${this.temp(instruction.result)}`];
            case 'call':
                return this.call(instruction, false);
            case 'virtual_call':
                return this.call(instruction, true);
            case 'contract_call':
                return this.contractCall(instruction);
            case 'type_test':
            case 'checked_cast':
                return this.typeRelationship(instruction);
            case 'unwrap':
                return [...this.load(instruction.value, 'x9'), '    cbz x9, .Loptional_unwrap_error',
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'convert':
                return this.convert(instruction);
            case 'jump':
                return [`    b ${this.blockLabel(instruction.target)}`];
            case 'branch':
                return [...this.load(instruction.condition, 'x9'), `    cbnz x9, ${this.blockLabel(instruction.thenTarget)}`,
                    `    b ${this.blockLabel(instruction.elseTarget)}`];
            case 'return':
                if (!instruction.value) return ['    mov x0, #0', `    b ${end}`];
                if (this.isFloat(instruction.value.type)) return [...this.load(instruction.value, 'x9'),
                    `    fmov ${instruction.value.type === 'f32' ? 's0, w9' : 'd0, x9'}`, `    b ${end}`];
                return [...this.load(instruction.value, 'x0'), `    b ${end}`];
            default:
                throw new Error(`aarch64-linux bootstrap backend does not yet support IR operation '${instruction.op}'`);
        }
    }

    binary(instruction) {
        if (this.isFloat(instruction.left.type)) return this.floatBinary(instruction);
        const lines = [...this.load(instruction.left, 'x9'), ...this.load(instruction.right, 'x10')];
        const operation = {'+': 'add', '-': 'sub', '*': 'mul', '&&': 'and', '||': 'orr', '&': 'and', '|': 'orr', '^': 'eor',
            '<<': 'lsl', '>>': this.isUnsigned(instruction.left.type) ? 'lsr' : 'asr'}[instruction.operator];
        const signedCondition = {'==': 'eq', '!=': 'ne', '===': 'eq', '!==': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge'};
        const unsignedCondition = {'<': 'cc', '<=': 'ls', '>': 'hi', '>=': 'cs'};
        const condition = this.isUnsigned(instruction.left.type) && unsignedCondition[instruction.operator]
            ? unsignedCondition[instruction.operator] : signedCondition[instruction.operator];
        if (operation) lines.push(`    ${operation} x9, x9, x10`);
        else if (instruction.operator === '/') lines.push('    cbz x10, .Ldivision_by_zero_error',
            `    ${this.isUnsigned(instruction.left.type) ? 'udiv' : 'sdiv'} x9, x9, x10`);
        else if (condition) lines.push('    cmp x9, x10', `    cset x9, ${condition}`);
        else throw new Error(`aarch64-linux bootstrap backend does not yet support binary '${instruction.operator}'`);
        lines.push(...this.normalize('x9', instruction.type));
        lines.push(`    str x9, ${this.temp(instruction.result)}`);
        return lines;
    }

    floatBinary(instruction) {
        const type = instruction.left.type;
        const width = type === 'f32' ? 's' : 'd';
        const integerWidth = type === 'f32' ? 'w' : 'x';
        const lines = [...this.load(instruction.left, 'x9'), ...this.load(instruction.right, 'x10'),
            `    fmov ${width}0, ${integerWidth}9`, `    fmov ${width}1, ${integerWidth}10`];
        const arithmetic = {'+': 'fadd', '-': 'fsub', '*': 'fmul', '/': 'fdiv'}[instruction.operator];
        if (arithmetic) lines.push(`    ${arithmetic} ${width}0, ${width}0, ${width}1`, `    fmov ${integerWidth}9, ${width}0`);
        else {
            const condition = {'==': 'eq', '!=': 'ne', '<': 'mi', '<=': 'ls', '>': 'gt', '>=': 'ge'}[instruction.operator];
            if (!condition) throw new Error(`aarch64-linux bootstrap backend does not support floating binary '${instruction.operator}'`);
            lines.push(`    fcmp ${width}0, ${width}1`, `    cset x9, ${condition}`);
        }
        lines.push(`    str x9, ${this.temp(instruction.result)}`);
        return lines;
    }

    convert(instruction) {
        const from = instruction.value.type, to = instruction.type;
        const lines = this.load(instruction.value, 'x9');
        if (this.isFloat(from) && this.isFloat(to)) {
            if (from !== to) lines.push(`    fmov ${from === 'f32' ? 's0, w9' : 'd0, x9'}`,
                `    fcvt ${to === 'f32' ? 's0, d0' : 'd0, s0'}`,
                `    fmov ${to === 'f32' ? 'w9, s0' : 'x9, d0'}`);
        } else if (!this.isFloat(from) && this.isFloat(to)) {
            lines.push(`    ${this.isUnsigned(from) ? 'ucvtf' : 'scvtf'} ${to === 'f32' ? 's0' : 'd0'}, x9`,
                `    fmov ${to === 'f32' ? 'w9, s0' : 'x9, d0'}`);
        } else if (this.isFloat(from)) lines.push(...this.floatToInteger(from, to));
        else lines.push(...this.normalize('x9', to));
        lines.push(`    str x9, ${this.temp(instruction.result)}`);
        return lines;
    }

    floatToInteger(from, to) {
        if (!/^[iu](8|16|32|64)$/.test(to)) throw new Error(`aarch64-linux bootstrap backend cannot convert floating point to '${to}'`);
        const lines = [from === 'f32' ? '    fmov s0, w9' : '    fmov d0, x9'];
        if (from === 'f32') lines.push('    fcvt d0, s0');
        lines.push('    fcmp d0, d0', '    b.vs .Lfloat_conversion_error');
        const bits = Number(to.slice(1));
        if (to.startsWith('u')) {
            lines.push(...this.floatConstant('x10', 0, 'f64'), '    fmov d1, x10', '    fcmp d0, d1',
                '    b.mi .Lfloat_conversion_error', ...this.floatConstant('x10', 2 ** bits, 'f64'),
                '    fmov d1, x10', '    fcmp d0, d1', '    b.ge .Lfloat_conversion_error', '    fcvtzu x9, d0');
        } else {
            const boundary = 2 ** (bits - 1);
            lines.push(...this.floatConstant('x10', -boundary, 'f64'), '    fmov d1, x10', '    fcmp d0, d1',
                '    b.mi .Lfloat_conversion_error', ...this.floatConstant('x10', boundary, 'f64'),
                '    fmov d1, x10', '    fcmp d0, d1', '    b.ge .Lfloat_conversion_error', '    fcvtzs x9, d0');
        }
        lines.push(...this.normalize('x9', to));
        return lines;
    }

    generateStart() {
        const entry = this.program.functions.find(fn => fn.name === this.program.entry);
        if (!entry) throw new Error('Program has no entry.__ method');
        const entryType = this.program.types.find(type => type.name === entry.owner);
        const lines = ['.globl _start', '.type _start, %function', '_start:', '    sub sp, sp, #16',
            ...this.constant('x0', this.typeSizes.get(entry.owner) ?? 16), '    bl valen_alloc',
            ...this.address('x9', this.typeLabel(entry.owner)), '    str x9, [x0, #0]', ...this.constant('x9', 1),
            '    str x9, [x0, #8]', '    str x0, [sp, #0]'];
        if (entryType?.initializer) lines.push(`    bl ${this.symbols.get(entryType.initializer)}`, '    ldr x0, [sp, #0]');
        lines.push(`    bl ${this.symbols.get(entry.name)}`, '    add sp, sp, #16', '    mov x8, #93', '    svc #0',
            '.size _start, .-_start', '');
        return lines;
    }

    allocationRuntime() {
        return ['.globl valen_alloc', '.type valen_alloc, %function', 'valen_alloc:', '    mov x1, x0', '    mov x0, #0',
            '    mov x2, #3', '    mov x3, #34', '    mov x4, #-1', '    mov x5, #0', '    mov x8, #222', '    svc #0',
            '    mov x9, #-4095', '    cmp x0, x9', '    b.cs .Lallocation_error', '    ret', '.size valen_alloc, .-valen_alloc',
            '.Lallocation_error:', '    mov x0, #72', '    mov x8, #93', '    svc #0', ''];
    }

    arrayRuntime() {
        return ['.globl valen_array_new', '.type valen_array_new, %function', 'valen_array_new:',
            '    sub sp, sp, #48', '    str x30, [sp, #40]', '    cmp x1, #0', '    b.lt .Larray_bounds_error',
            '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    mov x2, x1', '    cmp x2, #4',
            '    b.ge .Larray_capacity_ready', '    mov x2, #4', '.Larray_capacity_ready:', '    str x2, [sp, #16]',
            '    mul x3, x2, x0', '    udiv x4, x3, x0', '    cmp x4, x2', '    b.ne .Larray_bounds_error',
            '    str x3, [sp, #24]', '    mov x0, #40', '    bl valen_alloc', '    str x0, [sp, #32]',
            '    ldr x0, [sp, #24]', '    bl valen_alloc', '    mov x5, x0', '    ldr x0, [sp, #32]',
            '    ldr x1, [sp, #8]', '    str x1, [x0, #0]', '    ldr x1, [sp, #16]', '    str x1, [x0, #8]',
            '    str x5, [x0, #16]', '    ldr x1, [sp, #0]', '    str x1, [x0, #24]', '    mov x1, #1',
            '    str x1, [x0, #32]', '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret',
            '.size valen_array_new, .-valen_array_new', '', '.globl valen_array_address',
            '.type valen_array_address, %function', 'valen_array_address:', '    cbz x0, .Larray_bounds_error',
            '    cmp x1, #0', '    b.lt .Larray_bounds_error', '    ldr x3, [x0, #0]', '    cmp x1, x3',
            '    b.cs .Larray_bounds_error', '    mul x1, x1, x2', '    ldr x0, [x0, #16]', '    add x0, x0, x1',
            '    ret', '.size valen_array_address, .-valen_array_address', '', '.globl valen_array_reserve',
            '.type valen_array_reserve, %function', 'valen_array_reserve:', '    cmp x1, #0',
            '    b.lt .Larray_bounds_error', '    ldr x3, [x0, #8]', '    cmp x1, x3', '    b.ls .Larray_resize_return',
            '    b .Larray_resize', '.size valen_array_reserve, .-valen_array_reserve', '',
            '.globl valen_array_shrink_to_fit', '.type valen_array_shrink_to_fit, %function',
            'valen_array_shrink_to_fit:', '    mov x2, x1', '    ldr x1, [x0, #0]', '    ldr x3, [x0, #8]',
            '    cmp x1, x3', '    b.eq .Larray_resize_return', '.Larray_resize:', '    sub sp, sp, #64',
            '    str x30, [sp, #56]', '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    str x2, [sp, #16]',
            '    mul x3, x1, x2', '    udiv x4, x3, x2', '    cmp x4, x1', '    b.ne .Larray_bounds_error',
            '    mov x0, x3', '    cbnz x0, .Larray_resize_allocate', '    mov x0, #1', '.Larray_resize_allocate:',
            '    bl valen_alloc', '    str x0, [sp, #24]', '    ldr x3, [sp, #0]', '    ldr x4, [x3, #16]',
            '    mov x5, x0', '    ldr x6, [x3, #0]', '    ldr x7, [sp, #16]', '    mul x6, x6, x7',
            '.Larray_resize_copy:', '    cbz x6, .Larray_resize_copy_done', '    ldrb w7, [x4, #0]',
            '    strb w7, [x5, #0]', '    add x4, x4, #1', '    add x5, x5, #1', '    sub x6, x6, #1',
            '    b .Larray_resize_copy', '.Larray_resize_copy_done:', '    ldr x0, [sp, #0]', '    ldr x1, [sp, #8]',
            '    ldr x2, [sp, #24]', '    str x1, [x0, #8]', '    str x2, [x0, #16]', '    ldr x30, [sp, #56]',
            '    add sp, sp, #64', '.Larray_resize_return:', '    ret',
            '.size valen_array_shrink_to_fit, .-valen_array_shrink_to_fit', '', '.globl valen_array_append',
            '.type valen_array_append, %function', 'valen_array_append:', '    sub sp, sp, #48',
            '    str x30, [sp, #40]', '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    str x2, [sp, #16]',
            '    ldr x3, [x0, #0]', '    str x3, [sp, #24]', '    ldr x4, [x0, #8]', '    cmp x3, x4',
            '    b.cc .Larray_append_store', '    cmp x4, #4', '    b.ge .Larray_append_double', '    mov x1, #4',
            '    b .Larray_append_grow', '.Larray_append_double:', '    add x1, x4, x4', '    cmp x1, x4',
            '    b.cc .Larray_bounds_error', '.Larray_append_grow:', '    bl valen_array_reserve',
            '.Larray_append_store:', '    ldr x0, [sp, #0]', '    ldr x1, [sp, #8]', '    ldr x2, [sp, #16]',
            '    ldr x3, [sp, #24]', '    mul x4, x3, x2', '    ldr x5, [x0, #16]', '    add x5, x5, x4',
            '    cmp x2, #1', '    b.eq .Larray_append_store_1', '    cmp x2, #2', '    b.eq .Larray_append_store_2',
            '    cmp x2, #4', '    b.eq .Larray_append_store_4', '    str x1, [x5, #0]', '    b .Larray_append_done',
            '.Larray_append_store_1:', '    strb w1, [x5, #0]', '    b .Larray_append_done',
            '.Larray_append_store_2:', '    strh w1, [x5, #0]', '    b .Larray_append_done',
            '.Larray_append_store_4:', '    str w1, [x5, #0]', '.Larray_append_done:', '    add x3, x3, #1',
            '    str x3, [x0, #0]', '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret',
            '.size valen_array_append, .-valen_array_append', '', '.globl valen_array_insert',
            '.type valen_array_insert, %function', 'valen_array_insert:', '    cmp x1, #0',
            '    b.lt .Larray_bounds_error', '    ldr x4, [x0, #0]', '    cmp x1, x4',
            '    b.hi .Larray_bounds_error', '    sub sp, sp, #64', '    str x30, [sp, #56]',
            '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    str x2, [sp, #16]', '    str x3, [sp, #24]',
            '    str x4, [sp, #32]', '    ldr x5, [x0, #8]', '    cmp x4, x5', '    b.cc .Larray_insert_shift',
            '    cmp x5, #4', '    b.ge .Larray_insert_double', '    mov x1, #4', '    b .Larray_insert_grow',
            '.Larray_insert_double:', '    add x1, x5, x5', '    cmp x1, x5', '    b.cc .Larray_bounds_error',
            '.Larray_insert_grow:', '    mov x2, x3', '    bl valen_array_reserve', '.Larray_insert_shift:',
            '    ldr x0, [sp, #0]', '    ldr x1, [sp, #8]', '    ldr x2, [sp, #16]', '    ldr x3, [sp, #24]',
            '    ldr x4, [sp, #32]', '    sub x5, x4, x1', '    mul x5, x5, x3', '    mul x6, x1, x3',
            '    ldr x7, [x0, #16]', '    add x6, x7, x6', '    add x7, x6, x3', '    cbz x5, .Larray_insert_store',
            '    add x6, x6, x5', '    add x7, x7, x5', '.Larray_insert_move:', '    sub x6, x6, #1',
            '    sub x7, x7, #1', '    ldrb w8, [x6, #0]', '    strb w8, [x7, #0]', '    sub x5, x5, #1',
            '    cbnz x5, .Larray_insert_move', '.Larray_insert_store:', '    mul x5, x1, x3',
            '    ldr x6, [x0, #16]', '    add x6, x6, x5', '    cmp x3, #1', '    b.eq .Larray_insert_store_1',
            '    cmp x3, #2', '    b.eq .Larray_insert_store_2', '    cmp x3, #4', '    b.eq .Larray_insert_store_4',
            '    str x2, [x6, #0]', '    b .Larray_insert_done', '.Larray_insert_store_1:', '    strb w2, [x6, #0]',
            '    b .Larray_insert_done', '.Larray_insert_store_2:', '    strh w2, [x6, #0]',
            '    b .Larray_insert_done', '.Larray_insert_store_4:', '    str w2, [x6, #0]', '.Larray_insert_done:',
            '    add x4, x4, #1', '    str x4, [x0, #0]', '    ldr x30, [sp, #56]', '    add sp, sp, #64',
            '    ret', '.size valen_array_insert, .-valen_array_insert', '', '.globl valen_array_remove',
            '.type valen_array_remove, %function', 'valen_array_remove:', '    cmp x1, #0',
            '    b.lt .Larray_bounds_error', '    ldr x3, [x0, #0]', '    cmp x1, x3',
            '    b.cs .Larray_bounds_error', '    mul x4, x1, x2', '    ldr x6, [x0, #16]', '    add x4, x6, x4',
            '    cmp x2, #1', '    b.eq .Larray_remove_load_1', '    cmp x2, #2', '    b.eq .Larray_remove_load_2',
            '    cmp x2, #4', '    b.eq .Larray_remove_load_4', '    ldr x5, [x4, #0]', '    b .Larray_remove_shift',
            '.Larray_remove_load_1:', '    ldrb w5, [x4, #0]', '    b .Larray_remove_shift',
            '.Larray_remove_load_2:', '    ldrh w5, [x4, #0]', '    b .Larray_remove_shift',
            '.Larray_remove_load_4:', '    ldr w5, [x4, #0]', '.Larray_remove_shift:', '    sub x3, x3, #1',
            '    sub x6, x3, x1', '    mul x6, x6, x2', '    add x7, x4, x2', '.Larray_remove_move:',
            '    cbz x6, .Larray_remove_clear_start', '    ldrb w8, [x7, #0]', '    strb w8, [x4, #0]',
            '    add x7, x7, #1', '    add x4, x4, #1', '    sub x6, x6, #1', '    b .Larray_remove_move',
            '.Larray_remove_clear_start:', '    mul x6, x3, x2', '    ldr x7, [x0, #16]', '    add x7, x7, x6',
            '    mov x8, #0', '    mov x6, x2', '.Larray_remove_clear:', '    strb w8, [x7, #0]',
            '    add x7, x7, #1', '    sub x6, x6, #1', '    cbnz x6, .Larray_remove_clear',
            '    str x3, [x0, #0]', '    mov x0, x5', '    ret', '.size valen_array_remove, .-valen_array_remove', '',
            '.globl valen_array_slice', '.type valen_array_slice, %function', 'valen_array_slice:',
            '    cmp x1, #0', '    b.lt .Larray_bounds_error', '    cmp x2, #0', '    b.lt .Larray_bounds_error',
            '    add x4, x1, x2', '    cmp x4, x1', '    b.cc .Larray_bounds_error', '    ldr x5, [x0, #0]',
            '    cmp x4, x5', '    b.hi .Larray_bounds_error', '    sub sp, sp, #64', '    str x30, [sp, #56]',
            '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    str x2, [sp, #16]', '    str x3, [sp, #24]',
            '    mov x0, x3', '    mov x1, x2', '    bl valen_array_new', '    str x0, [sp, #32]',
            '    ldr x4, [sp, #8]', '    ldr x5, [sp, #24]', '    mul x4, x4, x5', '    ldr x6, [sp, #0]',
            '    ldr x6, [x6, #16]', '    add x6, x6, x4', '    ldr x7, [x0, #16]', '    ldr x4, [sp, #16]',
            '    mul x4, x4, x5', '.Larray_slice_copy:', '    cbz x4, .Larray_slice_done', '    ldrb w8, [x6, #0]',
            '    strb w8, [x7, #0]', '    add x6, x6, #1', '    add x7, x7, #1', '    sub x4, x4, #1',
            '    b .Larray_slice_copy', '.Larray_slice_done:', '    ldr x0, [sp, #32]', '    ldr x30, [sp, #56]',
            '    add sp, sp, #64', '    ret', '.size valen_array_slice, .-valen_array_slice', ''];
    }

    stringRuntime() {
        return ['.globl valen_string_new', '.type valen_string_new, %function', 'valen_string_new:',
            '    cmp x0, #0', '    b.lt .Larray_bounds_error', '    sub sp, sp, #32', '    str x30, [sp, #24]',
            '    str x0, [sp, #0]', '    mov x0, #24', '    bl valen_alloc', '    str x0, [sp, #8]',
            '    ldr x0, [sp, #0]', '    cbnz x0, .Lstring_new_allocate', '    mov x0, #1', '.Lstring_new_allocate:',
            '    str x0, [sp, #16]', '    bl valen_alloc', '    mov x1, x0', '    ldr x0, [sp, #8]',
            '    str x1, [x0, #0]', '    ldr x1, [sp, #0]', '    str x1, [x0, #8]', '    ldr x1, [sp, #16]',
            '    str x1, [x0, #16]', '    ldr x30, [sp, #24]', '    add sp, sp, #32', '    ret',
            '.size valen_string_new, .-valen_string_new', '', '.globl valen_string_address',
            '.type valen_string_address, %function', 'valen_string_address:', '    cbz x0, .Larray_bounds_error',
            '    cmp x1, #0', '    b.lt .Larray_bounds_error', '    ldr x2, [x0, #8]', '    cmp x1, x2',
            '    b.cs .Larray_bounds_error', '    ldr x0, [x0, #0]', '    add x0, x0, x1', '    ret',
            '.size valen_string_address, .-valen_string_address', '', '.type valen_utf8_decode, %function',
            'valen_utf8_decode:', '    cbz x1, .Lutf8_decode_invalid', '    ldrb w3, [x0, #0]',
            '    cmp x3, #128', '    b.cc .Lutf8_decode_ascii', '    cmp x3, #194', '    b.cc .Lutf8_decode_invalid',
            '    cmp x3, #223', '    b.ls .Lutf8_decode_two', '    cmp x3, #239', '    b.ls .Lutf8_decode_three',
            '    cmp x3, #244', '    b.ls .Lutf8_decode_four', '    b .Lutf8_decode_invalid',
            '.Lutf8_decode_ascii:', '    mov x0, x3', '    mov x2, #1', '    ret',
            '.Lutf8_decode_two:', '    cmp x1, #2', '    b.cc .Lutf8_decode_invalid', '    ldrb w4, [x0, #1]',
            '    mov x5, #192', '    and x5, x4, x5', '    cmp x5, #128', '    b.ne .Lutf8_decode_invalid',
            '    mov x5, #31', '    and x3, x3, x5', '    lsl x3, x3, #6', '    mov x5, #63',
            '    and x4, x4, x5', '    orr x0, x3, x4', '    mov x2, #2', '    ret',
            '.Lutf8_decode_three:', '    cmp x1, #3', '    b.cc .Lutf8_decode_invalid', '    ldrb w4, [x0, #1]',
            '    ldrb w5, [x0, #2]', '    mov x6, #192', '    and x7, x4, x6', '    cmp x7, #128',
            '    b.ne .Lutf8_decode_invalid', '    and x7, x5, x6', '    cmp x7, #128',
            '    b.ne .Lutf8_decode_invalid', '    cmp x3, #224', '    b.ne .Lutf8_decode_three_surrogate',
            '    cmp x4, #160', '    b.cc .Lutf8_decode_invalid', '.Lutf8_decode_three_surrogate:',
            '    cmp x3, #237', '    b.ne .Lutf8_decode_three_build', '    cmp x4, #160',
            '    b.cs .Lutf8_decode_invalid', '.Lutf8_decode_three_build:', '    mov x6, #15',
            '    and x3, x3, x6', '    lsl x3, x3, #12', '    mov x6, #63', '    and x4, x4, x6',
            '    lsl x4, x4, #6', '    orr x3, x3, x4', '    and x5, x5, x6', '    orr x0, x3, x5',
            '    mov x2, #3', '    ret',
            '.Lutf8_decode_four:', '    cmp x1, #4', '    b.cc .Lutf8_decode_invalid', '    ldrb w4, [x0, #1]',
            '    ldrb w5, [x0, #2]', '    ldrb w6, [x0, #3]', '    mov x7, #192', '    and x8, x4, x7',
            '    cmp x8, #128', '    b.ne .Lutf8_decode_invalid', '    and x8, x5, x7', '    cmp x8, #128',
            '    b.ne .Lutf8_decode_invalid', '    and x8, x6, x7', '    cmp x8, #128',
            '    b.ne .Lutf8_decode_invalid', '    cmp x3, #240', '    b.ne .Lutf8_decode_four_max',
            '    cmp x4, #144', '    b.cc .Lutf8_decode_invalid', '.Lutf8_decode_four_max:',
            '    cmp x3, #244', '    b.ne .Lutf8_decode_four_build', '    cmp x4, #144',
            '    b.cs .Lutf8_decode_invalid', '.Lutf8_decode_four_build:', '    mov x7, #7',
            '    and x3, x3, x7', '    lsl x3, x3, #18', '    mov x7, #63', '    and x4, x4, x7',
            '    lsl x4, x4, #12', '    orr x3, x3, x4', '    and x5, x5, x7', '    lsl x5, x5, #6',
            '    orr x3, x3, x5', '    and x6, x6, x7', '    orr x0, x3, x6', '    mov x2, #4', '    ret',
            '.Lutf8_decode_invalid:', '    mov x0, #65533', '    mov x2, #1', '    ret',
            '.size valen_utf8_decode, .-valen_utf8_decode', '', '.globl valen_string_codepoint_length',
            '.type valen_string_codepoint_length, %function', 'valen_string_codepoint_length:',
            '    sub sp, sp, #48', '    str x30, [sp, #40]', '    ldr x3, [x0, #0]', '    str x3, [sp, #0]',
            '    ldr x3, [x0, #8]', '    str x3, [sp, #8]', '    str xzr, [sp, #16]',
            '.Lcodepoint_length_loop:', '    ldr x1, [sp, #8]', '    cbz x1, .Lcodepoint_length_done',
            '    ldr x0, [sp, #0]', '    bl valen_utf8_decode', '    ldr x3, [sp, #0]', '    add x3, x3, x2',
            '    str x3, [sp, #0]', '    ldr x3, [sp, #8]', '    sub x3, x3, x2', '    str x3, [sp, #8]',
            '    ldr x3, [sp, #16]', '    add x3, x3, #1', '    str x3, [sp, #16]',
            '    b .Lcodepoint_length_loop', '.Lcodepoint_length_done:', '    ldr x0, [sp, #16]',
            '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret',
            '.size valen_string_codepoint_length, .-valen_string_codepoint_length', '',
            '.globl valen_string_codepoint_at', '.type valen_string_codepoint_at, %function',
            'valen_string_codepoint_at:', '    cmp x1, #0', '    b.lt .Larray_bounds_error', '    sub sp, sp, #48',
            '    str x30, [sp, #40]', '    ldr x3, [x0, #0]', '    str x3, [sp, #0]', '    ldr x3, [x0, #8]',
            '    str x3, [sp, #8]', '    str x1, [sp, #16]', '.Lcodepoint_at_loop:', '    ldr x1, [sp, #8]',
            '    cbz x1, .Lcodepoint_at_error', '    ldr x0, [sp, #0]', '    bl valen_utf8_decode',
            '    ldr x3, [sp, #16]', '    cbz x3, .Lcodepoint_at_done', '    sub x3, x3, #1',
            '    str x3, [sp, #16]', '    ldr x3, [sp, #0]', '    add x3, x3, x2', '    str x3, [sp, #0]',
            '    ldr x3, [sp, #8]', '    sub x3, x3, x2', '    str x3, [sp, #8]', '    b .Lcodepoint_at_loop',
            '.Lcodepoint_at_done:', '    str x0, [sp, #24]', '    ldr x0, [sp, #24]', '    ldr x30, [sp, #40]',
            '    add sp, sp, #48', '    ret', '.Lcodepoint_at_error:', '    ldr x30, [sp, #40]',
            '    add sp, sp, #48', '    b .Larray_bounds_error',
            '.size valen_string_codepoint_at, .-valen_string_codepoint_at', '',
            '.type valen_grapheme_next, %function', 'valen_grapheme_next:', '    sub sp, sp, #80',
            '    str x30, [sp, #72]', '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    bl valen_utf8_decode',
            '    str x2, [sp, #16]', '    str x0, [sp, #24]', '    str xzr, [sp, #32]',
            ...this.constant('x3', 127462), '    cmp x0, x3', '    b.cc .Lgrapheme_next_loop',
            ...this.constant('x3', 127487), '    cmp x0, x3', '    b.hi .Lgrapheme_next_loop',
            '    mov x3, #1', '    str x3, [sp, #32]', '.Lgrapheme_next_loop:', '    ldr x3, [sp, #16]',
            '    ldr x4, [sp, #8]', '    cmp x3, x4', '    b.cs .Lgrapheme_next_done', '    ldr x0, [sp, #0]',
            '    add x0, x0, x3', '    sub x1, x4, x3', '    bl valen_utf8_decode', '    str x0, [sp, #40]',
            '    str x2, [sp, #48]', '    ldr x3, [sp, #24]', '    cmp x3, #13',
            '    b.ne .Lgrapheme_check_ri', '    cmp x0, #10', '    b.eq .Lgrapheme_join',
            '.Lgrapheme_check_ri:', '    ldr x3, [sp, #32]', '    cbz x3, .Lgrapheme_check_extend',
            ...this.constant('x3', 127462), '    cmp x0, x3', '    b.cc .Lgrapheme_next_done',
            ...this.constant('x3', 127487), '    cmp x0, x3', '    b.hi .Lgrapheme_next_done',
            '    str xzr, [sp, #32]', '    b .Lgrapheme_join', '.Lgrapheme_check_extend:',
            ...this.constant('x3', 8205), '    cmp x0, x3', '    b.eq .Lgrapheme_join',
            '    ldr x4, [sp, #24]', '    cmp x4, x3', '    b.eq .Lgrapheme_join',
            '    cmp x0, #768', '    b.cc .Lgrapheme_extend_1ab0', '    cmp x0, #879',
            '    b.ls .Lgrapheme_join', '.Lgrapheme_extend_1ab0:', ...this.constant('x3', 6832),
            '    cmp x0, x3', '    b.cc .Lgrapheme_extend_1dc0', ...this.constant('x3', 6911),
            '    cmp x0, x3', '    b.ls .Lgrapheme_join', '.Lgrapheme_extend_1dc0:',
            ...this.constant('x3', 7616), '    cmp x0, x3', '    b.cc .Lgrapheme_extend_20d0',
            ...this.constant('x3', 7679), '    cmp x0, x3', '    b.ls .Lgrapheme_join',
            '.Lgrapheme_extend_20d0:', ...this.constant('x3', 8400), '    cmp x0, x3',
            '    b.cc .Lgrapheme_extend_fe00', ...this.constant('x3', 8447), '    cmp x0, x3',
            '    b.ls .Lgrapheme_join', '.Lgrapheme_extend_fe00:', ...this.constant('x3', 65024),
            '    cmp x0, x3', '    b.cc .Lgrapheme_extend_fe20', ...this.constant('x3', 65039),
            '    cmp x0, x3', '    b.ls .Lgrapheme_join', '.Lgrapheme_extend_fe20:',
            ...this.constant('x3', 65056), '    cmp x0, x3', '    b.cc .Lgrapheme_extend_modifier',
            ...this.constant('x3', 65071), '    cmp x0, x3', '    b.ls .Lgrapheme_join',
            '.Lgrapheme_extend_modifier:', ...this.constant('x3', 127995), '    cmp x0, x3',
            '    b.cc .Lgrapheme_extend_vs', ...this.constant('x3', 127999), '    cmp x0, x3',
            '    b.ls .Lgrapheme_join', '.Lgrapheme_extend_vs:', ...this.constant('x3', 917760),
            '    cmp x0, x3', '    b.cc .Lgrapheme_next_done', ...this.constant('x3', 917999),
            '    cmp x0, x3', '    b.hi .Lgrapheme_next_done', '.Lgrapheme_join:', '    ldr x3, [sp, #16]',
            '    ldr x4, [sp, #48]', '    add x3, x3, x4', '    str x3, [sp, #16]', '    ldr x3, [sp, #40]',
            '    str x3, [sp, #24]', '    b .Lgrapheme_next_loop', '.Lgrapheme_next_done:',
            '    ldr x0, [sp, #16]', '    ldr x30, [sp, #72]', '    add sp, sp, #80', '    ret',
            '.size valen_grapheme_next, .-valen_grapheme_next', '', '.globl valen_string_grapheme_length',
            '.type valen_string_grapheme_length, %function', 'valen_string_grapheme_length:',
            '    sub sp, sp, #48', '    str x30, [sp, #40]', '    ldr x3, [x0, #0]', '    str x3, [sp, #0]',
            '    ldr x3, [x0, #8]', '    str x3, [sp, #8]', '    str xzr, [sp, #16]',
            '.Lgrapheme_length_loop:', '    ldr x1, [sp, #8]', '    cbz x1, .Lgrapheme_length_done',
            '    ldr x0, [sp, #0]', '    bl valen_grapheme_next', '    mov x2, x0', '    ldr x3, [sp, #0]',
            '    add x3, x3, x2', '    str x3, [sp, #0]', '    ldr x3, [sp, #8]', '    sub x3, x3, x2',
            '    str x3, [sp, #8]', '    ldr x3, [sp, #16]', '    add x3, x3, #1', '    str x3, [sp, #16]',
            '    b .Lgrapheme_length_loop', '.Lgrapheme_length_done:', '    ldr x0, [sp, #16]',
            '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret',
            '.size valen_string_grapheme_length, .-valen_string_grapheme_length', '',
            '.globl valen_string_grapheme_at', '.type valen_string_grapheme_at, %function',
            'valen_string_grapheme_at:', '    cmp x1, #0', '    b.lt .Larray_bounds_error', '    sub sp, sp, #64',
            '    str x30, [sp, #56]', '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    str xzr, [sp, #16]',
            '    ldr x3, [x0, #8]', '    str x3, [sp, #24]', '.Lgrapheme_at_loop:', '    ldr x1, [sp, #24]',
            '    cbz x1, .Lgrapheme_at_error', '    ldr x0, [sp, #0]', '    ldr x0, [x0, #0]',
            '    ldr x3, [sp, #16]', '    add x0, x0, x3', '    bl valen_grapheme_next', '    str x0, [sp, #32]',
            '    ldr x3, [sp, #8]', '    cbz x3, .Lgrapheme_at_found', '    sub x3, x3, #1',
            '    str x3, [sp, #8]', '    ldr x3, [sp, #16]', '    add x3, x3, x0', '    str x3, [sp, #16]',
            '    ldr x3, [sp, #24]', '    sub x3, x3, x0', '    str x3, [sp, #24]', '    b .Lgrapheme_at_loop',
            '.Lgrapheme_at_found:', '    ldr x0, [sp, #0]', '    ldr x1, [sp, #16]', '    ldr x2, [sp, #32]',
            '    bl valen_string_slice', '    str x0, [sp, #40]', '    ldr x0, [sp, #40]', '    ldr x30, [sp, #56]',
            '    add sp, sp, #64', '    ret', '.Lgrapheme_at_error:', '    ldr x30, [sp, #56]',
            '    add sp, sp, #64', '    b .Larray_bounds_error',
            '.size valen_string_grapheme_at, .-valen_string_grapheme_at', '', '.globl valen_string_equal',
            '.type valen_string_equal, %function', 'valen_string_equal:', '    cmp x0, x1',
            '    b.eq .Lstring_equal_yes', '    ldr x2, [x0, #8]', '    ldr x3, [x1, #8]', '    cmp x2, x3',
            '    b.ne .Lstring_equal_no', '    ldr x0, [x0, #0]', '    ldr x1, [x1, #0]',
            '.Lstring_equal_loop:', '    cbz x2, .Lstring_equal_yes', '    ldrb w3, [x0, #0]', '    ldrb w4, [x1, #0]',
            '    cmp x3, x4', '    b.ne .Lstring_equal_no', '    add x0, x0, #1', '    add x1, x1, #1',
            '    sub x2, x2, #1', '    b .Lstring_equal_loop', '.Lstring_equal_yes:', '    mov x0, #1', '    ret',
            '.Lstring_equal_no:', '    mov x0, #0', '    ret', '.size valen_string_equal, .-valen_string_equal', '',
            '.globl valen_string_concat', '.type valen_string_concat, %function', 'valen_string_concat:',
            '    ldr x2, [x0, #8]', '    ldr x3, [x1, #8]', '    add x4, x2, x3', '    cmp x4, x2',
            '    b.cc .Larray_bounds_error', '    sub sp, sp, #64', '    str x30, [sp, #56]', '    str x0, [sp, #0]',
            '    str x1, [sp, #8]', '    str x2, [sp, #16]', '    str x3, [sp, #24]', '    mov x0, x4',
            '    bl valen_string_new', '    str x0, [sp, #32]', '    ldr x5, [x0, #0]', '    ldr x0, [sp, #0]',
            '    ldr x4, [x0, #0]', '    ldr x2, [sp, #16]', '.Lstring_concat_left:',
            '    cbz x2, .Lstring_concat_right_start', '    ldrb w6, [x4, #0]', '    strb w6, [x5, #0]',
            '    add x4, x4, #1', '    add x5, x5, #1', '    sub x2, x2, #1', '    b .Lstring_concat_left',
            '.Lstring_concat_right_start:', '    ldr x0, [sp, #8]', '    ldr x4, [x0, #0]', '    ldr x2, [sp, #24]',
            '.Lstring_concat_right:', '    cbz x2, .Lstring_concat_done', '    ldrb w6, [x4, #0]',
            '    strb w6, [x5, #0]', '    add x4, x4, #1', '    add x5, x5, #1', '    sub x2, x2, #1',
            '    b .Lstring_concat_right', '.Lstring_concat_done:', '    ldr x0, [sp, #32]', '    ldr x30, [sp, #56]',
            '    add sp, sp, #64', '    ret', '.size valen_string_concat, .-valen_string_concat', '',
            '.globl valen_string_slice', '.type valen_string_slice, %function', 'valen_string_slice:',
            '    cmp x1, #0', '    b.lt .Larray_bounds_error', '    cmp x2, #0', '    b.lt .Larray_bounds_error',
            '    add x3, x1, x2', '    cmp x3, x1', '    b.cc .Larray_bounds_error', '    ldr x4, [x0, #8]',
            '    cmp x3, x4', '    b.hi .Larray_bounds_error', '    sub sp, sp, #48', '    str x30, [sp, #40]',
            '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    str x2, [sp, #16]', '    mov x0, x2',
            '    bl valen_string_new', '    str x0, [sp, #24]', '    ldr x3, [x0, #0]', '    ldr x0, [sp, #0]',
            '    ldr x4, [x0, #0]', '    ldr x1, [sp, #8]', '    add x4, x4, x1', '    ldr x2, [sp, #16]',
            '.Lstring_slice_copy:', '    cbz x2, .Lstring_slice_done', '    ldrb w5, [x4, #0]', '    strb w5, [x3, #0]',
            '    add x4, x4, #1', '    add x3, x3, #1', '    sub x2, x2, #1', '    b .Lstring_slice_copy',
            '.Lstring_slice_done:', '    ldr x0, [sp, #24]', '    ldr x30, [sp, #40]', '    add sp, sp, #48',
            '    ret', '.size valen_string_slice, .-valen_string_slice', '', '.globl valen_string_to_bytes',
            '.type valen_string_to_bytes, %function', 'valen_string_to_bytes:', '    sub sp, sp, #48',
            '    str x30, [sp, #40]', '    str x0, [sp, #0]', '    ldr x1, [x0, #8]', '    str x1, [sp, #8]',
            '    mov x0, #1', '    bl valen_array_new', '    str x0, [sp, #16]', '    ldr x2, [x0, #16]',
            '    ldr x0, [sp, #0]', '    ldr x1, [x0, #0]', '    ldr x3, [sp, #8]',
            '.Lstring_to_bytes_copy:', '    cbz x3, .Lstring_to_bytes_done', '    ldrb w4, [x1, #0]',
            '    strb w4, [x2, #0]', '    add x1, x1, #1', '    add x2, x2, #1', '    sub x3, x3, #1',
            '    b .Lstring_to_bytes_copy', '.Lstring_to_bytes_done:', '    ldr x0, [sp, #16]', '    ldr x30, [sp, #40]',
            '    add sp, sp, #48', '    ret', '.size valen_string_to_bytes, .-valen_string_to_bytes', '',
            '.globl valen_bytes_to_string', '.type valen_bytes_to_string, %function', 'valen_bytes_to_string:',
            '    sub sp, sp, #48', '    str x30, [sp, #40]', '    str x0, [sp, #0]', '    ldr x1, [x0, #0]',
            '    str x1, [sp, #8]', '    mov x0, x1', '    bl valen_string_new', '    str x0, [sp, #16]',
            '    ldr x2, [x0, #0]', '    ldr x0, [sp, #0]', '    ldr x1, [x0, #16]', '    ldr x3, [sp, #8]',
            '.Lbytes_to_string_copy:', '    cbz x3, .Lbytes_to_string_done', '    ldrb w4, [x1, #0]',
            '    strb w4, [x2, #0]', '    add x1, x1, #1', '    add x2, x2, #1', '    sub x3, x3, #1',
            '    b .Lbytes_to_string_copy', '.Lbytes_to_string_done:', '    ldr x0, [sp, #16]', '    ldr x30, [sp, #40]',
            '    add sp, sp, #48', '    ret', '.size valen_bytes_to_string, .-valen_bytes_to_string', ''];
    }

    call(instruction, dynamic) {
        const lines = this.loadCallArguments(instruction.arguments);
        if (dynamic) {
            if (!Number.isInteger(instruction.slot) || instruction.slot < 0) throw new Error('aarch64-linux virtual call has no dispatch slot');
            lines.push('    ldr x9, [x0, #0]', '    cbz x9, .Lcontract_dispatch_error',
                `    ldr x9, [x9, #${40 + instruction.slot * 8}]`, '    cbz x9, .Lcontract_dispatch_error', '    blr x9');
        } else {
            const target = this.symbols.get(instruction.target);
            if (!target) throw new Error(`aarch64-linux bootstrap backend has no function symbol for '${instruction.target}'`);
            lines.push(`    bl ${target}`);
        }
        lines.push(...this.storeCallResult(instruction));
        return lines;
    }

    contractCall(instruction) {
        if (!Number.isInteger(instruction.slot) || instruction.slot < 0) throw new Error('aarch64-linux contract call has no dispatch slot');
        const id = this.runtimeLabel++;
        const loop = `.Lcontract_call_${id}`;
        const found = `.Lcontract_found_${id}`;
        const lines = [...this.load(instruction.arguments[0], 'x9'), '    cbz x9, .Lcontract_dispatch_error',
            '    ldr x10, [x9, #0]', '    cbz x10, .Lcontract_dispatch_error', '    ldr x10, [x10, #8]',
            '    ldr x11, [x10, #0]', '    add x10, x10, #8', ...this.address('x12', this.typeLabel(instruction.contractType)),
            `${loop}:`, '    cbz x11, .Lcontract_dispatch_error', '    ldr x13, [x10, #0]', '    cmp x13, x12',
            `    b.eq ${found}`, '    add x10, x10, #16', '    sub x11, x11, #1', `    b ${loop}`, `${found}:`,
            '    ldr x11, [x10, #8]', `    ldr x11, [x11, #${instruction.slot * 8}]`,
            '    cbz x11, .Lcontract_dispatch_error', ...this.loadCallArguments(instruction.arguments), '    blr x11',
            ...this.storeCallResult(instruction)];
        return lines;
    }

    typeRelationship(instruction) {
        const id = this.runtimeLabel++;
        const loop = `.Ltype_test_${id}`;
        const scan = `.Ltype_contract_${id}`;
        const next = `.Ltype_next_${id}`;
        const match = `.Ltype_match_${id}`;
        const done = `.Ltype_done_${id}`;
        return [...this.load(instruction.value, 'x9'), '    mov x0, #0', `    cbz x9, ${done}`,
            '    ldr x11, [x9, #0]', ...this.address('x10', this.typeLabel(instruction.targetType)), `${loop}:`,
            `    cbz x11, ${done}`, '    cmp x11, x10', `    b.eq ${match}`, '    ldr x12, [x11, #8]',
            '    ldr x13, [x12, #0]', '    add x12, x12, #8', `${scan}:`, `    cbz x13, ${next}`,
            '    ldr x14, [x12, #0]', '    cmp x14, x10', `    b.eq ${match}`, '    add x12, x12, #16',
            '    sub x13, x13, #1', `    b ${scan}`, `${next}:`, '    ldr x11, [x11, #0]', `    b ${loop}`,
            `${match}:`, instruction.op === 'type_test' ? '    mov x0, #1' : '    mov x0, x9', `${done}:`,
            `    str x0, ${this.temp(instruction.result)}`];
    }

    loadCallArguments(arguments_) {
        const lines = [];
        for (const location of this.argumentLocations(arguments_)) {
            if (location.kind === 'stack') lines.push(...this.load(location.value, 'x9'),
                `    str x9, [sp, #${location.stackIndex * 8}]`);
            else if (location.kind === 'float') lines.push(...this.load(location.value, 'x9'),
                `    fmov ${location.value.type === 'f32' ? 's' : 'd'}${location.register}, ${location.value.type === 'f32' ? 'w9' : 'x9'}`);
            else lines.push(...this.load(location.value, location.register));
        }
        return lines;
    }

    storeCallResult(instruction) {
        const lines = [];
        if (instruction.result && this.isFloat(instruction.type)) lines.push(
            `    fmov ${instruction.type === 'f32' ? 'w9' : 'x9'}, ${instruction.type === 'f32' ? 's0' : 'd0'}`,
            `    str x9, ${this.temp(instruction.result)}`);
        else if (instruction.result) lines.push(...this.normalize('x0', instruction.type), `    str x0, ${this.temp(instruction.result)}`);
        return lines;
    }

    load(value, register) {
        if (value.kind === 'temporary') return [`    ldr ${register}, ${this.temp(value.name)}`];
        if (value.kind === 'parameter') return [`    ldr ${register}, ${this.named(value.name)}`];
        throw new Error(`aarch64-linux bootstrap backend cannot load '${value.kind}' values yet`);
    }

    constant(register, value) {
        const integer = BigInt.asUintN(64, BigInt(value));
        const lines = [`    movz ${register}, #${integer & 0xffffn}`];
        for (let shift = 16n; shift < 64n; shift += 16n) {
            const part = (integer >> shift) & 0xffffn;
            if (part !== 0n) lines.push(`    movk ${register}, #${part}, lsl #${shift}`);
        }
        return lines;
    }

    floatConstant(register, value, type) {
        const bytes = Buffer.alloc(8);
        if (type === 'f32') {
            bytes.writeFloatLE(Number(value));
            return this.constant(register, BigInt(bytes.readUInt32LE()));
        }
        bytes.writeDoubleLE(Number(value));
        return this.constant(register, bytes.readBigUInt64LE());
    }

    argumentLocations(values) {
        let general = 0, floating = 0, stack = 0;
        return values.map(value => {
            if (this.isFloat(value.type) && floating < floatArgumentRegisters.length) {
                return {kind: 'float', register: floatArgumentRegisters[floating++], value};
            }
            if (!this.isFloat(value.type) && general < argumentRegisters.length) {
                return {kind: 'general', register: argumentRegisters[general++], value};
            }
            return {kind: 'stack', stackIndex: stack++, value};
        });
    }

    outgoingStackSize(fn) {
        let slots = 0;
        for (const instruction of fn.blocks.flatMap(block => block.instructions)) {
            if (!['call', 'virtual_call', 'contract_call'].includes(instruction.op)) continue;
            slots = Math.max(slots, this.argumentLocations(instruction.arguments).filter(location => location.kind === 'stack').length);
        }
        return this.align(slots * 8, 16);
    }

    requireField(symbol) {
        const field = this.fieldOffsets.get(symbol);
        if (!field) throw new Error(`aarch64-linux bootstrap backend has no layout for field '${symbol}'`);
        return field;
    }

    sizeOf(type) {
        if (type === 'u8' || type === 'i8' || type === 'bool') return 1;
        if (type === 'u16' || type === 'i16') return 2;
        if (type === 'u32' || type === 'i32' || type === 'f32') return 4;
        return 8;
    }

    loadMnemonic(type) { return {1: 'ldrb', 2: 'ldrh', 4: 'ldr', 8: 'ldr'}[this.sizeOf(type)]; }
    storeMnemonic(type) { return {1: 'strb', 2: 'strh', 4: 'str', 8: 'str'}[this.sizeOf(type)]; }
    valueRegister(register, type) { return this.sizeOf(type) < 8 ? `w${register.slice(1)}` : register; }

    address(register, symbol) { return [`    adrp ${register}, ${symbol}`, `    add ${register}, ${register}, :lo12:${symbol}`]; }

    typeData(types) {
        const lines = ['.section .data', '.align 8'];
        for (const type of types) {
            lines.push(`${this.typeLabel(type.name)}:`, type.base ? `    .quad ${this.typeLabel(type.base)}` : '    .quad 0',
                `    .quad ${this.contractListLabel(type.name)}`, '    .quad 0', '    .quad 0', '    .quad 0');
            for (const method of type.virtualMethods ?? []) lines.push(`    .quad ${this.requireFunction(method.target)}`);
        }
        for (const type of types) {
            lines.push(`${this.contractListLabel(type.name)}:`, `    .quad ${(type.contracts ?? []).length}`);
            for (const contract of type.contracts ?? []) lines.push(
                `    .quad ${this.typeLabel(contract.name)}`, `    .quad ${this.contractTableLabel(type.name, contract.name)}`);
            for (const contract of type.contracts ?? []) {
                lines.push(`${this.contractTableLabel(type.name, contract.name)}:`);
                for (const method of contract.methods) lines.push(`    .quad ${this.requireFunction(method.target)}`);
            }
        }
        lines.push('.text');
        return lines;
    }

    internString(value) {
        if (this.stringLiterals.has(value)) return this.stringLiterals.get(value);
        const index = this.stringLiterals.size;
        const literal = {descriptor: `.Lvalen_string_${index}`, data: `.Lvalen_string_${index}_data`,
            bytes: [...new TextEncoder().encode(value)]};
        this.stringLiterals.set(value, literal);
        return literal;
    }

    stringData() {
        if (this.stringLiterals.size === 0) return [];
        const lines = ['.section .data'];
        for (const literal of this.stringLiterals.values()) lines.push('.align 8', `${literal.descriptor}:`,
            `    .quad ${literal.data}`, `    .quad ${literal.bytes.length}`, '    .quad 0', `${literal.data}:`,
            `    .byte ${literal.bytes.length ? literal.bytes.join(', ') : 0}`);
        lines.push('.text');
        return lines;
    }

    typeLabel(typeName) { return `.Lvalen_type_${this.mangle(typeName)}`; }
    contractListLabel(typeName) { return `${this.typeLabel(typeName)}_contracts`; }
    contractTableLabel(typeName, contractName) { return `${this.typeLabel(typeName)}_as_${this.mangle(contractName)}`; }

    requireFunction(target) {
        const symbol = this.symbols.get(target);
        if (!symbol) throw new Error(`aarch64-linux bootstrap backend has no function symbol for '${target}'`);
        return symbol;
    }

    normalize(register, type) {
        if (!type || this.isFloat(type)) return [];
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        if (base === 'bool') return [`    cmp ${register}, #0`, `    cset ${register}, ne`];
        if (!/^[iu](8|16|32|64)$/.test(base)) return [];
        const bits = Number(base.slice(1));
        if (bits === 64) return [];
        const shift = 64 - bits;
        return [`    lsl ${register}, ${register}, #${shift}`,
            `    ${base.startsWith('u') ? 'lsr' : 'asr'} ${register}, ${register}, #${shift}`];
    }

    temp(name) { return `[sp, #${this.slots.get(`temp:${name}`)}]`; }
    named(name) { return `[sp, #${this.slots.get(`name:${name}`)}]`; }
    blockLabel(label) { return `${this.symbols.get(this.fn.name)}__${this.mangle(label)}`; }
    align(value, alignment) { return Math.ceil(value / alignment) * alignment; }
    isUnsigned(type) { return type === 'bool' || type?.startsWith('u'); }
    isFloat(type) { return type === 'f32' || type === 'f64'; }
    isManagedReferenceType(type) {
        if (!type) return false;
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        return base === 'string' || base === 'StringBuilder' || base.startsWith('Array<') || this.typeSizes.has(base) ||
            (type.endsWith('?') && ['bool', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64'].includes(base));
    }

    mangle(value) {
        let result = '__valen_';
        for (const byte of Buffer.from(value)) {
            const character = String.fromCharCode(byte);
            result += /[A-Za-z0-9]/.test(character) ? character : `_${byte.toString(16).padStart(2, '0')}_`;
        }
        return result;
    }
}
