import {prepareIr} from './ir-validation.js';

const argumentRegisters = Array.from({length: 8}, (_, index) => `x${index}`);

/** Initial AArch64 backend for primitive integer/control-flow programs. */
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
        fn.parameters.forEach((parameter, index) => {
            if (index >= argumentRegisters.length) throw new Error('aarch64-linux bootstrap backend does not yet support stack-passed arguments');
            lines.push(`    str ${argumentRegisters[index]}, ${this.named(parameter.name)}`);
        });
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
                return [...this.constant('x9', instruction.value), `    str x9, ${this.temp(instruction.result)}`];
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
                if (instruction.operator === '-') lines.push('    neg x9, x9');
                else if (instruction.operator === '!') lines.push('    cmp x9, #0', '    cset x9, eq');
                else throw new Error(`aarch64-linux bootstrap backend does not support unary '${instruction.operator}'`);
                lines.push(`    str x9, ${this.temp(instruction.result)}`);
                return lines;
            }
            case 'binary':
                return this.binary(instruction);
            case 'call': {
                if (instruction.arguments.length > argumentRegisters.length) throw new Error('aarch64-linux bootstrap backend does not yet support stack-passed arguments');
                const lines = [];
                instruction.arguments.forEach((argument, index) => lines.push(...this.load(argument, argumentRegisters[index])));
                const target = this.symbols.get(instruction.target);
                if (!target) throw new Error(`aarch64-linux bootstrap backend has no function symbol for '${instruction.target}'`);
                lines.push(`    bl ${target}`);
                if (instruction.result) lines.push(`    str x0, ${this.temp(instruction.result)}`);
                return lines;
            }
            case 'jump':
                return [`    b ${this.blockLabel(instruction.target)}`];
            case 'branch':
                return [...this.load(instruction.condition, 'x9'), `    cbnz x9, ${this.blockLabel(instruction.thenTarget)}`,
                    `    b ${this.blockLabel(instruction.elseTarget)}`];
            case 'return':
                return instruction.value ? [...this.load(instruction.value, 'x0'), `    b ${end}`] : ['    mov x0, #0', `    b ${end}`];
            default:
                throw new Error(`aarch64-linux bootstrap backend does not yet support IR operation '${instruction.op}'`);
        }
    }

    binary(instruction) {
        const lines = [...this.load(instruction.left, 'x9'), ...this.load(instruction.right, 'x10')];
        const operation = {'+': 'add', '-': 'sub', '*': 'mul', '&&': 'and', '||': 'orr', '&': 'and', '|': 'orr', '^': 'eor',
            '<<': 'lsl', '>>': this.isUnsigned(instruction.left.type) ? 'lsr' : 'asr'}[instruction.operator];
        const signedCondition = {'==': 'eq', '!=': 'ne', '===': 'eq', '!==': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge'};
        const unsignedCondition = {'<': 'cc', '<=': 'ls', '>': 'hi', '>=': 'cs'};
        const condition = this.isUnsigned(instruction.left.type) && unsignedCondition[instruction.operator]
            ? unsignedCondition[instruction.operator] : signedCondition[instruction.operator];
        if (operation) lines.push(`    ${operation} x9, x9, x10`);
        else if (condition) lines.push('    cmp x9, x10', `    cset x9, ${condition}`);
        else throw new Error(`aarch64-linux bootstrap backend does not yet support binary '${instruction.operator}'`);
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
        if (value.kind !== 'temporary') throw new Error(`aarch64-linux bootstrap backend cannot load '${value.kind}' values yet`);
        return [`    ldr ${register}, ${this.temp(value.name)}`];
    }

    constant(register, value) {
        const integer = BigInt(value);
        if (integer < -65535n || integer > 65535n) throw new Error(`aarch64-linux bootstrap backend constant ${integer} is not implemented yet`);
        return [`    mov ${register}, #${integer}`];
    }

    temp(name) { return `[sp, #${this.slots.get(`temp:${name}`)}]`; }
    named(name) { return `[sp, #${this.slots.get(`name:${name}`)}]`; }
    blockLabel(label) { return `${this.symbols.get(this.fn.name)}__${this.mangle(label)}`; }
    align(value, alignment) { return Math.ceil(value / alignment) * alignment; }
    isUnsigned(type) { return type === 'bool' || type?.startsWith('u'); }

    mangle(value) {
        let result = '__valen_';
        for (const byte of Buffer.from(value)) {
            const character = String.fromCharCode(byte);
            result += /[A-Za-z0-9]/.test(character) ? character : `_${byte.toString(16).padStart(2, '0')}_`;
        }
        return result;
    }
}
