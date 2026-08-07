import {prepareIr} from './ir-validation.js';

const argumentRegisters = Array.from({length: 8}, (_, index) => `x${index}`);
const floatArgumentRegisters = Array.from({length: 8}, (_, index) => index);

/** Initial AArch64 backend for primitive programs. */
export class AArch64Backend {
    generate(program, {optimizationLevel = 1, moduleId = null, includeRuntime = true} = {}) {
        if (![0, 1].includes(optimizationLevel)) throw new Error(`Unsupported optimization level '-O${optimizationLevel}'`);
        prepareIr(program, {optimize: optimizationLevel === 1, requireEntry: includeRuntime});
        const supportedRuntimeSymbols = new Set(['valen_System_collectGarbage', 'valen_System_print',
            'valen_System_write', 'valen_System_writeError', 'valen_System_exit', 'valen_System_openRead',
            'valen_System_openWrite', 'valen_System_read', 'valen_System_writeFile', 'valen_System_close',
            'valen_System_lastError', 'valen_System_arguments', 'valen_System_currentDirectory',
            'valen_System_environmentVariable', 'valen_System_enableProcessArena', 'valen_System_writeBytes',
            'valen_System_sync', 'valen_System_replaceFile', 'valen_System_removeFile', 'valen_System_makeExecutable',
            'valen_System_link', 'valen_System_memoryCopy', 'valen_System_memoryCompare',
            'valen_System_fileDescriptor', 'valen_System_makeFileNonblocking',
            'valen_Network_listen', 'valen_Network_accept', 'valen_Network_receive', 'valen_Network_send',
            'valen_Network_sendSome', 'valen_Network_closeListener', 'valen_Network_closeConnection',
            'valen_Network_lastError', 'valen_Network_listenerDescriptor', 'valen_Network_connectionDescriptor',
            'valen_Network_makeListenerNonblocking', 'valen_Network_makeConnectionNonblocking',
            'valen_EventLoop_available', 'valen_EventLoop_wait', 'valen_EventLoop_monotonicMilliseconds',
            'valen_Operations_threadAvailable', 'valen_Operations_threadStart', 'valen_Operations_threadJoin',
            'valen_Operations_mutexLock', 'valen_Operations_mutexUnlock',
            'valen_Operations_conditionWait', 'valen_Operations_conditionNotifyOne', 'valen_Operations_conditionNotifyAll',
            'valen_Operations_atomicLoad', 'valen_Operations_atomicStore', 'valen_Operations_atomicExchange',
            'valen_Operations_atomicCompareExchange', 'valen_Operations_atomicAdd']);
        this.program = program;
        this.runtimeLabel = 0;
        this.fieldOffsets = new Map();
        this.typeSizes = new Map();
        for (const type of program.types) {
            let offset = 16, alignment = 1;
            for (const field of type.fields) {
                const size = this.sizeOf(field.type), fieldAlignment = Math.min(size, 8);
                offset = this.align(offset, fieldAlignment);
                this.fieldOffsets.set(field.symbol, {offset, type: field.type, ownership: field.ownership});
                offset += size;
                alignment = Math.max(alignment, fieldAlignment);
            }
            this.typeSizes.set(type.name, Math.max(8, this.align(offset, alignment)));
        }
        this.symbols = new Map(program.functions.map(fn => [fn.name, this.mangle(fn.name)]));
        for (const external of program.externals) {
            if (!external.foreignLibrary && supportedRuntimeSymbols.has(external.runtimeSymbol)) {
                this.symbols.set(external.name, external.runtimeSymbol);
            }
        }
        this.runtimeSymbols = new Set(program.externals.map(external => external.runtimeSymbol));
        this.threading = this.runtimeSymbols.has('valen_Operations_threadStart');
        this.emittedTypes = moduleId === null ? program.types : program.types.filter(type => type.moduleId === moduleId);
        const functions = moduleId === null ? program.functions : program.functions.filter(fn => fn.moduleId === moduleId);
        this.arrayTypes = this.structuralArrayTypes(functions);
        if (this.runtimeSymbols.has('valen_System_arguments')) this.arrayTypes.add('Array<string>');
        this.stringLiterals = new Map();
        for (const instruction of functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions))) {
            if (instruction.op === 'string_constant') this.internString(instruction.value);
            if (instruction.type?.startsWith('Array<')) this.arrayTypes.add(instruction.type);
        }
        const lines = ['.text'];
        for (const fn of functions) lines.push(...this.generateFunction(fn));
        lines.push(...this.gcTypeFunctions(this.emittedTypes), ...this.gcArrayFunctions(this.arrayTypes),
            ...this.structuralTypeRuntime());
        if (includeRuntime) lines.push(...this.generateStart(), ...this.allocationRuntime(), ...this.arrayRuntime(),
            ...this.stringRuntime(), ...this.builderRuntime(), ...this.structuralCoreRuntime(), ...this.systemRuntime());
        lines.push('.Larray_bounds_error:', '    mov x0, #70', '    mov x8, #93', '    svc #0',
            '.Ldivision_by_zero_error:', '    mov x0, #73', '    mov x8, #93', '    svc #0',
            '.Loptional_unwrap_error:', '    mov x0, #71', '    mov x8, #93', '    svc #0',
            '.Lcontract_dispatch_error:', '    mov x0, #75', '    mov x8, #93', '    svc #0',
            '.Lfloat_conversion_error:', '    mov x0, #76', '    mov x8, #93', '    svc #0', '');
        lines.push(...this.typeData(this.emittedTypes), ...this.stringData());
        if (includeRuntime) lines.push(...this.gcData());
        if (includeRuntime && program.functions.some(fn => fn.name === '$valen.test.run')) lines.push(...this.testData());
        lines.push('.section .note.GNU-stack,"",@progbits');
        return `${lines.join('\n')}\n`;
    }

    generateFunction(fn) {
        this.fn = fn;
        this.slots = new Map();
        const slotTypes = new Map();
        this.outgoingSize = this.outgoingStackSize(fn);
        let slotOffset = this.outgoingSize;
        const reserve = (key, type = null) => {
            if (!this.slots.has(key)) {
                this.slots.set(key, slotOffset);
                slotOffset += 8;
            }
            if (type) slotTypes.set(key, type);
        };
        for (const parameter of fn.parameters) reserve(`name:${parameter.name}`, parameter.type);
        for (const instruction of fn.blocks.flatMap(block => block.instructions)) {
            if (instruction.result) reserve(`temp:${instruction.result}`, instruction.type);
            if (instruction.op === 'declare_local' || instruction.op === 'store_local') {
                reserve(`name:${instruction.name}`, instruction.type ?? instruction.value?.type);
            }
        }
        const rootOffset = this.align(slotOffset, 16);
        const frameSize = this.align(rootOffset + 24, 16);
        if (frameSize > 4064) throw new Error(`aarch64-linux bootstrap backend function '${fn.displayName}' needs an unsupported large stack frame`);
        const total = frameSize + 16;
        const symbol = this.symbols.get(fn.name);
        const end = `${symbol}__return`;
        const rootTrace = `${symbol}__gc_roots`;
        const roots = [...slotTypes].filter(([, type]) => this.isManagedReferenceType(type));
        const lines = [`.globl ${symbol}`, `.type ${symbol}, %function`, `${symbol}:`, `    sub sp, sp, #${total}`,
            `    str x29, [sp, #${frameSize}]`, `    str x30, [sp, #${frameSize + 8}]`, `    add x29, sp, #${frameSize}`];
        for (let offset = this.outgoingSize; offset < slotOffset; offset += 8) lines.push(`    str xzr, [sp, #${offset}]`);
        for (const location of this.argumentLocations(fn.parameters)) {
            if (location.kind === 'stack') lines.push(`    ldr x9, [x29, #${16 + location.stackIndex * 8}]`,
                `    str x9, ${this.named(location.value.name)}`);
            else if (location.kind === 'float') lines.push(
                `    fmov ${location.value.type === 'f32' ? 'w9' : 'x9'}, ${location.value.type === 'f32' ? 's' : 'd'}${location.register}`,
                `    str x9, ${this.named(location.value.name)}`);
            else lines.push(`    str ${location.register}, ${this.named(location.value.name)}`);
        }
        lines.push(...this.address('x10', rootTrace),
            `    str x10, [sp, #${rootOffset + 8}]`, '    add x10, sp, #0',
            `    str x10, [sp, #${rootOffset + 16}]`);
        if (this.threading) lines.push(...this.address('x9', 'valen_gc_workers'), '    ldr x10, [x9, #0]',
            `    cbnz x10, ${symbol}__gc_push_slow`, ...this.address('x9', 'valen_gc_roots'), '    ldr x10, [x9, #0]',
            `    str x10, [sp, #${rootOffset}]`, `    add x10, sp, #${rootOffset}`, '    str x10, [x9, #0]',
            `    b ${symbol}__gc_push_done`, `${symbol}__gc_push_slow:`, `    add x0, sp, #${rootOffset}`,
            '    bl valen_gc_root_push', `${symbol}__gc_push_done:`, '    bl valen_gc_safepoint');
        else lines.push(...this.address('x9', 'valen_gc_roots'), '    ldr x10, [x9, #0]',
            `    str x10, [sp, #${rootOffset}]`, `    add x10, sp, #${rootOffset}`, '    str x10, [x9, #0]');
        const blockOrder = new Map(fn.blocks.map((block, index) => [block.label, index]));
        for (let blockIndex = 0; blockIndex < fn.blocks.length; blockIndex++) {
            const block = fn.blocks[blockIndex];
            if (block.label !== 'entry') lines.push(`${this.blockLabel(block.label)}:`);
            for (const instruction of block.instructions) {
                if (this.threading && (instruction.op === 'jump' && blockOrder.get(instruction.target) <= blockIndex ||
                    instruction.op === 'branch' && (blockOrder.get(instruction.thenTarget) <= blockIndex ||
                        blockOrder.get(instruction.elseTarget) <= blockIndex))) lines.push('    bl valen_gc_safepoint');
                lines.push(...this.instruction(instruction, end));
            }
        }
        lines.push(`${end}:`);
        if (this.threading) lines.push(...this.address('x9', 'valen_gc_workers'), '    ldr x10, [x9, #0]',
            `    cbnz x10, ${symbol}__gc_pop_slow`, ...this.address('x9', 'valen_gc_roots'),
            `    ldr x10, [sp, #${rootOffset}]`, '    str x10, [x9, #0]', `    b ${symbol}__gc_pop_done`,
            `${symbol}__gc_pop_slow:`, `    str x0, [sp, #${rootOffset + 24}]`, `    add x0, sp, #${rootOffset}`,
            '    bl valen_gc_root_pop', `    ldr x0, [sp, #${rootOffset + 24}]`, `${symbol}__gc_pop_done:`);
        else lines.push(...this.address('x9', 'valen_gc_roots'), `    ldr x10, [sp, #${rootOffset}]`, '    str x10, [x9, #0]');
        lines.push(`    ldr x29, [sp, #${frameSize}]`, `    ldr x30, [sp, #${frameSize + 8}]`,
            `    add sp, sp, #${total}`, '    ret', `.size ${symbol}, .-${symbol}`, '',
            `.type ${rootTrace}, %function`, `${rootTrace}:`, '    sub sp, sp, #32', '    str x30, [sp, #24]',
            '    str x0, [sp, #16]');
        for (const [key] of roots) lines.push('    ldr x9, [sp, #16]', `    ldr x0, [x9, #${this.slots.get(key)}]`,
            '    bl valen_gc_mark');
        lines.push('    ldr x30, [sp, #24]', '    add sp, sp, #32', '    ret',
            `.size ${rootTrace}, .-${rootTrace}`, '');
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
                const lines = [...this.load(instruction.object, 'x9'),
                    `    ${this.loadMnemonic(field.type)} ${this.valueRegister('x9', field.type)}, [x9, #${field.offset}]`];
                if (field.ownership === 'member-weak') lines.push(...this.weakLoad('x9', 'field'));
                lines.push(...this.normalize('x9', field.type), `    str x9, ${this.temp(instruction.result)}`);
                return lines;
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
                return [...this.constant('x0', this.typeSizes.get(instruction.objectType) ?? 16),
                    ...this.address('x1', this.gcTypeTraceLabel(instruction.objectType)),
                    ...this.gcTypeWeakAddress('x2', instruction.objectType), ...this.constant('x3', 0),
                    '    bl valen_gc_alloc',
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
                    ...this.gcArrayAddress('x2', instruction.type, false), ...this.gcArrayAddress('x3', instruction.type, true),
                    '    bl valen_array_new', `    str x0, ${this.temp(instruction.result)}`];
            case 'array_length':
                return [...this.load(instruction.array, 'x9'), '    ldr x9, [x9, #0]',
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'array_capacity':
                return [...this.load(instruction.array, 'x9'), '    ldr x9, [x9, #8]',
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'array_load': {
                const lines = [...this.load(instruction.array, 'x0'), ...this.load(instruction.index, 'x1'),
                    ...this.constant('x2', this.sizeOf(instruction.elementType)), '    bl valen_array_address',
                    `    ${this.loadMnemonic(instruction.elementType)} ${this.valueRegister('x9', instruction.elementType)}, [x0, #0]`];
                if (instruction.elementOwnership === 'weak') lines.push(...this.weakLoad('x9', 'array'));
                lines.push(...this.normalize('x9', instruction.elementType), `    str x9, ${this.temp(instruction.result)}`);
                return lines;
            }
            case 'array_store': {
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
                if (instruction.elementOwnership === 'owned' && this.isManagedReferenceType(instruction.elementType)) {
                    return [...this.load(instruction.array, 'x0'), ...this.load(instruction.start, 'x1'),
                        ...this.load(instruction.length, 'x2'), ...this.address('x3', this.arraySliceLabel(instruction.type)),
                        '    bl valen_slice_with_context', `    str x0, ${this.temp(instruction.result)}`];
                }
                return [...this.load(instruction.array, 'x0'), ...this.load(instruction.start, 'x1'),
                    ...this.load(instruction.length, 'x2'), ...this.constant('x3', this.sizeOf(instruction.elementType)),
                    ...this.gcArrayAddress('x4', instruction.type, false), ...this.gcArrayAddress('x5', instruction.type, true),
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
            case 'structural_equal': {
                const lines = [...this.load(instruction.left, 'x0'), ...this.load(instruction.right, 'x1'),
                    ...this.constant('x2', 0), `    bl ${this.equalityFunction(instruction.valueType)}`];
                if (instruction.negate) lines.push('    mov x9, #1', '    eor x0, x0, x9');
                lines.push(`    str x0, ${this.temp(instruction.result)}`);
                return lines;
            }
            case 'structural_hash':
                return [...this.load(instruction.value, 'x0'), ...this.constant('x1', 0),
                    `    bl ${this.hashFunction(instruction.valueType)}`, `    str x0, ${this.temp(instruction.result)}`];
            case 'structural_copy':
                return [...this.load(instruction.value, 'x0'), ...this.address('x1', this.copyFunction(instruction.valueType)),
                    '    bl valen_copy_with_context', `    str x0, ${this.temp(instruction.result)}`];
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
            case 'integer_to_string':
                return [...this.load(instruction.value, 'x0'), ...this.constant('x1', this.isUnsigned(instruction.integerType) ? 0 : 1),
                    '    bl valen_integer_to_string', `    str x0, ${this.temp(instruction.result)}`];
            case 'builder_new':
                return [...this.constant('x0', 1), ...this.constant('x1', 0), ...this.constant('x2', 0),
                    ...this.constant('x3', 0), '    bl valen_array_new',
                    `    str x0, ${this.temp(instruction.result)}`];
            case 'builder_length':
                return [...this.load(instruction.builder, 'x9'), '    ldr x9, [x9, #0]',
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'builder_append_string':
                return [...this.load(instruction.builder, 'x0'), ...this.load(instruction.value, 'x1'),
                    '    bl valen_builder_append_string'];
            case 'builder_append_bytes':
                return [...this.load(instruction.builder, 'x0'), ...this.load(instruction.value, 'x1'),
                    '    bl valen_builder_append_bytes'];
            case 'builder_append_byte':
                return [...this.load(instruction.builder, 'x0'), ...this.load(instruction.value, 'x1'),
                    ...this.constant('x2', 1), '    bl valen_array_append'];
            case 'builder_build':
                return [...this.load(instruction.builder, 'x0'), '    bl valen_builder_build',
                    `    str x0, ${this.temp(instruction.result)}`];
            case 'test_expect': {
                const done = `.Ltest_expect_done_${this.runtimeLabel++}`;
                return [...this.load(instruction.condition, 'x9'), `    cbnz x9, ${done}`,
                    ...this.address('x10', 'valen_test_failures'), '    ldr x11, [x10, #0]',
                    '    add x11, x11, #1', '    str x11, [x10, #0]', '    mov x0, #2',
                    ...this.address('x1', 'valen_test_failure_message'), '    mov x2, #12', '    mov x8, #64',
                    '    svc #0', `${done}:`];
            }
            case 'test_failures':
                return [...this.address('x9', 'valen_test_failures'), '    ldr x9, [x9, #0]',
                    `    str x9, ${this.temp(instruction.result)}`];
            case 'call':
                return this.call(instruction, false);
            case 'virtual_call':
                return this.call(instruction, true);
            case 'contract_call':
                return this.contractCall(instruction);
            case 'type_test':
            case 'checked_cast':
                return this.typeRelationship(instruction);
            case 'optional_box':
                return [...this.constant('x0', 24), ...this.constant('x1', 0), ...this.constant('x2', 0),
                    ...this.constant('x3', 0), '    bl valen_gc_alloc', '    str xzr, [x0, #0]',
                    ...this.constant('x9', 1), '    str x9, [x0, #8]', `    str x0, ${this.temp(instruction.result)}`,
                    ...this.load(instruction.value, 'x9'), `    ldr x10, ${this.temp(instruction.result)}`,
                    '    str x9, [x10, #16]'];
            case 'unwrap':
                return [...this.load(instruction.value, 'x9'), '    cbz x9, .Loptional_unwrap_error',
                    ...(instruction.optionalType && this.isPrimitiveOptional(instruction.optionalType)
                        ? ['    ldr x9, [x9, #16]', ...this.normalize('x9', instruction.type)] : []),
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
        const lines = ['.globl _start', '.type _start, %function', '_start:', '    add x9, sp, #0',
            '    ldr x10, [x9, #0]', ...this.address('x11', 'valen_process_argc'), '    str x10, [x11, #0]',
            '    add x12, x9, #8', ...this.address('x11', 'valen_process_argv'), '    str x12, [x11, #0]',
            '    add x13, x10, #1', '    lsl x13, x13, #3', '    add x13, x12, x13',
            ...this.address('x11', 'valen_process_envp'), '    str x13, [x11, #0]', '    sub sp, sp, #16',
            ...(this.threading ? ['    bl valen_gc_mutator_register'] : []),
            ...this.constant('x0', this.typeSizes.get(entry.owner) ?? 16),
            ...this.address('x1', this.gcTypeTraceLabel(entry.owner)), ...this.gcTypeWeakAddress('x2', entry.owner),
            ...this.constant('x3', 0), '    bl valen_gc_alloc',
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
            '', '.globl valen_gc_alloc', '.type valen_gc_alloc, %function', 'valen_gc_alloc:',
            '    sub sp, sp, #64', '    str x30, [sp, #56]', '    str x0, [sp, #0]', '    str x1, [sp, #8]',
            '    str x2, [sp, #16]', '    str x3, [sp, #24]', '    bl valen_gc_maybe_collect',
            '    ldr x0, [sp, #0]', '    add x0, x0, #48', '    ldr x9, [sp, #0]',
            '    cmp x0, x9', '    b.cc .Lallocation_error', '    str x0, [sp, #32]', '    bl valen_alloc',
            '    str x0, [sp, #40]', ...(this.threading ? ['    bl valen_gc_heap_lock', '    ldr x0, [sp, #40]'] : []),
            ...this.address('x9', 'valen_gc_heap'), '    ldr x10, [x9, #0]',
            '    str x10, [x0, #0]', '    ldr x10, [sp, #32]', '    str x10, [x0, #8]',
            '    ldr x10, [sp, #8]', '    str x10, [x0, #16]', '    ldr x10, [sp, #16]', '    str x10, [x0, #24]',
            '    str xzr, [x0, #32]', '    ldr x10, [sp, #24]', '    str x10, [x0, #40]',
            '    str x0, [x9, #0]', ...this.address('x9', 'valen_gc_bytes'), '    ldr x10, [x9, #0]',
            '    ldr x11, [sp, #32]', '    add x10, x10, x11', '    str x10, [x9, #0]',
            ...(this.threading ? [...this.address('x9', 'valen_gc_lock'), '    mov x10, #0', '    stlr w10, [x9]'] : []),
            '    add x0, x0, #48', '    ldr x30, [sp, #56]', '    add sp, sp, #64',
            '    ret', '.size valen_gc_alloc, .-valen_gc_alloc', '', '.globl valen_gc_maybe_collect',
            '.type valen_gc_maybe_collect, %function', 'valen_gc_maybe_collect:',
            ...(this.threading ? ['    sub sp, sp, #16', '    str x30, [sp, #8]', '    bl valen_gc_safepoint',
                '    ldr x30, [sp, #8]', '    add sp, sp, #16'] : []),
            ...this.address('x9', 'valen_gc_bytes'), '    ldr x10, [x9, #0]',
            ...this.address('x9', 'valen_gc_threshold'), '    ldr x9, [x9, #0]', '    cmp x10, x9',
            '    b.cc .Lgc_maybe_collect_done', '    b valen_gc_collect', '.Lgc_maybe_collect_done:', '    ret',
            '.size valen_gc_maybe_collect, .-valen_gc_maybe_collect', '',
            ...(this.threading ? this.gcCoordinationRuntime() : []),
            '.globl valen_gc_mark',
            '.type valen_gc_mark, %function', 'valen_gc_mark:', '    cbz x0, .Lgc_mark_return',
            '    sub sp, sp, #32', '    str x30, [sp, #24]', '    str x0, [sp, #0]',
            ...this.address('x9', 'valen_gc_heap'), '    ldr x9, [x9, #0]', '.Lgc_mark_find:',
            '    cbz x9, .Lgc_mark_done', '    add x10, x9, #48', '    ldr x11, [sp, #0]', '    cmp x10, x11',
            '    b.eq .Lgc_mark_found', '    ldr x9, [x9, #0]', '    b .Lgc_mark_find', '.Lgc_mark_found:',
            '    ldr x10, [x9, #40]', ...this.address('x11', 'valen_string_finalize'),
            '    cmp x10, x11', '    b.eq .Lgc_mark_live', ...this.address('x11', 'valen_gc_array_finalize'),
            '    cmp x10, x11', '    b.ne .Lgc_mark_object_live', '    ldr x10, [x9, #80]',
            '    cbz x10, .Lgc_mark_done', '    b .Lgc_mark_live', '.Lgc_mark_object_live:',
            '    ldr x10, [x9, #56]', '    cbz x10, .Lgc_mark_done', '.Lgc_mark_live:',
            '    ldr x10, [x9, #32]', '    cbnz x10, .Lgc_mark_done', '    mov x10, #1', '    str x10, [x9, #32]',
            '    ldr x10, [x9, #16]', '    cbz x10, .Lgc_mark_done', '    ldr x0, [sp, #0]', '    blr x10',
            '.Lgc_mark_done:', '    ldr x30, [sp, #24]', '    add sp, sp, #32', '.Lgc_mark_return:', '    ret',
            '.size valen_gc_mark, .-valen_gc_mark', '', '.globl valen_gc_is_marked',
            '.type valen_gc_is_marked, %function', 'valen_gc_is_marked:', '    cbz x0, .Lgc_is_marked_no',
            ...this.address('x9', 'valen_gc_heap'), '    ldr x9, [x9, #0]', '.Lgc_is_marked_find:',
            '    cbz x9, .Lgc_is_marked_static', '    add x10, x9, #48', '    cmp x10, x0',
            '    b.eq .Lgc_is_marked_found', '    ldr x9, [x9, #0]', '    b .Lgc_is_marked_find',
            '.Lgc_is_marked_found:', '    ldr x10, [x9, #40]', ...this.address('x11', 'valen_string_finalize'),
            '    cmp x10, x11', '    b.eq .Lgc_is_marked_value', ...this.address('x11', 'valen_gc_array_finalize'),
            '    cmp x10, x11', '    b.ne .Lgc_is_marked_object', '    ldr x10, [x9, #80]',
            '    cbz x10, .Lgc_is_marked_no', '    b .Lgc_is_marked_value', '.Lgc_is_marked_object:',
            '    ldr x10, [x9, #56]', '    cbz x10, .Lgc_is_marked_no', '.Lgc_is_marked_value:',
            '    ldr x0, [x9, #32]', '    ret', '.Lgc_is_marked_static:',
            '    mov x0, #1', '    ret', '.Lgc_is_marked_no:', '    mov x0, #0', '    ret',
            '.size valen_gc_is_marked, .-valen_gc_is_marked', '', '.globl valen_gc_collect',
            '.type valen_gc_collect, %function', 'valen_gc_collect:',
            ...(this.threading ? ['    sub sp, sp, #16', '    str x30, [sp, #8]', ...this.address('x9', 'valen_gc_workers'),
                '    ldr x10, [x9, #0]', '    cbz x10, .Lgc_collect_coordination_done',
                ...this.address('x9', 'valen_gc_collecting'), '.Lgc_collect_claim:', '    ldaxr w10, [x9]',
                '    cbnz w10, .Lgc_collect_already_running', '    mov x11, #1', '    stlxr w12, w11, [x9]',
                '    cbnz w12, .Lgc_collect_claim', '    bl valen_gc_state_lock', ...this.address('x9', 'valen_gc_request'),
                '    mov x10, #1', '    stlr w10, [x9]', ...this.address('x9', 'valen_gc_mutators'),
                '    ldr x10, [x9, #0]', '    cbz x10, .Lgc_collect_target_zero', '    sub x10, x10, #1',
                '.Lgc_collect_target_zero:', ...this.address('x9', 'valen_gc_target'), '    str x10, [x9, #0]',
                '    bl valen_gc_state_unlock', '.Lgc_collect_wait:', ...this.address('x9', 'valen_gc_parked'),
                '    ldar w10, [x9]', ...this.address('x11', 'valen_gc_target'), '    ldr w11, [x11, #0]',
                '    cmp x10, x11', '    b.cs .Lgc_collect_coordination_done', '    mov x0, x9', '    mov x1, #128',
                '    mov x2, x10', '    mov x3, #0', '    mov x4, #0', '    mov x5, #0', '    mov x8, #98',
                '    svc #0', '    b .Lgc_collect_wait', '.Lgc_collect_already_running:', '    clrex',
                '    ldr x30, [sp, #8]', '    add sp, sp, #16', '    b valen_gc_safepoint',
                '.Lgc_collect_coordination_done:', '    ldr x30, [sp, #8]', '    add sp, sp, #16'] : []),
            '    sub sp, sp, #64',
            '    str x30, [sp, #56]', ...this.address('x9', 'valen_gc_roots'), '    ldr x9, [x9, #0]',
            '    str x9, [sp, #0]', '.Lgc_collect_roots:', '    ldr x9, [sp, #0]',
            '    cbz x9, .Lgc_collect_weak_start', '    ldr x10, [x9, #8]', '    ldr x0, [x9, #16]',
            '    blr x10', '    ldr x9, [sp, #0]', '    ldr x9, [x9, #0]', '    str x9, [sp, #0]',
            '    b .Lgc_collect_roots', '.Lgc_collect_weak_start:', ...this.address('x9', 'valen_gc_heap'),
            '    ldr x9, [x9, #0]', '    str x9, [sp, #0]', '.Lgc_collect_weak:', '    ldr x9, [sp, #0]',
            '    cbz x9, .Lgc_collect_sweep_start', '    ldr x10, [x9, #32]',
            '    cbz x10, .Lgc_collect_weak_next', '    ldr x10, [x9, #24]',
            '    cbz x10, .Lgc_collect_weak_next', '    add x0, x9, #48', '    blr x10',
            '.Lgc_collect_weak_next:', '    ldr x9, [sp, #0]', '    ldr x9, [x9, #0]', '    str x9, [sp, #0]',
            '    b .Lgc_collect_weak', '.Lgc_collect_sweep_start:', ...this.address('x9', 'valen_gc_heap'),
            '    str x9, [sp, #8]', ...this.address('x9', 'valen_gc_bytes'), '    str xzr, [x9, #0]',
            '.Lgc_collect_sweep:', '    ldr x9, [sp, #8]', '    ldr x10, [x9, #0]',
            '    cbz x10, .Lgc_collect_done', '    str x10, [sp, #16]', '    ldr x11, [x10, #32]',
            '    cbz x11, .Lgc_collect_reclaim', '    str xzr, [x10, #32]',
            ...this.address('x11', 'valen_gc_bytes'), '    ldr x12, [x11, #0]', '    ldr x13, [x10, #8]',
            '    add x12, x12, x13', '    str x12, [x11, #0]', '    str x10, [sp, #8]',
            '    b .Lgc_collect_sweep', '.Lgc_collect_reclaim:', '    ldr x11, [x10, #0]',
            '    str x11, [sp, #24]', '    str x11, [x9, #0]', '    ldr x11, [x10, #40]',
            '    cbz x11, .Lgc_collect_unmap', '    add x0, x10, #48', '    blr x11',
            '.Lgc_collect_unmap:', '    ldr x0, [sp, #16]', '    ldr x1, [x0, #8]', '    mov x8, #215',
            '    svc #0', '    b .Lgc_collect_sweep', '.Lgc_collect_done:',
            ...this.address('x9', 'valen_gc_bytes'), '    ldr x10, [x9, #0]', '    lsl x10, x10, #1',
            ...this.constant('x11', 1048576), '    cmp x10, x11', '    b.cs .Lgc_collect_threshold_ready',
            '    mov x10, x11', '.Lgc_collect_threshold_ready:', ...this.address('x9', 'valen_gc_threshold'),
            '    str x10, [x9, #0]', ...(this.threading ? ['    bl valen_gc_collection_release'] : []), '    ldr x30, [sp, #56]',
            '    add sp, sp, #64', '    ret', '.size valen_gc_collect, .-valen_gc_collect', '',
            '.globl valen_gc_native_handle_finalize', 'valen_gc_native_handle_finalize:',
            '    ldr x9, [x0, #16]', '    cmp x9, #0', '    b.lt .Lgc_native_handle_done', '    mov x10, x0',
            '    mov x0, x9', '    mov x8, #57', '    svc #0', '    mov x9, #-1', '    str x9, [x10, #16]',
            '    str xzr, [x10, #8]', '.Lgc_native_handle_done:', '    ret',
            '.size valen_gc_native_handle_finalize, .-valen_gc_native_handle_finalize',
            '.Lallocation_error:', '    mov x0, #72', '    mov x8, #93', '    svc #0', ''];
    }

    gcCoordinationRuntime() {
        return ['valen_gc_heap_lock:', ...this.address('x9', 'valen_gc_lock'), '.Lgc_heap_lock_retry:',
            '    ldaxr w10, [x9]', '    cbnz w10, .Lgc_heap_lock_retry', '    mov x11, #1',
            '    stlxr w12, w11, [x9]', '    cbnz w12, .Lgc_heap_lock_retry', '    ret', '',
            'valen_gc_state_lock:', ...this.address('x9', 'valen_gc_state_guard'), '.Lgc_state_lock_retry:',
            '    ldaxr w10, [x9]', '    cbnz w10, .Lgc_state_lock_retry', '    mov x11, #1',
            '    stlxr w12, w11, [x9]', '    cbnz w12, .Lgc_state_lock_retry', '    ret', '',
            'valen_gc_state_unlock:', ...this.address('x9', 'valen_gc_state_guard'), '    mov x10, #0',
            '    stlr w10, [x9]', '    ret', '',
            'valen_gc_mutator_register:', 'valen_gc_mutator_enter:', '    sub sp, sp, #16', '    str x30, [sp, #8]',
            '    bl valen_gc_state_lock', ...this.address('x9', 'valen_gc_mutators'), '    ldr x10, [x9, #0]',
            '    add x10, x10, #1', '    str x10, [x9, #0]', '    bl valen_gc_state_unlock',
            '    ldr x30, [sp, #8]', '    add sp, sp, #16', '    b valen_gc_safepoint', '',
            'valen_gc_mutator_unregister:', 'valen_gc_mutator_leave:', '    sub sp, sp, #16', '    str x30, [sp, #8]',
            '.Lgc_mutator_leave_retry:', '    bl valen_gc_state_lock', ...this.address('x9', 'valen_gc_request'),
            '    ldar w10, [x9]', '    cbnz w10, .Lgc_mutator_leave_park', ...this.address('x9', 'valen_gc_mutators'),
            '    ldr x10, [x9, #0]', '    sub x10, x10, #1', '    str x10, [x9, #0]',
            '    bl valen_gc_state_unlock', '    ldr x30, [sp, #8]', '    add sp, sp, #16', '    ret',
            '.Lgc_mutator_leave_park:', '    bl valen_gc_state_unlock', '    bl valen_gc_safepoint',
            '    b .Lgc_mutator_leave_retry', '',
            '.globl valen_gc_safepoint', 'valen_gc_safepoint:', ...this.address('x9', 'valen_gc_workers'),
            '    ldr x10, [x9, #0]', '    cbz x10, .Lgc_safepoint_done', ...this.address('x9', 'valen_gc_request'),
            '    ldar w10, [x9]', '    cbz w10, .Lgc_safepoint_done', ...this.address('x11', 'valen_gc_parked'),
            '.Lgc_safepoint_park:', '    ldaxr w12, [x11]', '    add x13, x12, #1', '    stlxr w14, w13, [x11]',
            '    cbnz w14, .Lgc_safepoint_park', '    mov x0, x11', '    mov x1, #129', '    mov x2, #1',
            '    mov x3, #0', '    mov x4, #0', '    mov x5, #0', '    mov x8, #98', '    svc #0',
            '.Lgc_safepoint_wait:', ...this.address('x9', 'valen_gc_request'), '    ldar w10, [x9]',
            '    cbz w10, .Lgc_safepoint_release', '    mov x0, x9', '    mov x1, #128', '    mov x2, #1',
            '    mov x3, #0', '    mov x4, #0', '    mov x5, #0', '    mov x8, #98', '    svc #0',
            '    b .Lgc_safepoint_wait', '.Lgc_safepoint_release:', ...this.address('x11', 'valen_gc_parked'),
            '.Lgc_safepoint_unpark:', '    ldaxr w12, [x11]', '    sub x13, x12, #1', '    stlxr w14, w13, [x11]',
            '    cbnz w14, .Lgc_safepoint_unpark', '    mov x0, x11', '    mov x1, #129', '    mov x2, #1',
            '    mov x3, #0', '    mov x4, #0', '    mov x5, #0', '    mov x8, #98', '    svc #0',
            '.Lgc_safepoint_done:', '    ret', '',
            'valen_gc_root_push:', '    sub sp, sp, #32', '    str x19, [sp, #0]', '    str x30, [sp, #24]',
            '    mov x19, x0', '    bl valen_gc_heap_lock', ...this.address('x9', 'valen_gc_roots'),
            '    ldr x10, [x9, #0]', '    str x10, [x19, #0]', '    str x19, [x9, #0]',
            ...this.address('x9', 'valen_gc_lock'), '    mov x10, #0', '    stlr w10, [x9]',
            '    ldr x19, [sp, #0]', '    ldr x30, [sp, #24]', '    add sp, sp, #32', '    ret', '',
            'valen_gc_root_pop:', '    sub sp, sp, #32', '    str x19, [sp, #0]', '    str x30, [sp, #24]',
            '    mov x19, x0', '    bl valen_gc_heap_lock', ...this.address('x9', 'valen_gc_roots'),
            '.Lgc_root_pop_find:', '    ldr x10, [x9, #0]', '    cbz x10, .Lgc_root_pop_done',
            '    cmp x10, x19', '    b.eq .Lgc_root_pop_remove', '    mov x9, x10', '    b .Lgc_root_pop_find',
            '.Lgc_root_pop_remove:', '    ldr x10, [x19, #0]', '    str x10, [x9, #0]',
            '.Lgc_root_pop_done:', ...this.address('x9', 'valen_gc_lock'), '    mov x10, #0', '    stlr w10, [x9]',
            '    ldr x19, [sp, #0]', '    ldr x30, [sp, #24]', '    add sp, sp, #32', '    ret', '',
            'valen_gc_collection_release:', ...this.address('x9', 'valen_gc_collecting'), '    ldar w10, [x9]',
            '    cbz w10, .Lgc_collection_release_done', ...this.address('x9', 'valen_gc_request'),
            '    mov x10, #0', '    stlr w10, [x9]', '    mov x0, x9', '    mov x1, #129',
            ...this.constant('x2', 2147483647), '    mov x3, #0', '    mov x4, #0', '    mov x5, #0',
            '    mov x8, #98', '    svc #0', '.Lgc_collection_release_wait:', ...this.address('x9', 'valen_gc_parked'),
            '    ldar w10, [x9]', '    cbz w10, .Lgc_collection_release_clear', '    mov x0, x9', '    mov x1, #128',
            '    mov x2, x10', '    mov x3, #0', '    mov x4, #0', '    mov x5, #0', '    mov x8, #98',
            '    svc #0', '    b .Lgc_collection_release_wait', '.Lgc_collection_release_clear:',
            ...this.address('x9', 'valen_gc_collecting'), '    mov x10, #0', '    stlr w10, [x9]',
            '.Lgc_collection_release_done:', '    ret', ''];
    }

    arrayRuntime() {
        return ['.globl valen_array_new', '.type valen_array_new, %function', 'valen_array_new:',
            '    sub sp, sp, #64', '    str x30, [sp, #56]', '    cmp x1, #0', '    b.lt .Larray_bounds_error',
            '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    str x2, [sp, #16]', '    str x3, [sp, #24]',
            '    mov x4, x1', '    cmp x4, #4', '    b.ge .Larray_capacity_ready', '    mov x4, #4',
            '.Larray_capacity_ready:', '    str x4, [sp, #32]', '    mul x5, x4, x0', '    udiv x6, x5, x0',
            '    cmp x6, x4', '    b.ne .Larray_bounds_error', '    str x5, [sp, #40]', '    mov x0, #40',
            '    ldr x1, [sp, #16]', '    ldr x2, [sp, #24]', ...this.address('x3', 'valen_gc_array_finalize'),
            '    bl valen_gc_alloc',
            '    str x0, [sp, #48]', '    ldr x0, [sp, #40]', '    bl valen_alloc', '    mov x5, x0',
            '    ldr x0, [sp, #48]', '    ldr x1, [sp, #8]', '    str x1, [x0, #0]',
            '    ldr x1, [sp, #32]', '    str x1, [x0, #8]',
            '    str x5, [x0, #16]', '    ldr x1, [sp, #0]', '    str x1, [x0, #24]', '    mov x1, #1',
            '    str x1, [x0, #32]', '    ldr x30, [sp, #56]', '    add sp, sp, #64', '    ret',
            '.size valen_array_new, .-valen_array_new', '', '.type valen_gc_array_finalize, %function',
            'valen_gc_array_finalize:', '    ldr x1, [x0, #8]', '    ldr x2, [x0, #24]', '    mul x1, x1, x2',
            '    cbnz x1, .Lgc_array_finalize_size', '    mov x1, #1', '.Lgc_array_finalize_size:',
            '    ldr x0, [x0, #16]', '    mov x8, #215', '    svc #0', '    ret',
            '.size valen_gc_array_finalize, .-valen_gc_array_finalize', '', '.globl valen_array_address',
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
            '    add x6, x1, x2', '    cmp x6, x1', '    b.cc .Larray_bounds_error', '    ldr x7, [x0, #0]',
            '    cmp x6, x7', '    b.hi .Larray_bounds_error', '    sub sp, sp, #80', '    str x30, [sp, #72]',
            '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    str x2, [sp, #16]', '    str x3, [sp, #24]',
            '    str x4, [sp, #32]', '    str x5, [sp, #40]', '    mov x0, x3', '    mov x1, x2',
            '    ldr x2, [sp, #32]', '    ldr x3, [sp, #40]', '    bl valen_array_new', '    str x0, [sp, #48]',
            '    ldr x4, [sp, #8]', '    ldr x5, [sp, #24]', '    mul x4, x4, x5', '    ldr x6, [sp, #0]',
            '    ldr x6, [x6, #16]', '    add x6, x6, x4', '    ldr x7, [x0, #16]', '    ldr x4, [sp, #16]',
            '    mul x4, x4, x5', '.Larray_slice_copy:', '    cbz x4, .Larray_slice_done', '    ldrb w8, [x6, #0]',
            '    strb w8, [x7, #0]', '    add x6, x6, #1', '    add x7, x7, #1', '    sub x4, x4, #1',
            '    b .Larray_slice_copy', '.Larray_slice_done:', '    ldr x0, [sp, #48]', '    ldr x30, [sp, #72]',
            '    add sp, sp, #80', '    ret', '.size valen_array_slice, .-valen_array_slice', ''];
    }

    stringRuntime() {
        return ['.globl valen_string_new', '.type valen_string_new, %function', 'valen_string_new:',
            '    cmp x0, #0', '    b.lt .Larray_bounds_error', '    sub sp, sp, #32', '    str x30, [sp, #24]',
            '    str x0, [sp, #0]', '    mov x0, #24', '    mov x1, #0', '    mov x2, #0',
            ...this.address('x3', 'valen_string_finalize'),
            '    bl valen_gc_alloc', '    str x0, [sp, #8]',
            '    ldr x0, [sp, #0]', '    cbnz x0, .Lstring_new_allocate', '    mov x0, #1', '.Lstring_new_allocate:',
            '    str x0, [sp, #16]', '    bl valen_alloc', '    mov x1, x0', '    ldr x0, [sp, #8]',
            '    str x1, [x0, #0]', '    ldr x1, [sp, #0]', '    str x1, [x0, #8]', '    ldr x1, [sp, #16]',
            '    str x1, [x0, #16]', '    ldr x30, [sp, #24]', '    add sp, sp, #32', '    ret',
            '.size valen_string_new, .-valen_string_new', '', '.type valen_string_finalize, %function',
            'valen_string_finalize:', '    ldr x1, [x0, #16]', '    cbnz x1, .Lstring_finalize_size',
            '    mov x1, #1', '.Lstring_finalize_size:', '    ldr x0, [x0, #0]', '    mov x8, #215',
            '    svc #0', '    ret', '.size valen_string_finalize, .-valen_string_finalize', '',
            '.globl valen_string_address',
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
            '    mov x0, #1', '    mov x2, #0', '    mov x3, #0', '    bl valen_array_new',
            '    str x0, [sp, #16]', '    ldr x2, [x0, #16]',
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

    builderRuntime() {
        return ['.globl valen_integer_to_string', '.type valen_integer_to_string, %function',
            'valen_integer_to_string:', '    sub sp, sp, #64', '    str x30, [sp, #56]', '    str x0, [sp, #0]',
            '    str x1, [sp, #8]', '    mov x0, #21', '    bl valen_string_new', '    str x0, [sp, #16]',
            '    ldr x2, [x0, #0]', '    add x2, x2, #21', '    mov x3, x2', '    ldr x4, [sp, #0]',
            '    str xzr, [sp, #24]', '    ldr x5, [sp, #8]', '    cbz x5, .Linteger_string_magnitude',
            '    cmp x4, #0', '    b.ge .Linteger_string_magnitude', '    neg x4, x4', '    mov x5, #1',
            '    str x5, [sp, #24]', '.Linteger_string_magnitude:', '    mov x6, #10',
            '.Linteger_string_digits:', '    udiv x7, x4, x6', '    mul x8, x7, x6', '    sub x8, x4, x8',
            '    add x8, x8, #48', '    sub x2, x2, #1', '    strb w8, [x2, #0]', '    mov x4, x7',
            '    cbnz x4, .Linteger_string_digits', '    ldr x5, [sp, #24]', '    cbz x5, .Linteger_string_done',
            '    sub x2, x2, #1', '    mov x5, #45', '    strb w5, [x2, #0]', '.Linteger_string_done:',
            '    sub x4, x3, x2', '    ldr x0, [sp, #16]', '    str x4, [x0, #8]', '    ldr x3, [x0, #0]',
            '.Linteger_string_copy:', '    cbz x4, .Linteger_string_copy_done', '    ldrb w5, [x2, #0]',
            '    strb w5, [x3, #0]', '    add x2, x2, #1', '    add x3, x3, #1', '    sub x4, x4, #1',
            '    b .Linteger_string_copy', '.Linteger_string_copy_done:', '    ldr x0, [sp, #16]',
            '    ldr x30, [sp, #56]', '    add sp, sp, #64', '    ret',
            '.size valen_integer_to_string, .-valen_integer_to_string', '',
            '.globl valen_builder_append_string', '.type valen_builder_append_string, %function',
            'valen_builder_append_string:', '    ldr x2, [x1, #8]', '    ldr x1, [x1, #0]',
            '    b valen_builder_append_raw', '.size valen_builder_append_string, .-valen_builder_append_string', '',
            '.globl valen_builder_append_bytes', '.type valen_builder_append_bytes, %function',
            'valen_builder_append_bytes:', '    ldr x2, [x1, #0]', '    ldr x1, [x1, #16]',
            '    b valen_builder_append_raw', '.size valen_builder_append_bytes, .-valen_builder_append_bytes', '',
            '.type valen_builder_append_raw, %function', 'valen_builder_append_raw:', '    ldr x3, [x0, #0]',
            '    add x4, x3, x2', '    cmp x4, x3', '    b.cc .Larray_bounds_error', '    sub sp, sp, #64',
            '    str x30, [sp, #56]', '    str x0, [sp, #0]', '    str x1, [sp, #8]', '    str x2, [sp, #16]',
            '    str x3, [sp, #24]', '    str x4, [sp, #32]', '    mov x1, x4', '    mov x2, #1',
            '    bl valen_array_reserve', '    ldr x0, [sp, #0]', '    ldr x1, [sp, #8]', '    ldr x2, [sp, #16]',
            '    ldr x3, [sp, #24]', '    ldr x4, [x0, #16]', '    add x4, x4, x3',
            '.Lbuilder_append_copy:', '    cbz x2, .Lbuilder_append_done', '    ldrb w5, [x1, #0]',
            '    strb w5, [x4, #0]', '    add x1, x1, #1', '    add x4, x4, #1', '    sub x2, x2, #1',
            '    b .Lbuilder_append_copy', '.Lbuilder_append_done:', '    ldr x4, [sp, #32]', '    str x4, [x0, #0]',
            '    ldr x30, [sp, #56]', '    add sp, sp, #64', '    ret',
            '.size valen_builder_append_raw, .-valen_builder_append_raw', '', '.globl valen_builder_build',
            '.type valen_builder_build, %function', 'valen_builder_build:', '    sub sp, sp, #48',
            '    str x30, [sp, #40]', '    str x0, [sp, #0]', '    ldr x1, [x0, #0]', '    str x1, [sp, #8]',
            '    mov x0, x1', '    bl valen_string_new', '    str x0, [sp, #16]', '    ldr x2, [x0, #0]',
            '    ldr x0, [sp, #0]', '    ldr x1, [x0, #16]', '    ldr x3, [sp, #8]',
            '.Lbuilder_build_copy:', '    cbz x3, .Lbuilder_build_done', '    ldrb w4, [x1, #0]',
            '    strb w4, [x2, #0]', '    add x1, x1, #1', '    add x2, x2, #1', '    sub x3, x3, #1',
            '    b .Lbuilder_build_copy', '.Lbuilder_build_done:', '    ldr x0, [sp, #16]', '    ldr x30, [sp, #40]',
            '    add sp, sp, #48', '    ret', '.size valen_builder_build, .-valen_builder_build', ''];
    }

    systemRuntime() {
        const lines = [];
        if (this.runtimeSymbols.has('valen_System_collectGarbage')) lines.push(
            '.globl valen_System_collectGarbage', '.type valen_System_collectGarbage, %function',
            'valen_System_collectGarbage:', '    b valen_gc_collect',
            '.size valen_System_collectGarbage, .-valen_System_collectGarbage', '');
        if (this.runtimeSymbols.has('valen_System_write')) lines.push(...this.systemWriteRuntime('valen_System_write', 1));
        if (this.runtimeSymbols.has('valen_System_writeError')) lines.push(...this.systemWriteRuntime('valen_System_writeError', 2));
        if (this.runtimeSymbols.has('valen_System_print')) lines.push(
            '.globl valen_System_print', '.type valen_System_print, %function', 'valen_System_print:',
            '    sub sp, sp, #64', '    mov x9, x0', '    mov x10, #0', '    cmp x9, #0',
            '    b.ge .Lsystem_print_magnitude', '    neg x9, x9', '    mov x10, #1',
            '.Lsystem_print_magnitude:', '    add x1, sp, #63', '    mov x11, #10', '    strb w11, [x1, #0]',
            '    mov x2, #1', '    mov x11, #10', '.Lsystem_print_digits:', '    udiv x12, x9, x11',
            '    mul x13, x12, x11', '    sub x13, x9, x13', '    add x13, x13, #48', '    sub x1, x1, #1',
            '    strb w13, [x1, #0]', '    add x2, x2, #1', '    mov x9, x12',
            '    cbnz x9, .Lsystem_print_digits', '    cbz x10, .Lsystem_print_write',
            '    sub x1, x1, #1', '    mov x13, #45', '    strb w13, [x1, #0]', '    add x2, x2, #1',
            '.Lsystem_print_write:', '    mov x0, #1', '    mov x8, #64', '    svc #0',
            '    mov x14, #-4', '    cmp x0, x14', '    b.eq .Lsystem_print_write', '    cmp x0, #0', '    b.le .Lsystem_print_done',
            '    add x1, x1, x0', '    sub x2, x2, x0', '    cbnz x2, .Lsystem_print_write',
            '.Lsystem_print_done:', '    add sp, sp, #64', '    ret', '.size valen_System_print, .-valen_System_print', '');
        if (this.runtimeSymbols.has('valen_System_exit')) lines.push(
            '.globl valen_System_exit', '.type valen_System_exit, %function', 'valen_System_exit:',
            '    mov x8, #93', '    svc #0', '.size valen_System_exit, .-valen_System_exit', '');
        if (this.runtimeSymbols.has('valen_System_openRead')) lines.push(...this.systemOpenRuntime('valen_System_openRead', 0));
        if (this.runtimeSymbols.has('valen_System_openWrite')) lines.push(...this.systemOpenRuntime('valen_System_openWrite', 577));
        if (this.runtimeSymbols.has('valen_System_read')) lines.push(...this.systemReadRuntime());
        if (this.runtimeSymbols.has('valen_System_writeFile')) lines.push(...this.systemFileWriteRuntime());
        if (this.runtimeSymbols.has('valen_System_writeBytes')) lines.push(...this.systemFileWriteRuntime(true));
        if (this.runtimeSymbols.has('valen_System_close')) lines.push(...this.systemCloseRuntime());
        if (this.runtimeSymbols.has('valen_System_sync')) lines.push(...this.systemSyncRuntime());
        if (this.runtimeSymbols.has('valen_System_lastError')) lines.push(
            '.globl valen_System_lastError', '.type valen_System_lastError, %function', 'valen_System_lastError:',
            ...this.address('x9', 'valen_filesystem_error'), '    ldr x0, [x9, #0]', '    ret',
            '.size valen_System_lastError, .-valen_System_lastError', '');
        if (this.runtimeSymbols.has('valen_System_arguments')) lines.push(...this.systemArgumentsRuntime());
        if (this.runtimeSymbols.has('valen_System_currentDirectory')) lines.push(...this.systemCurrentDirectoryRuntime());
        if (this.runtimeSymbols.has('valen_System_environmentVariable')) lines.push(...this.systemEnvironmentRuntime());
        if (this.runtimeSymbols.has('valen_System_enableProcessArena')) lines.push(
            '.globl valen_System_enableProcessArena', '.type valen_System_enableProcessArena, %function',
            'valen_System_enableProcessArena:', '    ret',
            '.size valen_System_enableProcessArena, .-valen_System_enableProcessArena', '');
        if (['valen_System_replaceFile', 'valen_System_removeFile', 'valen_System_makeExecutable', 'valen_System_link']
            .some(symbol => this.runtimeSymbols.has(symbol))) lines.push(...this.systemPathRuntime());
        if (this.runtimeSymbols.has('valen_System_link')) lines.push(...this.systemLinkRuntime());
        if (this.runtimeSymbols.has('valen_System_memoryCopy')) lines.push(...this.systemMemoryCopyRuntime());
        if (this.runtimeSymbols.has('valen_System_memoryCompare')) lines.push(...this.systemMemoryCompareRuntime());
        if (this.runtimeSymbols.has('valen_System_fileDescriptor')) lines.push(...this.descriptorRuntime('valen_System_fileDescriptor'));
        if (this.runtimeSymbols.has('valen_System_makeFileNonblocking')) lines.push(...this.nonblockingRuntime('valen_System_makeFileNonblocking'));
        if ([...this.runtimeSymbols].some(symbol => symbol.startsWith('valen_Network_'))) lines.push(...this.networkRuntime());
        if ([...this.runtimeSymbols].some(symbol => symbol.startsWith('valen_EventLoop_'))) lines.push(...this.eventLoopRuntime());
        if ([...this.runtimeSymbols].some(symbol => symbol.startsWith('valen_Operations_'))) lines.push(...this.operationsRuntime());
        return lines;
    }

    systemWriteRuntime(symbol, descriptor) {
        const next = `.L${symbol}_next`, done = `.L${symbol}_done`;
        return [`.globl ${symbol}`, `.type ${symbol}, %function`, `${symbol}:`, '    ldr x1, [x0, #0]',
            '    ldr x2, [x0, #8]', `${next}:`, `    cbz x2, ${done}`, `    mov x0, #${descriptor}`,
            '    mov x8, #64', '    svc #0', '    mov x9, #-4', '    cmp x0, x9', `    b.eq ${next}`, '    cmp x0, #0',
            `    b.le ${done}`, '    add x1, x1, x0', '    sub x2, x2, x0', `    b ${next}`, `${done}:`,
            '    ret', `.size ${symbol}, .-${symbol}`, ''];
    }

    systemOpenRuntime(symbol, flags) {
        const error = `.L${symbol}_error`, done = `.L${symbol}_done`, copy = `.L${symbol}_copy`;
        return [`.globl ${symbol}`, `.type ${symbol}, %function`, `${symbol}:`, '    sub sp, sp, #64',
            '    str x30, [sp, #56]', '    ldr x9, [x0, #0]', '    str x9, [sp, #0]', '    ldr x9, [x0, #8]',
            '    str x9, [sp, #8]', '    add x0, x9, #1', '    bl valen_alloc', '    str x0, [sp, #16]',
            '    ldr x1, [sp, #0]', '    ldr x2, [sp, #8]', '    mov x3, x0', `${copy}:`,
            `    cbz x2, ${copy}_done`, '    ldrb w4, [x1, #0]', '    strb w4, [x3, #0]',
            '    add x1, x1, #1', '    add x3, x3, #1', '    sub x2, x2, #1', `    b ${copy}`,
            `${copy}_done:`, '    mov x4, #0', '    strb w4, [x3, #0]', '    mov x0, #-100', '    ldr x1, [sp, #16]',
            `    mov x2, #${flags}`, '    mov x3, #420', '    mov x8, #56', '    svc #0',
            `    cmp x0, #0`, `    b.lt ${error}`, '    str x0, [sp, #24]', ...this.clearFilesystemError(),
            '    mov x0, #8', '    bl valen_alloc', '    ldr x9, [sp, #24]', '    str x9, [x0, #0]', `    b ${done}`,
            `${error}:`, '    neg x10, x0', ...this.storeFilesystemError('x10'), '    mov x0, #0', `${done}:`,
            '    ldr x30, [sp, #56]', '    add sp, sp, #64', '    ret', `.size ${symbol}, .-${symbol}`, ''];
    }

    systemReadRuntime() {
        return ['.globl valen_System_read', '.type valen_System_read, %function', 'valen_System_read:',
            '    cmp x1, #0', '    b.lt .Lsystem_read_invalid', '    sub sp, sp, #48', '    str x30, [sp, #40]',
            '    ldr x9, [x0, #0]', '    str x9, [sp, #0]', '    str x1, [sp, #8]', '    mov x0, x1',
            '    bl valen_string_new', '    str x0, [sp, #16]', '    ldr x1, [x0, #0]', '    ldr x0, [sp, #0]',
            '    ldr x2, [sp, #8]', '    mov x8, #63', '    svc #0', '    cmp x0, #0',
            '    b.lt .Lsystem_read_error', ...this.clearFilesystemError(), '    ldr x9, [sp, #16]',
            '    str x0, [x9, #8]', '    mov x0, x9', '    b .Lsystem_read_done', '.Lsystem_read_error:',
            '    neg x10, x0', ...this.storeFilesystemError('x10'), '    mov x0, #0', '.Lsystem_read_done:',
            '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret', '.Lsystem_read_invalid:',
            '    mov x10, #22', ...this.storeFilesystemError('x10'), '    mov x0, #0', '    ret',
            '.size valen_System_read, .-valen_System_read', ''];
    }

    systemFileWriteRuntime(bytes = false) {
        const symbol = bytes ? 'valen_System_writeBytes' : 'valen_System_writeFile';
        const prefix = bytes ? '.Lsystem_file_write_bytes' : '.Lsystem_file_write';
        return [`.globl ${symbol}`, `.type ${symbol}, %function`, `${symbol}:`, '    ldr x9, [x0, #0]',
            `    ldr x10, [x1, #${bytes ? 16 : 0}]`, `    ldr x11, [x1, #${bytes ? 0 : 8}]`,
            '    mov x12, #0', `${prefix}_next:`, `    cbz x11, ${prefix}_done`,
            '    mov x0, x9', '    mov x1, x10', '    mov x2, x11',
            '    mov x8, #64', '    svc #0', '    mov x13, #-4', '    cmp x0, x13',
            `    b.eq ${prefix}_next`, '    cmp x0, #0', `    b.lt ${prefix}_error`,
            '    add x12, x12, x0', '    add x10, x10, x0', '    sub x11, x11, x0',
            `    b ${prefix}_next`, `${prefix}_done:`, ...this.clearFilesystemError(),
            '    mov x0, x12', '    ret', `${prefix}_error:`, '    neg x13, x0',
            ...this.storeFilesystemError('x13'), `    cbnz x12, ${prefix}_partial`, '    ret',
            `${prefix}_partial:`, '    mov x0, x12', '    ret', `.size ${symbol}, .-${symbol}`, ''];
    }

    systemCloseRuntime() {
        return ['.globl valen_System_close', '.type valen_System_close, %function', 'valen_System_close:',
            '    ldr x0, [x0, #0]', '    mov x8, #57', '    svc #0', '    cmp x0, #0',
            '    b.lt .Lsystem_close_error', ...this.clearFilesystemError(), '    ret', '.Lsystem_close_error:',
            '    neg x10, x0', ...this.storeFilesystemError('x10'), '    ret',
            '.size valen_System_close, .-valen_System_close', ''];
    }

    systemSyncRuntime() {
        return ['.globl valen_System_sync', '.type valen_System_sync, %function', 'valen_System_sync:',
            '    ldr x0, [x0, #0]', '    mov x8, #82', '    svc #0', '    cmp x0, #0',
            '    b.lt .Lsystem_sync_error', ...this.clearFilesystemError(), '    ret', '.Lsystem_sync_error:',
            '    neg x10, x0', ...this.storeFilesystemError('x10'), '    ret',
            '.size valen_System_sync, .-valen_System_sync', ''];
    }

    systemPathRuntime() {
        const lines = ['.type valen_path_cstring, %function', 'valen_path_cstring:', '    sub sp, sp, #48',
            '    str x30, [sp, #40]', '    ldr x9, [x0, #0]', '    str x9, [sp, #0]', '    ldr x9, [x0, #8]',
            '    str x9, [sp, #8]', '    add x0, x9, #1', '    bl valen_alloc', '    mov x4, x0',
            '    ldr x1, [sp, #0]', '    ldr x2, [sp, #8]', '    mov x3, x0', '.Lpath_cstring_copy:',
            '    cbz x2, .Lpath_cstring_done', '    ldrb w5, [x1, #0]', '    strb w5, [x3, #0]',
            '    add x1, x1, #1', '    add x3, x3, #1', '    sub x2, x2, #1',
            '    b .Lpath_cstring_copy', '.Lpath_cstring_done:', '    mov x5, #0', '    strb w5, [x3, #0]',
            '    mov x0, x4', '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret',
            '.size valen_path_cstring, .-valen_path_cstring', ''];
        if (this.runtimeSymbols.has('valen_System_replaceFile')) lines.push(
            '.globl valen_System_replaceFile', '.type valen_System_replaceFile, %function',
            'valen_System_replaceFile:', '    sub sp, sp, #48', '    str x30, [sp, #40]', '    str x1, [sp, #0]',
            '    bl valen_path_cstring', '    str x0, [sp, #8]', '    ldr x0, [sp, #0]',
            '    bl valen_path_cstring', '    mov x3, x0', '    mov x0, #-100', '    ldr x1, [sp, #8]',
            '    mov x2, #-100', '    mov x8, #38', '    svc #0', '    cmp x0, #0',
            '    b.lt .Lsystem_replace_error', ...this.clearFilesystemError(), '    b .Lsystem_replace_done',
            '.Lsystem_replace_error:', '    neg x10, x0', ...this.storeFilesystemError('x10'),
            '.Lsystem_replace_done:', '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret',
            '.size valen_System_replaceFile, .-valen_System_replaceFile', '');
        if (this.runtimeSymbols.has('valen_System_removeFile')) lines.push(...this.systemSinglePathRuntime(
            'valen_System_removeFile', 35, ['    mov x1, x0', '    mov x0, #-100', '    mov x2, #0']));
        if (this.runtimeSymbols.has('valen_System_makeExecutable')) lines.push(...this.systemSinglePathRuntime(
            'valen_System_makeExecutable', 53, ['    mov x1, x0', '    mov x0, #-100', '    mov x2, #493']));
        return lines;
    }

    systemSinglePathRuntime(symbol, syscall, setup) {
        const error = `.L${symbol}_error`, done = `.L${symbol}_done`;
        return [`.globl ${symbol}`, `.type ${symbol}, %function`, `${symbol}:`, '    sub sp, sp, #16',
            '    str x30, [sp, #8]', '    bl valen_path_cstring', ...setup, `    mov x8, #${syscall}`,
            '    svc #0', '    cmp x0, #0', `    b.lt ${error}`, ...this.clearFilesystemError(), `    b ${done}`,
            `${error}:`, '    neg x10, x0', ...this.storeFilesystemError('x10'), `${done}:`,
            '    ldr x30, [sp, #8]', '    add sp, sp, #16', '    ret', `.size ${symbol}, .-${symbol}`, ''];
    }

    systemLinkRuntime() {
        return ['.globl valen_System_link', '.type valen_System_link, %function', 'valen_System_link:',
            '    sub sp, sp, #112', '    str x30, [sp, #104]', '    str x1, [sp, #0]', '    str x2, [sp, #8]',
            '    bl valen_path_cstring', '    str x0, [sp, #16]', '    ldr x0, [sp, #0]',
            '    bl valen_path_cstring', '    str x0, [sp, #24]', '    ldr x9, [sp, #8]',
            '    ldr x10, [x9, #0]', '    str x10, [sp, #32]', '    add x0, x10, #7', '    lsl x0, x0, #3',
            '    bl valen_alloc', '    str x0, [sp, #40]', ...this.address('x9', '.Lvalen_link_cc'),
            '    str x9, [x0, #0]', ...this.address('x9', '.Lvalen_link_no_stdlib'), '    str x9, [x0, #8]',
            ...this.address('x9', '.Lvalen_link_no_pie'), '    str x9, [x0, #16]', '    ldr x9, [sp, #16]',
            '    str x9, [x0, #24]', ...this.address('x9', '.Lvalen_link_output'), '    str x9, [x0, #32]',
            '    ldr x9, [sp, #24]', '    str x9, [x0, #40]', '    str xzr, [sp, #48]',
            '.Lsystem_link_library_next:', '    ldr x9, [sp, #48]', '    ldr x10, [sp, #32]',
            '    cmp x9, x10', '    b.cs .Lsystem_link_library_done', '    ldr x10, [sp, #8]',
            '    ldr x10, [x10, #16]', '    lsl x11, x9, #3', '    add x10, x10, x11', '    ldr x10, [x10, #0]',
            '    ldr x11, [x10, #0]', '    str x11, [sp, #56]', '    ldr x12, [x10, #8]', '    str x12, [sp, #64]',
            '    cbz x12, .Lsystem_link_normal_library', '    ldrb w13, [x11, #0]', '    cmp x13, #64',
            '    b.ne .Lsystem_link_normal_library', '    mov x0, x12', '    bl valen_alloc', '    str x0, [sp, #72]',
            '    ldr x1, [sp, #56]', '    add x1, x1, #1', '    ldr x2, [sp, #64]', '    sub x2, x2, #1',
            '    b .Lsystem_link_library_copy', '.Lsystem_link_normal_library:', '    ldr x12, [sp, #64]',
            '    add x0, x12, #3', '    bl valen_alloc', '    str x0, [sp, #72]', '    mov x13, #45',
            '    strb w13, [x0, #0]', '    mov x13, #108', '    strb w13, [x0, #1]', '    add x0, x0, #2',
            '    ldr x1, [sp, #56]', '    ldr x2, [sp, #64]', '.Lsystem_link_library_copy:',
            '    cbz x2, .Lsystem_link_library_terminate', '    ldrb w13, [x1, #0]', '    strb w13, [x0, #0]',
            '    add x1, x1, #1', '    add x0, x0, #1', '    sub x2, x2, #1',
            '    b .Lsystem_link_library_copy', '.Lsystem_link_library_terminate:', '    mov x13, #0',
            '    strb w13, [x0, #0]', '    ldr x9, [sp, #48]', '    add x10, x9, #6', '    lsl x10, x10, #3',
            '    ldr x11, [sp, #40]', '    add x10, x11, x10', '    ldr x11, [sp, #72]', '    str x11, [x10, #0]',
            '    add x9, x9, #1', '    str x9, [sp, #48]', '    b .Lsystem_link_library_next',
            '.Lsystem_link_library_done:', '    add x10, x9, #6', '    lsl x10, x10, #3',
            '    ldr x11, [sp, #40]', '    add x10, x11, x10', '    str xzr, [x10, #0]',
            '    mov x0, #17', '    mov x1, #0', '    mov x2, #0', '    mov x3, #0', '    mov x4, #0',
            '    mov x8, #220', '    svc #0', '    cmp x0, #0', '    b.lt .Lsystem_link_failure',
            '    cbz x0, .Lsystem_link_child', '    add x1, sp, #88', '    mov x2, #0', '    mov x3, #0',
            '    mov x8, #260', '    svc #0', '    cmp x0, #0', '    b.lt .Lsystem_link_failure',
            '    ldr x9, [sp, #88]', '    mov x10, #127', '    and x10, x9, x10',
            '    cbnz x10, .Lsystem_link_signaled', '    lsr x0, x9, #8', '    mov x10, #255',
            '    and x0, x0, x10', '    b .Lsystem_link_done', '.Lsystem_link_signaled:',
            '    add x0, x10, #128', '    b .Lsystem_link_done', '.Lsystem_link_child:',
            ...this.address('x0', '.Lvalen_link_cc'), '    ldr x1, [sp, #40]',
            ...this.address('x9', 'valen_process_envp'), '    ldr x2, [x9, #0]', '    mov x8, #221',
            '    svc #0', '    mov x0, #127', '    mov x8, #93', '    svc #0', '.Lsystem_link_failure:',
            '    mov x0, #127', '.Lsystem_link_done:', '    ldr x30, [sp, #104]', '    add sp, sp, #112',
            '    ret', '.size valen_System_link, .-valen_System_link', '', '.section .data',
            '.Lvalen_link_cc:', '    .byte 47,117,115,114,47,98,105,110,47,99,99,0',
            '.Lvalen_link_no_stdlib:', '    .byte 45,110,111,115,116,100,108,105,98,0',
            '.Lvalen_link_no_pie:', '    .byte 45,110,111,45,112,105,101,0',
            '.Lvalen_link_output:', '    .byte 45,111,0', '.text'];
    }

    systemMemoryCopyRuntime() {
        return ['.globl valen_System_memoryCopy', '.type valen_System_memoryCopy, %function',
            'valen_System_memoryCopy:', '    cmp x1, #0', '    b.lt .Larray_bounds_error', '    cmp x3, #0',
            '    b.lt .Larray_bounds_error', '    cmp x4, #0', '    b.lt .Larray_bounds_error',
            '    ldr x9, [x0, #0]', '    cmp x1, x9', '    b.hi .Larray_bounds_error', '    sub x9, x9, x1',
            '    cmp x4, x9', '    b.hi .Larray_bounds_error', '    ldr x9, [x2, #0]', '    cmp x3, x9',
            '    b.hi .Larray_bounds_error', '    sub x9, x9, x3', '    cmp x4, x9',
            '    b.hi .Larray_bounds_error', '    ldr x9, [x0, #16]', '    add x9, x9, x1',
            '    ldr x10, [x2, #16]', '    add x10, x10, x3', '.Lsystem_memory_copy_next:',
            '    cbz x4, .Lsystem_memory_copy_done', '    ldrb w11, [x10, #0]', '    strb w11, [x9, #0]',
            '    add x9, x9, #1', '    add x10, x10, #1', '    sub x4, x4, #1',
            '    b .Lsystem_memory_copy_next', '.Lsystem_memory_copy_done:', '    mov x0, #1', '    ret',
            '.size valen_System_memoryCopy, .-valen_System_memoryCopy', ''];
    }

    systemMemoryCompareRuntime() {
        return ['.globl valen_System_memoryCompare', '.type valen_System_memoryCompare, %function',
            'valen_System_memoryCompare:', '    cmp x1, #0', '    b.lt .Larray_bounds_error', '    cmp x3, #0',
            '    b.lt .Larray_bounds_error', '    cmp x4, #0', '    b.lt .Larray_bounds_error',
            '    ldr x9, [x0, #0]', '    cmp x1, x9', '    b.hi .Larray_bounds_error', '    sub x9, x9, x1',
            '    cmp x4, x9', '    b.hi .Larray_bounds_error', '    ldr x9, [x2, #0]', '    cmp x3, x9',
            '    b.hi .Larray_bounds_error', '    sub x9, x9, x3', '    cmp x4, x9',
            '    b.hi .Larray_bounds_error', '    ldr x9, [x0, #16]', '    add x9, x9, x1',
            '    ldr x10, [x2, #16]', '    add x10, x10, x3', '.Lsystem_memory_compare_next:',
            '    cbz x4, .Lsystem_memory_compare_equal', '    ldrb w11, [x9, #0]', '    ldrb w12, [x10, #0]',
            '    cmp x11, x12', '    b.cc .Lsystem_memory_compare_less', '    b.hi .Lsystem_memory_compare_greater',
            '    add x9, x9, #1', '    add x10, x10, #1', '    sub x4, x4, #1',
            '    b .Lsystem_memory_compare_next', '.Lsystem_memory_compare_less:', '    mov x0, #-1', '    ret',
            '.Lsystem_memory_compare_greater:', '    mov x0, #1', '    ret',
            '.Lsystem_memory_compare_equal:', '    mov x0, #0', '    ret',
            '.size valen_System_memoryCompare, .-valen_System_memoryCompare', ''];
    }

    clearFilesystemError() { return [...this.address('x9', 'valen_filesystem_error'), '    str xzr, [x9, #0]']; }
    storeFilesystemError(register) {
        return [...this.address('x9', 'valen_filesystem_error'), `    str ${register}, [x9, #0]`];
    }

    systemArgumentsRuntime() {
        const arrayType = 'Array<string>';
        return ['.globl valen_System_arguments', '.type valen_System_arguments, %function',
            'valen_System_arguments:', '    sub sp, sp, #80', '    str x30, [sp, #72]',
            ...this.address('x9', 'valen_process_argc'), '    ldr x9, [x9, #0]', '    str x9, [sp, #0]',
            ...this.address('x9', 'valen_process_argv'), '    ldr x9, [x9, #0]', '    str x9, [sp, #8]',
            '    mov x0, #8', '    ldr x1, [sp, #0]', ...this.address('x2', this.gcArrayTraceLabel(arrayType)),
            '    mov x3, #0', '    bl valen_array_new', '    str x0, [sp, #16]', '    str xzr, [sp, #24]',
            '.Lsystem_arguments_next:', '    ldr x9, [sp, #24]', '    ldr x10, [sp, #0]',
            '    cmp x9, x10', '    b.cs .Lsystem_arguments_done', '    ldr x10, [sp, #8]',
            '    lsl x11, x9, #3', '    add x10, x10, x11', '    ldr x10, [x10, #0]', '    str x10, [sp, #32]',
            '    mov x11, #0', '.Lsystem_arguments_length:', '    ldrb w12, [x10, #0]',
            '    cbz x12, .Lsystem_arguments_allocate', '    add x10, x10, #1', '    add x11, x11, #1',
            '    b .Lsystem_arguments_length', '.Lsystem_arguments_allocate:', '    str x11, [sp, #40]',
            '    mov x0, x11', '    bl valen_string_new', '    str x0, [sp, #48]', '    ldr x12, [x0, #0]',
            '    ldr x10, [sp, #32]', '    ldr x11, [sp, #40]', '.Lsystem_arguments_copy:',
            '    cbz x11, .Lsystem_arguments_store', '    ldrb w13, [x10, #0]', '    strb w13, [x12, #0]',
            '    add x10, x10, #1', '    add x12, x12, #1', '    sub x11, x11, #1',
            '    b .Lsystem_arguments_copy', '.Lsystem_arguments_store:', '    ldr x9, [sp, #16]',
            '    ldr x9, [x9, #16]', '    ldr x10, [sp, #24]', '    lsl x10, x10, #3', '    add x9, x9, x10',
            '    ldr x10, [sp, #48]', '    str x10, [x9, #0]', '    ldr x9, [sp, #24]', '    add x9, x9, #1',
            '    str x9, [sp, #24]', '    b .Lsystem_arguments_next', '.Lsystem_arguments_done:',
            '    ldr x0, [sp, #16]', '    ldr x30, [sp, #72]', '    add sp, sp, #80', '    ret',
            '.size valen_System_arguments, .-valen_System_arguments', ''];
    }

    systemCurrentDirectoryRuntime() {
        return ['.globl valen_System_currentDirectory', '.type valen_System_currentDirectory, %function',
            'valen_System_currentDirectory:', '    sub sp, sp, #48', '    str x30, [sp, #40]',
            '    mov x0, #4096', '    bl valen_string_new', '    str x0, [sp, #0]', '    ldr x0, [x0, #0]',
            '    mov x1, #4096', '    mov x8, #17', '    svc #0', '    cmp x0, #0',
            '    b.lt .Lsystem_current_directory_error', '    ldr x9, [sp, #0]', '    ldr x10, [x9, #0]',
            '    mov x11, #0', '.Lsystem_current_directory_length:', '    ldrb w12, [x10, #0]',
            '    cbz x12, .Lsystem_current_directory_done', '    add x10, x10, #1', '    add x11, x11, #1',
            '    b .Lsystem_current_directory_length', '.Lsystem_current_directory_done:', '    str x11, [x9, #8]',
            ...this.clearFilesystemError(), '    ldr x0, [sp, #0]', '    b .Lsystem_current_directory_return',
            '.Lsystem_current_directory_error:', '    neg x10, x0', ...this.storeFilesystemError('x10'),
            '    mov x0, #0', '.Lsystem_current_directory_return:', '    ldr x30, [sp, #40]',
            '    add sp, sp, #48', '    ret', '.size valen_System_currentDirectory, .-valen_System_currentDirectory', ''];
    }

    systemEnvironmentRuntime() {
        return ['.globl valen_System_environmentVariable', '.type valen_System_environmentVariable, %function',
            'valen_System_environmentVariable:', '    sub sp, sp, #64', '    str x30, [sp, #56]',
            '    ldr x9, [x0, #0]', '    str x9, [sp, #0]', '    ldr x9, [x0, #8]', '    str x9, [sp, #8]',
            ...this.address('x9', 'valen_process_envp'), '    ldr x9, [x9, #0]', '    str x9, [sp, #16]',
            '.Lsystem_environment_next:', '    ldr x9, [sp, #16]', '    ldr x10, [x9, #0]',
            '    cbz x10, .Lsystem_environment_missing', '    ldr x11, [sp, #0]', '    ldr x12, [sp, #8]',
            '    mov x13, #0', '.Lsystem_environment_compare:', '    cmp x13, x12',
            '    b.eq .Lsystem_environment_name_end', '    ldrb w14, [x10, #0]', '    ldrb w15, [x11, #0]',
            '    cmp x14, x15', '    b.ne .Lsystem_environment_advance', '    add x10, x10, #1',
            '    add x11, x11, #1', '    add x13, x13, #1', '    b .Lsystem_environment_compare',
            '.Lsystem_environment_name_end:', '    ldrb w14, [x10, #0]', '    cmp x14, #61',
            '    b.ne .Lsystem_environment_advance', '    add x10, x10, #1', '    str x10, [sp, #24]',
            '    mov x11, #0', '.Lsystem_environment_length:', '    ldrb w12, [x10, #0]',
            '    cbz x12, .Lsystem_environment_allocate', '    add x10, x10, #1', '    add x11, x11, #1',
            '    b .Lsystem_environment_length', '.Lsystem_environment_allocate:', '    str x11, [sp, #32]',
            '    mov x0, x11', '    bl valen_string_new', '    str x0, [sp, #40]', '    ldr x12, [x0, #0]',
            '    ldr x10, [sp, #24]', '    ldr x11, [sp, #32]', '.Lsystem_environment_copy:',
            '    cbz x11, .Lsystem_environment_found', '    ldrb w13, [x10, #0]', '    strb w13, [x12, #0]',
            '    add x10, x10, #1', '    add x12, x12, #1', '    sub x11, x11, #1',
            '    b .Lsystem_environment_copy', '.Lsystem_environment_found:', '    ldr x0, [sp, #40]',
            '    b .Lsystem_environment_return', '.Lsystem_environment_advance:', '    ldr x9, [sp, #16]',
            '    add x9, x9, #8', '    str x9, [sp, #16]', '    b .Lsystem_environment_next',
            '.Lsystem_environment_missing:', '    mov x0, #0', '.Lsystem_environment_return:',
            '    ldr x30, [sp, #56]', '    add sp, sp, #64', '    ret',
            '.size valen_System_environmentVariable, .-valen_System_environmentVariable', ''];
    }

    descriptorRuntime(name, offset = 0) {
        return [`.globl ${name}`, `.type ${name}, %function`, `${name}:`, `    ldr x0, [x0, #${offset}]`,
            '    ret', `.size ${name}, .-${name}`, ''];
    }

    nonblockingRuntime(name, offset = 0) {
        const error = `.L${name}_error`, done = `.L${name}_done`;
        return [`.globl ${name}`, `.type ${name}, %function`, `${name}:`, '    sub sp, sp, #32',
            '    str x30, [sp, #24]', `    ldr x9, [x0, #${offset}]`, '    str x9, [sp, #0]', '    mov x0, x9',
            '    mov x1, #3', '    mov x8, #25', '    svc #0', '    cmp x0, #0', `    b.lt ${error}`,
            '    mov x2, #2048', '    orr x2, x0, x2', '    ldr x0, [sp, #0]', '    mov x1, #4',
            '    mov x8, #25', '    svc #0', '    cmp x0, #0', `    b.lt ${error}`, '    mov x0, #1',
            `    b ${done}`, `${error}:`, '    mov x0, #0', `${done}:`, '    ldr x30, [sp, #24]',
            '    add sp, sp, #32', '    ret', `.size ${name}, .-${name}`, ''];
    }

    networkRuntime() {
        const close = name => [`.globl ${name}`, `${name}:`, '    b valen_gc_native_handle_finalize', ''];
        return [
            '.globl valen_Network_listen', 'valen_Network_listen:', '    sub sp, sp, #80', '    str x19, [sp, #0]',
            '    str x20, [sp, #8]', '    str x30, [sp, #72]', '    mov x19, x0', '    mov x20, x1',
            '    mov x0, #2', '    mov x1, #1', '    mov x2, #0', '    mov x8, #198', '    svc #0',
            '    cmp x0, #0', '    b.lt .Lnetwork_listen_error', '    str x0, [sp, #16]', '    mov x9, #1',
            '    str w9, [sp, #32]', '    mov x1, #1', '    mov x2, #2', '    add x3, sp, #32', '    mov x4, #4',
            '    mov x8, #208', '    svc #0', '    cmp x0, #0', '    b.lt .Lnetwork_listen_close_error',
            '    mov x9, #2', '    strh w9, [sp, #32]', '    lsr x10, x19, #8', '    lsl x11, x19, #8',
            '    orr x10, x10, x11', '    strh w10, [sp, #34]', '    mov x9, #0', '    str w9, [sp, #36]',
            '    str xzr, [sp, #40]',
            '    ldr x0, [sp, #16]', '    add x1, sp, #32', '    mov x2, #16', '    mov x8, #200', '    svc #0',
            '    cmp x0, #0', '    b.lt .Lnetwork_listen_close_error', '    ldr x0, [sp, #16]', '    mov x1, x20',
            '    mov x8, #201', '    svc #0', '    cmp x0, #0', '    b.lt .Lnetwork_listen_close_error',
            '    mov x0, #24', '    mov x1, #0', '    mov x2, #0', ...this.address('x3', 'valen_gc_native_handle_finalize'),
            '    bl valen_gc_alloc', '    mov x9, #1', '    str x9, [x0, #8]', '    ldr x9, [sp, #16]',
            '    str x9, [x0, #16]', ...this.clearNetworkError(), '    b .Lnetwork_listen_done',
            '.Lnetwork_listen_close_error:', '    str x0, [sp, #24]', '    ldr x0, [sp, #16]', '    mov x8, #57',
            '    svc #0', '    ldr x0, [sp, #24]', '.Lnetwork_listen_error:', '    neg x9, x0',
            ...this.storeNetworkError('x9'), '    mov x0, #0', '.Lnetwork_listen_done:', '    ldr x19, [sp, #0]',
            '    ldr x20, [sp, #8]', '    ldr x30, [sp, #72]', '    add sp, sp, #80', '    ret', '',
            '.globl valen_Network_accept', 'valen_Network_accept:', '    sub sp, sp, #48', '    str x30, [sp, #40]',
            '    ldr x0, [x0, #16]', '    mov x1, #0', '    mov x2, #0', '    mov x8, #202', '    svc #0',
            '    cmp x0, #0', '    b.lt .Lnetwork_accept_error', '    str x0, [sp, #0]', '    mov x0, #24',
            '    mov x1, #0', '    mov x2, #0', ...this.address('x3', 'valen_gc_native_handle_finalize'),
            '    bl valen_gc_alloc', '    mov x9, #1', '    str x9, [x0, #8]', '    ldr x9, [sp, #0]',
            '    str x9, [x0, #16]', ...this.clearNetworkError(), '    b .Lnetwork_accept_done',
            '.Lnetwork_accept_error:', '    neg x9, x0', ...this.storeNetworkError('x9'), '    mov x0, #0',
            '.Lnetwork_accept_done:', '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret', '',
            '.globl valen_Network_receive', 'valen_Network_receive:', '    cmp x1, #0',
            '    b.lt .Lnetwork_invalid_null', '    sub sp, sp, #64', '    str x19, [sp, #0]', '    str x20, [sp, #8]',
            '    str x30, [sp, #56]', '    ldr x19, [x0, #16]', '    mov x20, x1', '    mov x0, x1',
            '    bl valen_string_new', '    str x0, [sp, #16]', '    ldr x1, [x0, #0]', '    mov x0, x19',
            '    mov x2, x20', '    mov x8, #63', '    svc #0', '    cmp x0, #0', '    b.lt .Lnetwork_receive_error',
            '    ldr x9, [sp, #16]', '    str x0, [x9, #8]', '    mov x0, x9', ...this.clearNetworkError(),
            '    b .Lnetwork_receive_done', '.Lnetwork_receive_error:', '    neg x9, x0',
            ...this.storeNetworkError('x9'), '    mov x0, #0', '.Lnetwork_receive_done:', '    ldr x19, [sp, #0]',
            '    ldr x20, [sp, #8]', '    ldr x30, [sp, #56]', '    add sp, sp, #64', '    ret', '',
            '.globl valen_Network_send', 'valen_Network_send:', '    ldr x9, [x0, #16]', '    ldr x10, [x1, #0]',
            '    ldr x11, [x1, #8]', '    mov x12, #0', '.Lnetwork_send_next:', '    cbz x11, .Lnetwork_send_done',
            '    mov x0, x9', '    mov x1, x10', '    mov x2, x11', '    mov x8, #64', '    svc #0',
            '    mov x13, #-4', '    cmp x0, x13', '    b.eq .Lnetwork_send_next', '    cmp x0, #0',
            '    b.lt .Lnetwork_send_error', '    add x12, x12, x0', '    add x10, x10, x0', '    sub x11, x11, x0',
            '    b .Lnetwork_send_next', '.Lnetwork_send_done:', ...this.clearNetworkError(), '    mov x0, x12', '    ret',
            '.Lnetwork_send_error:', '    neg x13, x0', ...this.storeNetworkError('x13'), '    cmp x12, #0',
            '    b.eq .Lnetwork_send_error_return', '    mov x0, x12', '.Lnetwork_send_error_return:', '    ret', '',
            '.globl valen_Network_sendSome', 'valen_Network_sendSome:', '    cmp x2, #0',
            '    b.lt .Lnetwork_invalid_negative', '    cmp x3, #0', '    b.lt .Lnetwork_invalid_negative',
            '    ldr x9, [x1, #8]', '    cmp x2, x9', '    b.hi .Lnetwork_invalid_negative', '    sub x9, x9, x2',
            '    cmp x3, x9', '    b.hi .Lnetwork_invalid_negative', '    ldr x9, [x0, #16]', '    ldr x10, [x1, #0]',
            '    add x10, x10, x2', '    mov x0, x9', '    mov x1, x10', '    mov x2, x3',
            '.Lnetwork_send_some_retry:', '    mov x8, #64', '    svc #0', '    mov x9, #-4', '    cmp x0, x9',
            '    b.eq .Lnetwork_send_some_retry', '    cmp x0, #0', '    b.lt .Lnetwork_send_some_error',
            ...this.clearNetworkError(), '    ret', '.Lnetwork_send_some_error:', '    neg x9, x0',
            ...this.storeNetworkError('x9'), '    mov x0, #-1', '    ret', '.Lnetwork_invalid_negative:',
            '    mov x9, #22', ...this.storeNetworkError('x9'), '    mov x0, #-1', '    ret',
            '.Lnetwork_invalid_null:', '    mov x9, #22', ...this.storeNetworkError('x9'), '    mov x0, #0', '    ret', '',
            ...close('valen_Network_closeListener'), ...close('valen_Network_closeConnection'),
            ...this.descriptorRuntime('valen_Network_listenerDescriptor', 16),
            ...this.descriptorRuntime('valen_Network_connectionDescriptor', 16),
            ...this.nonblockingRuntime('valen_Network_makeListenerNonblocking', 16),
            ...this.nonblockingRuntime('valen_Network_makeConnectionNonblocking', 16),
            '.globl valen_Network_lastError', 'valen_Network_lastError:', ...this.address('x9', 'valen_network_error'),
            '    ldr x0, [x9, #0]', '    ret', ''
        ];
    }

    clearNetworkError() { return [...this.address('x9', 'valen_network_error'), '    str xzr, [x9, #0]']; }
    storeNetworkError(register) { return [...this.address('x10', 'valen_network_error'), `    str ${register}, [x10, #0]`]; }

    eventLoopRuntime() {
        const lines = [];
        if (this.runtimeSymbols.has('valen_EventLoop_available')) lines.push(
            '.globl valen_EventLoop_available', 'valen_EventLoop_available:', '    mov x0, #1', '    ret', '');
        if (this.runtimeSymbols.has('valen_EventLoop_wait')) lines.push(
            '.globl valen_EventLoop_wait', 'valen_EventLoop_wait:', '    sub sp, sp, #112',
            '    str x19, [sp, #0]', '    str x20, [sp, #8]', '    str x21, [sp, #16]', '    str x22, [sp, #24]',
            '    str x23, [sp, #32]', '    str x24, [sp, #40]', '    str x30, [sp, #104]',
            '    ldr x19, [x0, #0]', '    ldr x9, [x1, #0]', '    cmp x19, x9', '    b.ne .Levent_wait_early',
            '    cbz x19, .Levent_wait_early', '    ldr x20, [x0, #16]', '    ldr x21, [x1, #16]', '    mov x22, x2',
            '    mov x9, #8', '    mul x0, x19, x9', '    str x0, [sp, #48]', '    bl valen_alloc',
            '    mov x23, x0', '    mov x24, #0', '.Levent_wait_fill:', '    cmp x24, x19',
            '    b.cs .Levent_wait_poll', '    lsl x9, x24, #3', '    add x10, x20, x9', '    ldr x11, [x10, #0]',
            '    add x10, x21, x9', '    ldr x12, [x10, #0]', '    add x10, x23, x9', '    str w11, [x10, #0]',
            '    strh w12, [x10, #4]', '    mov x11, #0', '    strh w11, [x10, #6]', '    add x24, x24, #1',
            '    b .Levent_wait_fill', '.Levent_wait_poll:', '    cmp x22, #0', '    b.lt .Levent_wait_infinite',
            '    mov x9, #1000', '    udiv x10, x22, x9', '    str x10, [sp, #64]', '    mul x11, x10, x9',
            '    sub x11, x22, x11', ...this.constant('x12', 1000000), '    mul x11, x11, x12',
            '    str x11, [sp, #72]', '    add x2, sp, #64', '    b .Levent_wait_call',
            '.Levent_wait_infinite:', '    mov x2, #0', '.Levent_wait_call:',
            ...(this.threading ? ['    str x2, [sp, #80]', '    bl valen_gc_mutator_leave', '    ldr x2, [sp, #80]'] : []),
            '    mov x0, x23', '    mov x1, x19', '    mov x3, #0', '    mov x4, #8', '    mov x8, #73', '    svc #0',
            ...(this.threading ? ['    str x0, [sp, #88]', '    bl valen_gc_mutator_enter', '    ldr x0, [sp, #88]'] : []), '    cmp x0, #0',
            '    b.le .Levent_wait_none', '    mov x24, #0', '.Levent_wait_scan:', '    cmp x24, x19',
            '    b.cs .Levent_wait_none', '    lsl x9, x24, #3', '    add x10, x23, x9', '    ldrh w11, [x10, #6]',
            '    cbnz x11, .Levent_wait_ready', '    add x24, x24, #1', '    b .Levent_wait_scan',
            '.Levent_wait_ready:', '    mov x22, x24', '    b .Levent_wait_cleanup',
            '.Levent_wait_none:', '    mov x22, #-1', '.Levent_wait_cleanup:', '    mov x0, x23', '    ldr x1, [sp, #48]',
            '    mov x8, #215', '    svc #0', '    mov x0, x22', '    b .Levent_wait_done',
            '.Levent_wait_early:', '    mov x0, #-1', '.Levent_wait_done:', '    ldr x19, [sp, #0]',
            '    ldr x20, [sp, #8]', '    ldr x21, [sp, #16]', '    ldr x22, [sp, #24]', '    ldr x23, [sp, #32]',
            '    ldr x24, [sp, #40]', '    ldr x30, [sp, #104]', '    add sp, sp, #112', '    ret', '');
        if (this.runtimeSymbols.has('valen_EventLoop_monotonicMilliseconds')) lines.push(
            '.globl valen_EventLoop_monotonicMilliseconds', 'valen_EventLoop_monotonicMilliseconds:',
            '    sub sp, sp, #32', '    str x30, [sp, #24]', '    mov x0, #1', '    add x1, sp, #0',
            '    mov x8, #113', '    svc #0', '    cmp x0, #0', '    b.lt .Levent_monotonic_error',
            '    ldr x9, [sp, #0]', '    mov x10, #1000', '    mul x9, x9, x10', '    ldr x10, [sp, #8]',
            ...this.constant('x11', 1000000), '    udiv x10, x10, x11', '    add x0, x9, x10',
            '    b .Levent_monotonic_done', '.Levent_monotonic_error:', '    mov x0, #-1',
            '.Levent_monotonic_done:', '    ldr x30, [sp, #24]', '    add sp, sp, #32', '    ret', '');
        return lines;
    }

    operationsRuntime() {
        const offset = suffix => {
            for (const [name, field] of this.fieldOffsets) if (name.endsWith(`::Operations.${suffix}`)) return field.offset;
            throw new Error(`Operations runtime requires field ${suffix}`);
        };
        const mutex = offset('Mutex.state'), condition = offset('Condition.sequence'), atomic = offset('Atomic.value');
        const handle = has => has('threadStart') || has('threadJoin') ? offset('ThreadOperation.handle') : 0;
        const worker = this.program.functions.find(fn => fn.displayName === 'Operations.ThreadOperation.runWorker');
        const lines = [];
        const has = name => this.runtimeSymbols.has(`valen_Operations_${name}`);
        const threadHandle = handle(has);
        if (has('threadAvailable')) lines.push('.globl valen_Operations_threadAvailable', 'valen_Operations_threadAvailable:',
            '    mov x0, #1', '    ret', '');
        if (has('threadStart')) {
            if (!worker || !this.symbols.has(worker.name)) throw new Error('Operations runtime requires ThreadOperation.runWorker');
            lines.push('.globl valen_Operations_threadStart', 'valen_Operations_threadStart:',
                '    sub sp, sp, #80', '    str x19, [sp, #0]', '    str x20, [sp, #8]', '    str x21, [sp, #16]',
                '    str x30, [sp, #72]', '    mov x19, x0', ...this.constant('x0', 1048576), '    bl valen_alloc',
                '    mov x20, x0', '    mov x9, #1', '    str x9, [x20, #0]', '    str x19, [x20, #8]',
                '    str xzr, [x20, #16]', ...this.address('x9', 'valen_thread_root_trace'), '    str x9, [x20, #24]',
                '    str x20, [x20, #32]', '    add x0, x20, #16', '    bl valen_gc_root_push',
                ...this.address('x9', 'valen_gc_workers'), '.Loperations_worker_increment:', '    ldaxr x10, [x9]',
                '    add x11, x10, #1', '    stlxr w12, x11, [x9]', '    cbnz w12, .Loperations_worker_increment',
                `    str x20, [x19, #${threadHandle}]`, ...this.constant('x9', 1048560), '    add x21, x20, x9',
                '    str x19, [x21, #0]', '    str x20, [x21, #8]', ...this.constant('x0', 331520),
                '    mov x1, x21', '    mov x2, #0', '    mov x3, #0', '    mov x4, #0', '    mov x8, #220',
                '    svc #0', '    cbz x0, .Loperations_thread_child', '    cmp x0, #0',
                '    b.lt .Loperations_thread_start_failed', '    mov x0, #1', '    ldr x19, [sp, #0]',
                '    ldr x20, [sp, #8]', '    ldr x21, [sp, #16]', '    ldr x30, [sp, #72]',
                '    add sp, sp, #80', '    ret', '.Loperations_thread_start_failed:',
                ...this.address('x9', 'valen_gc_workers'), '.Loperations_worker_failed_decrement:', '    ldaxr x10, [x9]',
                '    sub x11, x10, #1', '    stlxr w12, x11, [x9]', '    cbnz w12, .Loperations_worker_failed_decrement',
                '    add x0, x20, #16', '    bl valen_gc_root_pop', `    str xzr, [x19, #${threadHandle}]`,
                '    mov x0, x20', ...this.constant('x1', 1048576), '    mov x8, #215', '    svc #0',
                '    mov x0, #0', '    ldr x19, [sp, #0]', '    ldr x20, [sp, #8]', '    ldr x21, [sp, #16]',
                '    ldr x30, [sp, #72]', '    add sp, sp, #80', '    ret', '.Loperations_thread_child:',
                '    ldr x20, [sp, #0]', '    ldr x19, [sp, #8]', '    bl valen_gc_mutator_register', '    mov x0, x20',
                `    bl ${this.symbols.get(worker.name)}`, '    add x0, x19, #16', '    bl valen_gc_root_pop',
                '    bl valen_gc_mutator_unregister', ...this.address('x9', 'valen_gc_workers'),
                '.Loperations_worker_decrement:', '    ldaxr x10, [x9]', '    sub x11, x10, #1',
                '    stlxr w12, x11, [x9]', '    cbnz w12, .Loperations_worker_decrement',
                '    mov x9, #0', '    stlr w9, [x19]', '    mov x0, x19', '    mov x1, #129',
                ...this.constant('x2', 2147483647), '    mov x3, #0', '    mov x4, #0', '    mov x5, #0',
                '    mov x8, #98', '    svc #0', '    mov x0, #0', '    mov x8, #93', '    svc #0', '',
                'valen_thread_root_trace:', '    ldr x0, [x0, #8]', '    b valen_gc_mark', '');
        }
        if (has('threadJoin')) lines.push('.globl valen_Operations_threadJoin', 'valen_Operations_threadJoin:',
            '    sub sp, sp, #48', '    str x19, [sp, #0]', '    str x20, [sp, #8]', '    str x30, [sp, #40]',
            '    mov x19, x0', `    ldr x20, [x19, #${threadHandle}]`, '    cbz x20, .Loperations_thread_join_done',
            '    bl valen_gc_mutator_leave', '.Loperations_thread_join_wait:', '    ldar w10, [x20]',
            '    cbz w10, .Loperations_thread_join_ready', '    mov x0, x20', '    mov x1, #128', '    mov x2, #1',
            '    mov x3, #0', '    mov x4, #0', '    mov x5, #0', '    mov x8, #98', '    svc #0',
            '    b .Loperations_thread_join_wait', '.Loperations_thread_join_ready:', '    bl valen_gc_mutator_enter',
            `    str xzr, [x19, #${threadHandle}]`, '    mov x0, x20', ...this.constant('x1', 1048576),
            '    mov x8, #215', '    svc #0', '.Loperations_thread_join_done:', '    ldr x19, [sp, #0]',
            '    ldr x20, [sp, #8]', '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret', '');
        if (has('mutexLock')) lines.push('.globl valen_Operations_mutexLock', 'valen_Operations_mutexLock:',
            '    sub sp, sp, #32', '    str x19, [sp, #0]', '    str x30, [sp, #24]',
            `    add x19, x0, #${mutex}`, '.Loperations_mutex_retry:', '    ldaxr w10, [x19]',
            '    cbnz w10, .Loperations_mutex_wait', '    mov x11, #1', '    stlxr w12, w11, [x19]',
            '    cbnz w12, .Loperations_mutex_retry', '    ldr x19, [sp, #0]', '    ldr x30, [sp, #24]',
            '    add sp, sp, #32', '    ret', '.Loperations_mutex_wait:',
            ...(this.threading ? ['    bl valen_gc_mutator_leave'] : []),
            '    mov x0, x19', '    mov x1, #128', '    mov x2, #1', '    mov x3, #0', '    mov x4, #0',
            '    mov x5, #0', '    mov x8, #98', '    svc #0', ...(this.threading ? ['    bl valen_gc_mutator_enter'] : []),
            '    b .Loperations_mutex_retry', '');
        if (has('mutexUnlock')) lines.push('.globl valen_Operations_mutexUnlock', 'valen_Operations_mutexUnlock:',
            `    add x0, x0, #${mutex}`, '    mov x9, #0', '    stlr w9, [x0]', '    mov x1, #129',
            '    mov x2, #1', '    mov x3, #0', '    mov x4, #0', '    mov x5, #0', '    mov x8, #98', '    svc #0', '    ret', '');
        if (has('conditionWait')) lines.push('.globl valen_Operations_conditionWait', 'valen_Operations_conditionWait:',
            '    sub sp, sp, #48', '    str x19, [sp, #0]', '    str x20, [sp, #8]', '    str x30, [sp, #40]',
            '    mov x19, x0', '    mov x20, x1', `    add x9, x19, #${condition}`, '    ldar w10, [x9]',
            '    str x10, [sp, #16]', '    mov x0, x20', '    bl valen_Operations_mutexUnlock',
            ...(this.threading ? ['    bl valen_gc_mutator_leave'] : []), `    add x0, x19, #${condition}`,
            '    mov x1, #128', '    ldr x2, [sp, #16]', '    mov x3, #0',
            '    mov x4, #0', '    mov x5, #0', '    mov x8, #98', '    svc #0', '    mov x0, x20',
            ...(this.threading ? ['    bl valen_gc_mutator_enter'] : []), '    mov x0, x20', '    bl valen_Operations_mutexLock',
            '    ldr x19, [sp, #0]', '    ldr x20, [sp, #8]',
            '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret', '');
        const notify = (name, count) => lines.push(`.globl valen_Operations_${name}`, `valen_Operations_${name}:`,
            `    add x0, x0, #${condition}`, '.Loperations_condition_increment_' + name + ':', '    ldaxr w9, [x0]',
            '    add x10, x9, #1', '    stlxr w11, w10, [x0]', `    cbnz w11, .Loperations_condition_increment_${name}`,
            '    mov x1, #129', ...this.constant('x2', count), '    mov x3, #0', '    mov x4, #0', '    mov x5, #0',
            '    mov x8, #98', '    svc #0', '    ret', '');
        if (has('conditionNotifyOne')) notify('conditionNotifyOne', 1);
        if (has('conditionNotifyAll')) notify('conditionNotifyAll', 2147483647);
        if (has('atomicLoad')) lines.push('.globl valen_Operations_atomicLoad', 'valen_Operations_atomicLoad:',
            `    add x9, x0, #${atomic}`, '    ldar x0, [x9]', '    ret', '');
        if (has('atomicStore')) lines.push('.globl valen_Operations_atomicStore', 'valen_Operations_atomicStore:',
            `    add x9, x0, #${atomic}`, '    stlr x1, [x9]', '    ret', '');
        if (has('atomicExchange')) lines.push('.globl valen_Operations_atomicExchange', 'valen_Operations_atomicExchange:',
            `    add x9, x0, #${atomic}`, '.Loperations_atomic_exchange:', '    ldaxr x0, [x9]',
            '    stlxr w10, x1, [x9]', '    cbnz w10, .Loperations_atomic_exchange', '    ret', '');
        if (has('atomicCompareExchange')) lines.push('.globl valen_Operations_atomicCompareExchange',
            'valen_Operations_atomicCompareExchange:', `    add x9, x0, #${atomic}`, '.Loperations_atomic_compare:',
            '    ldaxr x10, [x9]', '    cmp x10, x1', '    b.ne .Loperations_atomic_compare_failed',
            '    stlxr w11, x2, [x9]', '    cbnz w11, .Loperations_atomic_compare', '    mov x0, #1', '    ret',
            '.Loperations_atomic_compare_failed:', '    clrex', '    mov x0, #0', '    ret', '');
        if (has('atomicAdd')) lines.push('.globl valen_Operations_atomicAdd', 'valen_Operations_atomicAdd:',
            `    add x9, x0, #${atomic}`, '.Loperations_atomic_add:', '    ldaxr x10, [x9]', '    add x0, x10, x1',
            '    stlxr w11, x0, [x9]', '    cbnz w11, .Loperations_atomic_add', '    ret', '');
        return lines;
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

    weakLoad(register, kind) {
        const id = this.runtimeLabel++;
        const live = `.Lweak_${kind}_live_${id}`;
        const done = `.Lweak_${kind}_done_${id}`;
        return [`    cbz ${register}, ${done}`, `    ldr x10, [${register}, #8]`, `    cbnz x10, ${live}`,
            `    mov ${register}, #0`, `    b ${done}`, `${live}:`, `${done}:`];
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
                `    .quad ${this.contractListLabel(type.name)}`, `    .quad ${this.objectEqualityLabel(type.name)}`,
                `    .quad ${this.objectHashLabel(type.name)}`, `    .quad ${this.objectCopyLabel(type.name)}`);
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

    structuralTypeRuntime() {
        const lines = [];
        for (const type of this.emittedTypes) lines.push(...this.objectEqualityFunction(type), ...this.objectHashFunction(type),
            ...this.objectCopyFunction(type));
        for (const type of this.arrayTypes) lines.push(...this.arrayEqualityFunction(type), ...this.arrayHashFunction(type),
            ...this.arrayCopyFunction(type), ...this.arrayOwnedSliceFunction(type));
        return lines;
    }

    structuralCoreRuntime() {
        return [
            '.globl valen_object_equal', 'valen_object_equal:', '    cmp x0, x1', '    b.eq .Lobject_equal_true',
            '    cbz x0, .Lobject_equal_false', '    cbz x1, .Lobject_equal_false', '    ldr x9, [x0, #0]',
            '    ldr x10, [x1, #0]', '    cmp x9, x10', '    b.ne .Lobject_equal_false', '    mov x11, x2',
            '.Lobject_equal_scan:', '    cbz x11, .Lobject_equal_enter', '    ldr x12, [x11, #0]',
            '    cmp x12, x0', '    b.ne .Lobject_equal_next', '    ldr x12, [x11, #8]', '    cmp x12, x1',
            '    b.eq .Lobject_equal_true', '.Lobject_equal_next:', '    ldr x11, [x11, #16]',
            '    b .Lobject_equal_scan', '.Lobject_equal_enter:', '    sub sp, sp, #48', '    str x29, [sp, #32]',
            '    str x30, [sp, #40]', '    add x29, sp, #32', '    str x0, [sp, #0]', '    str x1, [sp, #8]',
            '    str x2, [sp, #16]', '    add x2, sp, #0', '    ldr x9, [x9, #16]', '    blr x9',
            '    ldr x29, [sp, #32]', '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret',
            '.Lobject_equal_true:', '    mov x0, #1', '    ret', '.Lobject_equal_false:', '    mov x0, #0', '    ret', '',
            '.globl valen_object_hash', 'valen_object_hash:', '    cbz x0, .Lobject_hash_null', '    mov x9, x1',
            '.Lobject_hash_scan:', '    cbz x9, .Lobject_hash_enter', '    ldr x10, [x9, #0]', '    cmp x10, x0',
            '    b.eq .Lobject_hash_cycle', '    ldr x9, [x9, #8]', '    b .Lobject_hash_scan',
            '.Lobject_hash_enter:', '    sub sp, sp, #32', '    str x0, [sp, #0]', '    str x1, [sp, #8]',
            '    str x30, [sp, #24]', '    add x1, sp, #0', '    ldr x9, [x0, #0]', '    ldr x9, [x9, #24]',
            '    blr x9', '    ldr x30, [sp, #24]', '    add sp, sp, #32', '    ret',
            '.Lobject_hash_null:', '    mov x0, #0', '    ret', '.Lobject_hash_cycle:',
            ...this.constant('x0', -7046029254386353131n), '    ret', '',
            'valen_string_equal_context:', '    cmp x0, x1', '    b.eq .Lstring_context_true',
            '    cbz x0, .Lstring_context_false', '    cbz x1, .Lstring_context_false', '    b valen_string_equal',
            '.Lstring_context_true:', '    mov x0, #1', '    ret', '.Lstring_context_false:', '    mov x0, #0', '    ret', '',
            'valen_string_hash_context:', '    cbz x0, .Lstring_hash_null', '    ldr x9, [x0, #0]',
            '    ldr x10, [x0, #8]', ...this.constant('x0', 1469598103934665603n),
            ...this.constant('x12', 1099511628211n), '.Lstring_hash_next:', '    cbz x10, .Lstring_hash_done',
            '    ldrb w11, [x9, #0]', '    eor x0, x0, x11', '    mul x0, x0, x12', '    add x9, x9, #1',
            '    sub x10, x10, #1', '    b .Lstring_hash_next', '.Lstring_hash_done:', '    ret',
            '.Lstring_hash_null:', '    mov x0, #0', '    ret', ''
            , '.globl valen_copy_with_context', 'valen_copy_with_context:', '    cbz x0, .Lcopy_context_null',
            '    sub sp, sp, #64', '    str x19, [sp, #32]', '    str x20, [sp, #40]', '    str x30, [sp, #56]',
            '    mov x19, x0', '    mov x20, x1', '    str xzr, [sp, #0]', '    str xzr, [sp, #8]',
            ...this.address('x10', 'valen_copy_context_roots'),
            '    str x10, [sp, #16]', '    add x10, sp, #0', '    str x10, [sp, #24]', '    add x10, sp, #8',
            '    mov x0, x10', ...(this.threading ? ['    bl valen_gc_root_push'] : [...this.address('x9', 'valen_gc_roots'),
                '    ldr x11, [x9, #0]', '    str x11, [x10, #0]', '    str x10, [x9, #0]']),
            '    mov x0, x19', '    add x1, sp, #0', '    blr x20', '    mov x19, x0', '    add x0, sp, #8',
            ...(this.threading ? ['    bl valen_gc_root_pop'] : [...this.address('x9', 'valen_gc_roots'),
                '    ldr x10, [sp, #8]', '    str x10, [x9, #0]']), '    mov x0, x19',
            '    ldr x19, [sp, #32]', '    ldr x20, [sp, #40]', '    ldr x30, [sp, #56]', '    add sp, sp, #64',
            '    ret', '.Lcopy_context_null:', '    mov x0, #0', '    ret', '',
            '.globl valen_slice_with_context', 'valen_slice_with_context:', '    sub sp, sp, #80',
            '    str x19, [sp, #32]', '    str x20, [sp, #40]', '    str x21, [sp, #48]', '    str x22, [sp, #56]',
            '    str x30, [sp, #72]', '    mov x19, x0', '    mov x20, x1', '    mov x21, x2', '    mov x22, x3',
            '    str xzr, [sp, #0]', '    str xzr, [sp, #8]', ...this.address('x10', 'valen_copy_context_roots'),
            '    str x10, [sp, #16]', '    add x10, sp, #0', '    str x10, [sp, #24]', '    add x10, sp, #8',
            '    mov x0, x10', ...(this.threading ? ['    bl valen_gc_root_push'] : [...this.address('x9', 'valen_gc_roots'),
                '    ldr x11, [x9, #0]', '    str x11, [x10, #0]', '    str x10, [x9, #0]']),
            '    mov x0, x19', '    mov x1, x20', '    mov x2, x21', '    add x3, sp, #0', '    blr x22',
            '    mov x19, x0', '    add x0, sp, #8', ...(this.threading ? ['    bl valen_gc_root_pop'] : [
                ...this.address('x9', 'valen_gc_roots'), '    ldr x10, [sp, #8]', '    str x10, [x9, #0]']),
            '    mov x0, x19', '    ldr x19, [sp, #32]', '    ldr x20, [sp, #40]', '    ldr x21, [sp, #48]',
            '    ldr x22, [sp, #56]', '    ldr x30, [sp, #72]', '    add sp, sp, #80', '    ret', '',
            'valen_copy_context_roots:', '    sub sp, sp, #32', '    str x19, [sp, #0]', '    str x30, [sp, #24]',
            '    ldr x19, [x0, #0]', '.Lcopy_context_mark:', '    cbz x19, .Lcopy_context_mark_done',
            '    ldr x0, [x19, #8]', '    bl valen_gc_mark', '    ldr x19, [x19, #16]', '    b .Lcopy_context_mark',
            '.Lcopy_context_mark_done:', '    ldr x19, [sp, #0]', '    ldr x30, [sp, #24]', '    add sp, sp, #32',
            '    ret', '', '.globl valen_object_copy', 'valen_object_copy:', '    cbz x0, .Lobject_copy_null',
            '    ldr x9, [x1, #0]', '.Lobject_copy_scan:', '    cbz x9, .Lobject_copy_enter',
            '    ldr x10, [x9, #0]', '    cmp x10, x0', '    b.eq .Lobject_copy_found', '    ldr x9, [x9, #16]',
            '    b .Lobject_copy_scan', '.Lobject_copy_found:', '    ldr x0, [x9, #8]', '    ret',
            '.Lobject_copy_enter:', '    sub sp, sp, #16', '    str x30, [sp, #8]', '    ldr x9, [x0, #0]',
            '    ldr x9, [x9, #32]', '    blr x9', '    ldr x30, [sp, #8]', '    add sp, sp, #16', '    ret',
            '.Lobject_copy_null:', '    mov x0, #0', '    ret', '',
            'valen_string_copy_context:', '    cbz x0, .Lstring_copy_null', '    ldr x9, [x1, #0]',
            '.Lstring_copy_scan:', '    cbz x9, .Lstring_copy_enter', '    ldr x10, [x9, #0]', '    cmp x10, x0',
            '    b.eq .Lstring_copy_found', '    ldr x9, [x9, #16]', '    b .Lstring_copy_scan',
            '.Lstring_copy_found:', '    ldr x0, [x9, #8]', '    ret', '.Lstring_copy_enter:',
            '    sub sp, sp, #64', '    str x19, [sp, #0]', '    str x20, [sp, #8]', '    str x21, [sp, #16]',
            '    str x30, [sp, #56]', '    mov x19, x0', '    mov x20, x1', '    ldr x0, [x19, #8]',
            '    bl valen_string_new', '    mov x21, x0', '    mov x0, #24', '    bl valen_alloc',
            '    str x19, [x0, #0]', '    str x21, [x0, #8]', '    ldr x9, [x20, #0]', '    str x9, [x0, #16]',
            '    str x0, [x20, #0]', '    ldr x9, [x19, #0]', '    ldr x10, [x21, #0]', '    ldr x11, [x19, #8]',
            '.Lstring_copy_bytes:', '    cbz x11, .Lstring_copy_done', '    ldrb w12, [x9, #0]',
            '    strb w12, [x10, #0]', '    add x9, x9, #1', '    add x10, x10, #1', '    sub x11, x11, #1',
            '    b .Lstring_copy_bytes', '.Lstring_copy_done:', '    mov x0, x21', '    ldr x19, [sp, #0]',
            '    ldr x20, [sp, #8]', '    ldr x21, [sp, #16]', '    ldr x30, [sp, #56]', '    add sp, sp, #64',
            '    ret', '.Lstring_copy_null:', '    mov x0, #0', '    ret', ''
        ];
    }

    objectEqualityFunction(type) {
        const label = this.objectEqualityLabel(type.name), fail = `${label}_false`, done = `${label}_done`;
        const lines = [`.type ${label}, %function`, `${label}:`, '    sub sp, sp, #48', '    str x19, [sp, #0]',
            '    str x20, [sp, #8]', '    str x21, [sp, #16]', '    str x30, [sp, #40]', '    mov x19, x0',
            '    mov x20, x1', '    mov x21, x2'];
        for (const field of type.fields) {
            const offset = this.fieldOffsets.get(field.symbol).offset;
            lines.push(...this.compareFields(offset, field.type, fail));
        }
        lines.push('    mov x0, #1', `    b ${done}`, `${fail}:`, '    mov x0, #0', `${done}:`,
            '    ldr x19, [sp, #0]', '    ldr x20, [sp, #8]', '    ldr x21, [sp, #16]', '    ldr x30, [sp, #40]',
            '    add sp, sp, #48', '    ret', `.size ${label}, .-${label}`, '');
        return lines;
    }

    compareFields(offset, type, fail) {
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        if (base === 'string' || this.program.types.some(item => item.name === base)) return [
            `    ldr x0, [x19, #${offset}]`, `    ldr x1, [x20, #${offset}]`, '    mov x2, x21',
            `    bl ${this.equalityFunction(base)}`, `    cbz x0, ${fail}`];
        const register = this.valueRegister('x9', base);
        const other = this.valueRegister('x10', base);
        return [`    ${this.loadMnemonic(base)} ${register}, [x19, #${offset}]`,
            `    ${this.loadMnemonic(base)} ${other}, [x20, #${offset}]`, '    cmp x9, x10', `    b.ne ${fail}`];
    }

    compareAddresses(left, right, type, context, fail) {
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        if (base === 'string' || base.startsWith('Array<') || this.program.types.some(item => item.name === base)) return [
            `    ldr x0, [${left}, #0]`, `    ldr x1, [${right}, #0]`, `    mov x2, ${context}`,
            `    bl ${this.equalityFunction(base)}`, `    cbz x0, ${fail}`];
        return [`    ${this.loadMnemonic(base)} ${this.valueRegister('x11', base)}, [${left}, #0]`,
            `    ${this.loadMnemonic(base)} ${this.valueRegister('x12', base)}, [${right}, #0]`,
            '    cmp x11, x12', `    b.ne ${fail}`];
    }

    objectHashFunction(type) {
        const label = this.objectHashLabel(type.name);
        const lines = [`.type ${label}, %function`, `${label}:`, '    sub sp, sp, #48', '    str x19, [sp, #0]',
            '    str x20, [sp, #8]', '    str x21, [sp, #16]', '    str x30, [sp, #40]', '    mov x19, x0',
            '    mov x20, x1', ...this.constant('x21', BigInt(this.stableTypeHash(type.name)))];
        for (const field of type.fields) {
            const offset = this.fieldOffsets.get(field.symbol).offset;
            lines.push(...this.hashField(offset, field.type), '    eor x21, x21, x0',
                ...this.constant('x9', 1099511628211n), '    mul x21, x21, x9');
        }
        lines.push('    mov x0, x21', '    ldr x19, [sp, #0]', '    ldr x20, [sp, #8]', '    ldr x21, [sp, #16]',
            '    ldr x30, [sp, #40]', '    add sp, sp, #48', '    ret', `.size ${label}, .-${label}`, '');
        return lines;
    }

    hashField(offset, type) {
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        if (base === 'string' || this.program.types.some(item => item.name === base)) return [
            `    ldr x0, [x19, #${offset}]`, '    mov x1, x20', `    bl ${this.hashFunction(base)}`];
        return [`    ${this.loadMnemonic(base)} ${this.valueRegister('x0', base)}, [x19, #${offset}]`];
    }

    hashAddress(address, type, context) {
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        if (base === 'string' || base.startsWith('Array<') || this.program.types.some(item => item.name === base)) return [
            `    ldr x0, [${address}, #0]`, `    mov x1, ${context}`, `    bl ${this.hashFunction(base)}`];
        return [`    ${this.loadMnemonic(base)} ${this.valueRegister('x0', base)}, [${address}, #0]`];
    }

    arrayEqualityFunction(type) {
        const spec = this.arraySpec(type), label = this.arrayEqualityLabel(type), fail = `${label}_false`;
        const loop = `${label}_loop`, done = `${label}_done`, enter = `${label}_enter`, next = `${label}_next`;
        const lines = [`.type ${label}, %function`, `${label}:`, '    cmp x0, x1', `    b.eq ${done}_true`,
            `    cbz x0, ${fail}`, `    cbz x1, ${fail}`, '    ldr x9, [x0, #0]', '    ldr x10, [x1, #0]',
            '    cmp x9, x10', `    b.ne ${fail}`, '    mov x11, x2', `${label}_scan:`, `    cbz x11, ${enter}`,
            '    ldr x12, [x11, #0]', '    cmp x12, x0', `    b.ne ${next}`, '    ldr x12, [x11, #8]',
            '    cmp x12, x1', `    b.eq ${done}_true`, `${next}:`, '    ldr x11, [x11, #16]', `    b ${label}_scan`,
            `${enter}:`, '    sub sp, sp, #80', '    str x19, [sp, #0]', '    str x20, [sp, #8]',
            '    str x21, [sp, #16]', '    str x22, [sp, #24]', '    str x30, [sp, #72]', '    mov x19, x0',
            '    mov x20, x1', '    str x0, [sp, #32]', '    str x1, [sp, #40]', '    str x2, [sp, #48]',
            '    add x21, sp, #32', '    mov x22, #0', `${loop}:`, '    ldr x9, [x19, #0]', '    cmp x22, x9',
            `    b.cs ${done}`, '    ldr x9, [x19, #16]', `    mov x11, #${spec.size}`, '    mul x10, x22, x11',
            '    add x9, x9, x10', '    ldr x10, [x20, #16]', `    mov x12, #${spec.size}`,
            '    mul x11, x22, x12', '    add x10, x10, x11'];
        lines.push(...this.compareAddresses('x9', 'x10', spec.ownership === 'owned' ? spec.element : 'u64', 'x21', `${fail}_frame`),
            '    add x22, x22, #1', `    b ${loop}`, `${done}:`, '    mov x0, #1', `    b ${done}_frame`,
            `${fail}_frame:`, '    mov x0, #0', `${done}_frame:`, '    ldr x19, [sp, #0]', '    ldr x20, [sp, #8]',
            '    ldr x21, [sp, #16]', '    ldr x22, [sp, #24]', '    ldr x30, [sp, #72]', '    add sp, sp, #80',
            '    ret', `${done}_true:`, '    mov x0, #1', '    ret', `${fail}:`, '    mov x0, #0', '    ret',
            `.size ${label}, .-${label}`, '');
        return lines;
    }

    arrayHashFunction(type) {
        const spec = this.arraySpec(type), label = this.arrayHashLabel(type), loop = `${label}_loop`, done = `${label}_done`;
        const lines = [`.type ${label}, %function`, `${label}:`, `    cbz x0, ${done}_null`, '    mov x9, x1',
            `${label}_scan:`, `    cbz x9, ${label}_enter`, '    ldr x10, [x9, #0]', '    cmp x10, x0',
            `    b.eq ${done}_cycle`, '    ldr x9, [x9, #8]', `    b ${label}_scan`, `${label}_enter:`,
            '    sub sp, sp, #80', '    str x19, [sp, #0]', '    str x20, [sp, #8]', '    str x21, [sp, #16]',
            '    str x22, [sp, #24]', '    str x30, [sp, #72]', '    mov x19, x0', '    str x0, [sp, #32]',
            '    str x1, [sp, #40]', '    add x20, sp, #32', '    mov x21, #0',
            ...this.constant('x22', 1469598103934665603n), `${loop}:`, '    ldr x9, [x19, #0]', '    cmp x21, x9',
            `    b.cs ${done}`, '    ldr x9, [x19, #16]', `    mov x11, #${spec.size}`, '    mul x10, x21, x11',
            '    add x9, x9, x10', ...this.hashAddress('x9', spec.ownership === 'owned' ? spec.element : 'u64', 'x20'),
            '    eor x22, x22, x0', ...this.constant('x9', 1099511628211n), '    mul x22, x22, x9',
            '    add x21, x21, #1', `    b ${loop}`, `${done}:`, '    mov x0, x22', '    ldr x19, [sp, #0]',
            '    ldr x20, [sp, #8]', '    ldr x21, [sp, #16]', '    ldr x22, [sp, #24]', '    ldr x30, [sp, #72]',
            '    add sp, sp, #80', '    ret', `${done}_null:`, '    mov x0, #0', '    ret', `${done}_cycle:`,
            ...this.constant('x0', -7046029254386353131n), '    ret', `.size ${label}, .-${label}`, ''];
        return lines;
    }

    objectCopyFunction(type) {
        const label = this.objectCopyLabel(type.name);
        const lines = [`.type ${label}, %function`, `${label}:`, '    sub sp, sp, #64', '    str x19, [sp, #0]',
            '    str x20, [sp, #8]', '    str x21, [sp, #16]', '    str x30, [sp, #56]', '    mov x19, x0',
            '    mov x20, x1', ...this.constant('x0', this.typeSizes.get(type.name) ?? 16),
            ...this.address('x1', this.gcTypeTraceLabel(type.name)), ...this.gcTypeWeakAddress('x2', type.name),
            ...this.constant('x3', 0), '    bl valen_gc_alloc', '    mov x21, x0', '    ldr x9, [x19, #0]',
            '    str x9, [x21, #0]', '    mov x9, #1', '    str x9, [x21, #8]', '    mov x0, #24',
            '    bl valen_alloc', '    str x19, [x0, #0]', '    str x21, [x0, #8]', '    ldr x9, [x20, #0]',
            '    str x9, [x0, #16]', '    str x0, [x20, #0]'];
        for (const field of type.fields) {
            const offset = this.fieldOffsets.get(field.symbol).offset;
            lines.push(...this.copyAddress(`x19, #${offset}`, field.type, 'x20'),
                `    ${this.storeMnemonic(field.type)} ${this.valueRegister('x0', field.type)}, [x21, #${offset}]`);
        }
        lines.push('    mov x0, x21', '    ldr x19, [sp, #0]', '    ldr x20, [sp, #8]', '    ldr x21, [sp, #16]',
            '    ldr x30, [sp, #56]', '    add sp, sp, #64', '    ret', `.size ${label}, .-${label}`, '');
        return lines;
    }

    copyAddress(address, type, context) {
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        if (base === 'string' || base.startsWith('Array<') || this.program.types.some(item => item.name === base)) return [
            `    ldr x0, [${address}]`, `    mov x1, ${context}`, `    bl ${this.copyFunction(base)}`];
        return [`    ${this.loadMnemonic(base)} ${this.valueRegister('x0', base)}, [${address}]`];
    }

    arrayCopyFunction(type) {
        const spec = this.arraySpec(type), label = this.arrayCopyLabel(type), loop = `${label}_loop`, done = `${label}_done`;
        const lines = [`.type ${label}, %function`, `${label}:`, `    cbz x0, ${done}_null`, '    ldr x9, [x1, #0]',
            `${label}_scan:`, `    cbz x9, ${label}_enter`, '    ldr x10, [x9, #0]', '    cmp x10, x0',
            `    b.eq ${label}_found`, '    ldr x9, [x9, #16]', `    b ${label}_scan`, `${label}_found:`,
            '    ldr x0, [x9, #8]', '    ret', `${label}_enter:`, '    sub sp, sp, #80', '    str x19, [sp, #0]',
            '    str x20, [sp, #8]', '    str x21, [sp, #16]', '    str x22, [sp, #24]', '    str x30, [sp, #72]',
            '    mov x19, x0', '    mov x20, x1', `    mov x0, #${spec.size}`, '    ldr x1, [x19, #0]',
            ...this.gcArrayAddress('x2', type, false), ...this.gcArrayAddress('x3', type, true),
            '    bl valen_array_new', '    mov x21, x0', '    mov x0, #24', '    bl valen_alloc',
            '    str x19, [x0, #0]', '    str x21, [x0, #8]', '    ldr x9, [x20, #0]', '    str x9, [x0, #16]',
            '    str x0, [x20, #0]', '    mov x22, #0', `${loop}:`, '    ldr x9, [x19, #0]', '    cmp x22, x9',
            `    b.cs ${done}`, '    ldr x9, [x19, #16]', `    mov x10, #${spec.size}`, '    mul x10, x22, x10',
            '    add x9, x9, x10'];
        lines.push(...this.copyAddress('x9, #0', spec.ownership === 'owned' ? spec.element : 'u64', 'x20'),
            '    ldr x9, [x21, #16]', `    mov x10, #${spec.size}`, '    mul x10, x22, x10', '    add x9, x9, x10',
            `    ${this.storeMnemonic(spec.element)} ${this.valueRegister('x0', spec.element)}, [x9, #0]`,
            '    add x22, x22, #1', `    b ${loop}`, `${done}:`, '    mov x0, x21', '    ldr x19, [sp, #0]',
            '    ldr x20, [sp, #8]', '    ldr x21, [sp, #16]', '    ldr x22, [sp, #24]', '    ldr x30, [sp, #72]',
            '    add sp, sp, #80', '    ret', `${done}_null:`, '    mov x0, #0', '    ret',
            `.size ${label}, .-${label}`, '');
        return lines;
    }

    arrayOwnedSliceFunction(type) {
        const spec = this.arraySpec(type);
        if (spec.ownership !== 'owned' || !spec.managed) return [];
        const label = this.arraySliceLabel(type), loop = `${label}_loop`, done = `${label}_done`;
        const lines = [`.type ${label}, %function`, `${label}:`, '    cmp x1, #0', '    b.lt .Larray_bounds_error',
            '    cmp x2, #0', '    b.lt .Larray_bounds_error', '    add x9, x1, x2', '    cmp x9, x1',
            '    b.cc .Larray_bounds_error', '    ldr x10, [x0, #0]', '    cmp x9, x10', '    b.hi .Larray_bounds_error',
            '    sub sp, sp, #112', '    str x19, [sp, #0]', '    str x20, [sp, #8]', '    str x21, [sp, #16]',
            '    str x22, [sp, #24]', '    str x23, [sp, #32]', '    str x24, [sp, #40]', '    str x30, [sp, #104]',
            '    mov x19, x0', '    mov x20, x1', '    mov x21, x2', '    mov x22, x3', `    mov x0, #${spec.size}`,
            '    mov x1, x21', ...this.gcArrayAddress('x2', type, false), ...this.gcArrayAddress('x3', type, true),
            '    bl valen_array_new', '    mov x23, x0', '    mov x0, #24', '    bl valen_alloc',
            '    str x19, [x0, #0]', '    str x23, [x0, #8]', '    ldr x9, [x22, #0]', '    str x9, [x0, #16]',
            '    str x0, [x22, #0]', '    mov x24, #0', `${loop}:`, '    cmp x24, x21', `    b.cs ${done}`,
            '    add x9, x20, x24', `    mov x10, #${spec.size}`, '    mul x9, x9, x10', '    ldr x10, [x19, #16]',
            '    add x9, x10, x9', ...this.copyAddress('x9, #0', spec.element, 'x22'), '    ldr x9, [x23, #16]',
            `    mov x10, #${spec.size}`, '    mul x10, x24, x10', '    add x9, x9, x10',
            `    ${this.storeMnemonic(spec.element)} ${this.valueRegister('x0', spec.element)}, [x9, #0]`,
            '    add x24, x24, #1', `    b ${loop}`, `${done}:`, '    mov x0, x23', '    ldr x19, [sp, #0]',
            '    ldr x20, [sp, #8]', '    ldr x21, [sp, #16]', '    ldr x22, [sp, #24]', '    ldr x23, [sp, #32]',
            '    ldr x24, [sp, #40]', '    ldr x30, [sp, #104]', '    add sp, sp, #112', '    ret',
            `.size ${label}, .-${label}`, ''];
        return lines;
    }

    stableTypeHash(name) {
        let hash = 1469598103934665603n;
        for (const byte of new TextEncoder().encode(name)) hash = BigInt.asIntN(64, (hash ^ BigInt(byte)) * 1099511628211n);
        return hash.toString();
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

    gcTypeFunctions(types) {
        const lines = [];
        for (const type of types) {
            const trace = this.gcTypeTraceLabel(type.name);
            const strong = type.fields.filter(field => field.ownership !== 'member-weak' &&
                this.isManagedReferenceType(field.type));
            lines.push(`.type ${trace}, %function`, `${trace}:`, '    ldr x9, [x0, #8]',
                `    cbz x9, ${trace}_done`, '    sub sp, sp, #32', '    str x30, [sp, #24]',
                '    str x0, [sp, #16]');
            for (const field of strong) {
                const offset = this.fieldOffsets.get(field.symbol).offset;
                lines.push('    ldr x9, [sp, #16]', `    ldr x0, [x9, #${offset}]`, '    bl valen_gc_mark');
            }
            lines.push('    ldr x30, [sp, #24]', '    add sp, sp, #32', `${trace}_done:`, '    ret',
                `.size ${trace}, .-${trace}`, '');
            const weak = type.fields.filter(field => field.ownership === 'member-weak' &&
                this.isManagedReferenceType(field.type));
            if (weak.length === 0) continue;
            const callback = this.gcTypeWeakLabel(type.name);
            lines.push(`.type ${callback}, %function`, `${callback}:`, '    sub sp, sp, #32',
                '    str x30, [sp, #24]', '    str x0, [sp, #16]');
            for (const field of weak) {
                const offset = this.fieldOffsets.get(field.symbol).offset;
                const keep = `${callback}_keep_${offset}`;
                lines.push('    ldr x9, [sp, #16]', `    ldr x0, [x9, #${offset}]`, '    bl valen_gc_is_marked',
                    `    cbnz x0, ${keep}`, '    ldr x9, [sp, #16]', `    str xzr, [x9, #${offset}]`, `${keep}:`);
            }
            lines.push('    ldr x30, [sp, #24]', '    add sp, sp, #32', '    ret',
                `.size ${callback}, .-${callback}`, '');
        }
        return lines;
    }

    gcArrayFunctions(types) {
        const lines = [];
        for (const type of types) {
            const spec = this.arraySpec(type);
            if (!spec.managed) continue;
            if (spec.ownership === 'weak') {
                const callback = this.gcArrayWeakLabel(type);
                lines.push(`.type ${callback}, %function`, `${callback}:`, '    ldr x9, [x0, #32]',
                    `    cbz x9, ${callback}_done`, '    sub sp, sp, #48', '    str x30, [sp, #40]',
                    '    str x0, [sp, #32]', '    str xzr, [sp, #24]', `${callback}_loop:`,
                    '    ldr x9, [sp, #32]', '    ldr x10, [sp, #24]', '    ldr x11, [x9, #0]',
                    `    cmp x10, x11`, `    b.cs ${callback}_finish`, '    ldr x9, [x9, #16]',
                    `    mov x11, #${spec.size}`, '    mul x10, x10, x11', '    add x9, x9, x10',
                    '    ldr x0, [x9, #0]', '    bl valen_gc_is_marked', `    cbnz x0, ${callback}_next`,
                    '    ldr x9, [sp, #32]', '    ldr x10, [sp, #24]', '    ldr x9, [x9, #16]',
                    `    mov x11, #${spec.size}`, '    mul x10, x10, x11', '    add x9, x9, x10',
                    '    str xzr, [x9, #0]', `${callback}_next:`, '    ldr x10, [sp, #24]',
                    '    add x10, x10, #1', '    str x10, [sp, #24]', `    b ${callback}_loop`,
                    `${callback}_finish:`, '    ldr x30, [sp, #40]', '    add sp, sp, #48',
                    `${callback}_done:`, '    ret', `.size ${callback}, .-${callback}`, '');
                continue;
            }
            const callback = this.gcArrayTraceLabel(type);
            lines.push(`.type ${callback}, %function`, `${callback}:`, '    ldr x9, [x0, #32]',
                `    cbz x9, ${callback}_done`, '    sub sp, sp, #48', '    str x30, [sp, #40]',
                '    str x0, [sp, #32]', '    str xzr, [sp, #24]', `${callback}_loop:`,
                '    ldr x9, [sp, #32]', '    ldr x10, [sp, #24]', '    ldr x11, [x9, #0]',
                `    cmp x10, x11`, `    b.cs ${callback}_finish`, '    ldr x9, [x9, #16]',
                `    mov x11, #${spec.size}`, '    mul x10, x10, x11', '    add x9, x9, x10', '    ldr x0, [x9, #0]',
                '    bl valen_gc_mark', '    ldr x10, [sp, #24]', '    add x10, x10, #1',
                '    str x10, [sp, #24]', `    b ${callback}_loop`, `${callback}_finish:`,
                '    ldr x30, [sp, #40]', '    add sp, sp, #48', `${callback}_done:`, '    ret',
                `.size ${callback}, .-${callback}`, '');
        }
        return lines;
    }

    arraySpec(type) {
        let element = type.slice('Array<'.length, -1), ownership = 'owned';
        if (element.startsWith('ref ')) { ownership = 'ref'; element = element.slice(4); }
        else if (element.startsWith('weak ')) { ownership = 'weak'; element = element.slice(5); }
        return {element, ownership, managed: this.isManagedReferenceType(element), size: this.sizeOf(element)};
    }

    gcTypeTraceLabel(type) { return `${this.typeLabel(type)}_gc_trace`; }
    gcTypeWeakLabel(type) { return `${this.typeLabel(type)}_gc_weak`; }
    gcArrayTraceLabel(type) { return `.Lvalen_array_${this.mangle(type)}_gc_trace`; }
    gcArrayWeakLabel(type) { return `.Lvalen_array_${this.mangle(type)}_gc_weak`; }

    gcTypeWeakAddress(register, typeName) {
        const type = this.program.types.find(candidate => candidate.name === typeName);
        return type?.fields.some(field => field.ownership === 'member-weak' && this.isManagedReferenceType(field.type))
            ? this.address(register, this.gcTypeWeakLabel(typeName)) : this.constant(register, 0);
    }

    gcArrayAddress(register, typeName, weak) {
        const spec = typeName?.startsWith('Array<') ? this.arraySpec(typeName) : null;
        const enabled = spec?.managed && (weak ? spec.ownership === 'weak' : spec.ownership !== 'weak');
        return enabled ? this.address(register, weak ? this.gcArrayWeakLabel(typeName) : this.gcArrayTraceLabel(typeName))
            : this.constant(register, 0);
    }

    gcData() {
        return ['.section .data', '.align 8', '.globl valen_gc_roots', 'valen_gc_roots:', '    .quad 0',
            '.globl valen_gc_heap', 'valen_gc_heap:', '    .quad 0', '.globl valen_gc_bytes',
            'valen_gc_bytes:', '    .quad 0', '.globl valen_gc_threshold', 'valen_gc_threshold:',
            '    .quad 1048576', '.globl valen_gc_lock', 'valen_gc_lock:', '    .quad 0',
            '.globl valen_gc_state_guard', 'valen_gc_state_guard:', '    .quad 0',
            '.globl valen_gc_workers', 'valen_gc_workers:', '    .quad 0',
            '.globl valen_gc_mutators', 'valen_gc_mutators:', '    .quad 0',
            '.globl valen_gc_parked', 'valen_gc_parked:', '    .quad 0',
            '.globl valen_gc_request', 'valen_gc_request:', '    .quad 0',
            '.globl valen_gc_target', 'valen_gc_target:', '    .quad 0',
            '.globl valen_gc_collecting', 'valen_gc_collecting:', '    .quad 0',
            '.globl valen_filesystem_error', 'valen_filesystem_error:', '    .quad 0',
            '.globl valen_process_argc', 'valen_process_argc:', '    .quad 0', '.globl valen_process_argv',
            'valen_process_argv:', '    .quad 0', '.globl valen_process_envp', 'valen_process_envp:', '    .quad 0',
            '.globl valen_network_error', 'valen_network_error:', '    .quad 0', '.text'];
    }

    testData() {
        return ['.section .data', 'valen_test_failure_message:',
            '    .byte 116, 101, 115, 116, 32, 102, 97, 105, 108, 101, 100, 10',
            '.section .data', '.align 8', 'valen_test_failures:', '    .quad 0', '.text'];
    }

    typeLabel(typeName) { return `.Lvalen_type_${this.mangle(typeName)}`; }
    contractListLabel(typeName) { return `${this.typeLabel(typeName)}_contracts`; }
    contractTableLabel(typeName, contractName) { return `${this.typeLabel(typeName)}_as_${this.mangle(contractName)}`; }
    objectEqualityLabel(typeName) { return `${this.typeLabel(typeName)}_equal`; }
    objectHashLabel(typeName) { return `${this.typeLabel(typeName)}_hash`; }
    objectCopyLabel(typeName) { return `${this.typeLabel(typeName)}_copy`; }
    arrayEqualityLabel(typeName) { return `.Lvalen_array_equal_${this.mangle(typeName)}`; }
    arrayHashLabel(typeName) { return `.Lvalen_array_hash_${this.mangle(typeName)}`; }
    arrayCopyLabel(typeName) { return `.Lvalen_array_copy_${this.mangle(typeName)}`; }
    arraySliceLabel(typeName) { return `.Lvalen_array_slice_${this.mangle(typeName)}`; }

    equalityFunction(typeName) {
        const type = typeName?.endsWith('?') ? typeName.slice(0, -1) : typeName;
        if (type === 'string') return 'valen_string_equal_context';
        if (type?.startsWith('Array<')) return this.arrayEqualityLabel(type);
        return 'valen_object_equal';
    }

    hashFunction(typeName) {
        const type = typeName?.endsWith('?') ? typeName.slice(0, -1) : typeName;
        if (type === 'string') return 'valen_string_hash_context';
        if (type?.startsWith('Array<')) return this.arrayHashLabel(type);
        return 'valen_object_hash';
    }

    copyFunction(typeName) {
        const type = typeName?.endsWith('?') ? typeName.slice(0, -1) : typeName;
        if (type === 'string') return 'valen_string_copy_context';
        if (type?.startsWith('Array<')) return this.arrayCopyLabel(type);
        return 'valen_object_copy';
    }

    structuralArrayTypes(functions = this.program.functions) {
        const types = new Set();
        const add = type => {
            const base = type?.endsWith('?') ? type.slice(0, -1) : type;
            if (!base?.startsWith('Array<') || types.has(base)) return;
            types.add(base);
            const spec = this.arraySpec(base);
            add(spec.element);
        };
        for (const type of this.program.types) for (const field of type.fields) add(field.type);
        for (const fn of functions) for (const block of fn.blocks) for (const instruction of block.instructions) {
            add(instruction.type);
            add(instruction.valueType);
            add(instruction.arrayType);
            add(instruction.objectType);
        }
        return types;
    }

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
    isPrimitiveOptional(type) {
        return type?.endsWith('?') && ['bool', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64']
            .includes(type.slice(0, -1));
    }
    isManagedReferenceType(type) {
        if (!type) return false;
        const base = type.endsWith('?') ? type.slice(0, -1) : type;
        return base === 'string' || base === 'StringBuilder' || base.startsWith('Array<') || this.typeSizes.has(base) ||
            this.isPrimitiveOptional(type);
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
