import {prepareIr} from './ir-validation.js';

const argumentRegisters = Array.from({length: 8}, (_, index) => `x${index}`);
const floatArgumentRegisters = Array.from({length: 8}, (_, index) => index);

/** Initial AArch64 backend for primitive programs. */
export class AArch64Backend {
    generate(program, {optimizationLevel = 1, moduleId = null, includeRuntime = true} = {}) {
        if (![0, 1].includes(optimizationLevel)) throw new Error(`Unsupported optimization level '-O${optimizationLevel}'`);
        prepareIr(program, {optimize: optimizationLevel === 1, requireEntry: includeRuntime});
        if (program.externals.length) throw new Error('aarch64-linux bootstrap backend does not yet support native or foreign calls');
        if (program.types.some(type => type.fields.length || type.initializer)) {
            throw new Error('aarch64-linux bootstrap backend does not yet support object fields or initializers');
        }
        this.program = program;
        this.symbols = new Map(program.functions.map(fn => [fn.name, this.mangle(fn.name)]));
        const functions = (moduleId === null ? program.functions : program.functions.filter(fn => fn.moduleId === moduleId));
        const lines = ['.text'];
        for (const fn of functions) lines.push(...this.generateFunction(fn));
        if (includeRuntime) lines.push(...this.generateStart());
        lines.push('.Ldivision_by_zero_error:', '    mov x0, #73', '    mov x8, #93', '    svc #0', '');
        lines.push('.section .note.GNU-stack,"",@progbits');
        return `${lines.join('\n')}\n`;
    }

    generateFunction(fn) {
        this.fn = fn;
        this.slots = new Map();
        let slotCount = 0;
        const reserve = key => { if (!this.slots.has(key)) this.slots.set(key, slotCount++ * 8); };
        for (const parameter of fn.parameters) reserve(`name:${parameter.name}`);
        for (const instruction of fn.blocks.flatMap(block => block.instructions)) {
            if (instruction.result) reserve(`temp:${instruction.result}`);
            if (instruction.op === 'declare_local' || instruction.op === 'store_local') reserve(`name:${instruction.name}`);
        }
        const frameSize = this.align(slotCount * 8, 16);
        if (frameSize > 4080) throw new Error(`aarch64-linux bootstrap backend function '${fn.displayName}' needs an unsupported large stack frame`);
        const total = frameSize + 16;
        const symbol = this.symbols.get(fn.name);
        const end = `${symbol}__return`;
        const lines = [`.globl ${symbol}`, `.type ${symbol}, %function`, `${symbol}:`, `    sub sp, sp, #${total}`,
            `    str x29, [sp, #${frameSize}]`, `    str x30, [sp, #${frameSize + 8}]`, `    add x29, sp, #${frameSize}`];
        for (const location of this.argumentLocations(fn.parameters)) {
            if (location.kind === 'stack') throw new Error('aarch64-linux bootstrap backend does not yet support stack-passed arguments');
            if (location.kind === 'float') lines.push(
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
            case 'declare_local':
                return instruction.value
                    ? [...this.load(instruction.value, 'x9'), `    str x9, ${this.named(instruction.name)}`]
                    : ['    str xzr, ' + this.named(instruction.name)];
            case 'load_local':
                return [`    ldr x9, ${this.named(instruction.name)}`, `    str x9, ${this.temp(instruction.result)}`];
            case 'store_local':
                return [...this.load(instruction.value, 'x9'), `    str x9, ${this.named(instruction.name)}`];
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
            case 'call':
            case 'virtual_call': {
                const lines = [];
                for (const location of this.argumentLocations(instruction.arguments)) {
                    if (location.kind === 'stack') throw new Error('aarch64-linux bootstrap backend does not yet support stack-passed arguments');
                    if (location.kind === 'float') lines.push(...this.load(location.value, 'x9'),
                        `    fmov ${location.value.type === 'f32' ? 's' : 'd'}${location.register}, ${location.value.type === 'f32' ? 'w9' : 'x9'}`);
                    else lines.push(...this.load(location.value, location.register));
                }
                const target = this.symbols.get(instruction.target);
                if (!target) throw new Error(`aarch64-linux bootstrap backend has no function symbol for '${instruction.target}'`);
                lines.push(`    bl ${target}`);
                if (instruction.result && this.isFloat(instruction.type)) lines.push(
                    `    fmov ${instruction.type === 'f32' ? 'w9' : 'x9'}, ${instruction.type === 'f32' ? 's0' : 'd0'}`,
                    `    str x9, ${this.temp(instruction.result)}`);
                else if (instruction.result) lines.push(...this.normalize('x0', instruction.type), `    str x0, ${this.temp(instruction.result)}`);
                return lines;
            }
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
        } else if (this.isFloat(from)) throw new Error('aarch64-linux bootstrap backend does not yet support checked floating-point to integer conversion');
        else lines.push(...this.normalize('x9', to));
        lines.push(`    str x9, ${this.temp(instruction.result)}`);
        return lines;
    }

    generateStart() {
        const entry = this.program.functions.find(fn => fn.name === this.program.entry);
        if (!entry) throw new Error('Program has no entry.__ method');
        if (entry.owner && this.program.types.find(type => type.name === entry.owner)?.fields.length) {
            throw new Error('aarch64-linux bootstrap backend cannot construct an entry object with fields yet');
        }
        return ['.globl _start', '.type _start, %function', '_start:', '    mov x0, #0', `    bl ${this.symbols.get(entry.name)}`,
            '    mov x8, #93', '    svc #0', '.size _start, .-_start', ''];
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
        let general = 0, floating = 0;
        return values.map(value => {
            if (this.isFloat(value.type) && floating < floatArgumentRegisters.length) {
                return {kind: 'float', register: floatArgumentRegisters[floating++], value};
            }
            if (!this.isFloat(value.type) && general < argumentRegisters.length) {
                return {kind: 'general', register: argumentRegisters[general++], value};
            }
            return {kind: 'stack', value};
        });
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

    mangle(value) {
        let result = '__valen_';
        for (const byte of Buffer.from(value)) {
            const character = String.fromCharCode(byte);
            result += /[A-Za-z0-9]/.test(character) ? character : `_${byte.toString(16).padStart(2, '0')}_`;
        }
        return result;
    }
}
