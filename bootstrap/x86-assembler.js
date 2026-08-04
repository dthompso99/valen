import {ElfObject, Elf} from './elf.js';

const registerNames = [
    ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil', 'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b'],
    ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di', 'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w'],
    ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'],
    ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15']
];
const sizeBytes = [1, 2, 4, 8];
const registers = new Map();
registerNames.forEach((names, sizeIndex) => names.forEach((name, code) => registers.set(name, {kind: 'reg', name, code, size: sizeBytes[sizeIndex]})));
for (let code = 0; code < 16; code++) registers.set(`xmm${code}`, {kind: 'xmm', name: `xmm${code}`, code, size: 16});

const conditionCodes = {
    jo: 0, jno: 1, jb: 2, jc: 2, jae: 3, je: 4, jz: 4, jne: 5, jnz: 5, jbe: 6, ja: 7,
    js: 8, jns: 9, jp: 10, jnp: 11, jl: 12, jge: 13, jle: 14, jg: 15
};
const setConditionCodes = {
    seto: 0, setno: 1, setb: 2, setc: 2, setae: 3, sete: 4, setz: 4, setne: 5, setnz: 5,
    setbe: 6, seta: 7, sets: 8, setns: 9, setp: 10, setnp: 11, setl: 12, setge: 13, setle: 14, setg: 15
};
const cmovConditionCodes = {cmovb: 2, cmovae: 3, cmove: 4, cmovne: 5, cmovbe: 6, cmova: 7, cmovl: 12, cmovge: 13, cmovle: 14, cmovg: 15, cmovnz: 5};

function integer(value) {
    if (!/^-?(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) return null;
    return BigInt(value);
}

function splitOperands(value) {
    const result = [];
    let start = 0, depth = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] === '[') depth++;
        if (value[index] === ']') depth--;
        if (value[index] === ',' && depth === 0) {
            result.push(value.slice(start, index).trim());
            start = index + 1;
        }
    }
    if (value.slice(start).trim()) result.push(value.slice(start).trim());
    return result;
}

function parseMemory(value, explicitSize) {
    const match = value.match(/^\[(.*)]$/);
    if (!match) return null;
    const expression = match[1].replace(/-/g, '+-');
    const parts = expression.split('+').filter(Boolean);
    const memory = {kind: 'mem', size: explicitSize, base: null, index: null, scale: 1, displacement: 0n, symbol: null};
    for (const part of parts) {
        if (part === 'rip') { memory.base = {name: 'rip', code: 5}; continue; }
        const scaled = part.match(/^([a-z][a-z0-9]*)\*([1248])$/i);
        if (scaled) {
            memory.index = registers.get(scaled[1]);
            memory.scale = Number(scaled[2]);
            continue;
        }
        const register = registers.get(part);
        if (register) {
            if (!memory.base) memory.base = register;
            else memory.index = register;
            continue;
        }
        const number = integer(part);
        if (number !== null) memory.displacement += number;
        else memory.symbol = part;
    }
    return memory;
}

function parseOperand(value) {
    let explicitSize = null;
    const sized = value.match(/^(BYTE|WORD|DWORD|QWORD) PTR (.*)$/);
    if (sized) {
        explicitSize = {BYTE: 1, WORD: 2, DWORD: 4, QWORD: 8}[sized[1]];
        value = sized[2];
    }
    const memory = parseMemory(value, explicitSize);
    if (memory) return memory;
    const register = registers.get(value);
    if (register) return register;
    const number = integer(value);
    if (number !== null) return {kind: 'imm', value: number};
    return {kind: 'symbol', name: value};
}

function little(value, size) {
    const output = Buffer.alloc(size);
    let normalized = BigInt.asUintN(size * 8, BigInt(value));
    for (let index = 0; index < size; index++) {
        output[index] = Number(normalized & 255n);
        normalized >>= 8n;
    }
    return [...output];
}

class CodeSink {
    constructor(section, offset, symbols, relocations, sizing = false) {
        this.section = section;
        this.offset = offset;
        this.symbols = symbols;
        this.relocations = relocations;
        this.sizing = sizing;
        this.bytes = [];
    }

    emit(...bytes) { this.bytes.push(...bytes.flat()); }
    relocation(symbol, type, addend, fieldOffset = this.bytes.length) {
        if (!this.sizing) this.relocations.push({section: this.section, offset: this.offset + fieldOffset, symbol, type, addend});
    }
}

function rex(sink, {w = false, r = 0, x = 0, b = 0, force = false} = {}) {
    const value = 0x40 | (w ? 8 : 0) | ((r >> 3) << 2) | ((x >> 3) << 1) | (b >> 3);
    if (value !== 0x40 || force) sink.emit(value);
}

function operandPrefix(sink, size) {
    if (size === 2) sink.emit(0x66);
}

function encodeModRm(sink, regCode, operand) {
    if (operand.kind === 'reg' || operand.kind === 'xmm') {
        sink.emit(0xc0 | ((regCode & 7) << 3) | (operand.code & 7));
        return;
    }
    if (operand.kind !== 'mem') throw new Error(`Expected register or memory operand, received '${operand.kind}'`);
    if (operand.base?.name === 'rip') {
        sink.emit(((regCode & 7) << 3) | 5);
        if (operand.symbol) {
            sink.relocation(operand.symbol, Elf.relocation.PC32, Number(operand.displacement - 4n));
            sink.emit(0, 0, 0, 0);
        } else sink.emit(little(operand.displacement, 4));
        return;
    }
    const base = operand.base?.code;
    const index = operand.index?.code;
    const needsSib = index !== undefined || base === undefined || (base & 7) === 4;
    let displacementSize = 0;
    if (base === undefined || operand.symbol) displacementSize = 4;
    else if (operand.displacement !== 0n || (base & 7) === 5) displacementSize = operand.displacement >= -128n && operand.displacement <= 127n ? 1 : 4;
    const mod = base === undefined ? 0 : displacementSize === 0 ? 0 : displacementSize === 1 ? 1 : 2;
    sink.emit((mod << 6) | ((regCode & 7) << 3) | (needsSib ? 4 : base & 7));
    if (needsSib) {
        const scale = {1: 0, 2: 1, 4: 2, 8: 3}[operand.scale];
        sink.emit((scale << 6) | ((index === undefined ? 4 : index & 7) << 3) | (base === undefined ? 5 : base & 7));
    }
    if (operand.symbol) {
        sink.relocation(operand.symbol, Elf.relocation.X86_64_32S, Number(operand.displacement));
        sink.emit(0, 0, 0, 0);
    } else if (displacementSize) sink.emit(little(operand.displacement, displacementSize));
}

function rmRexBits(operand) {
    return operand.kind === 'mem'
        ? {b: operand.base?.code ?? 0, x: operand.index?.code ?? 0}
        : {b: operand.code, x: 0};
}

function encodeRegRm(sink, opcode, destination, source, size, prefix = []) {
    sink.emit(prefix);
    operandPrefix(sink, size);
    const bits = rmRexBits(source);
    rex(sink, {w: size === 8, r: destination.code, ...bits, force: size === 1 && (destination.code >= 4 || bits.b >= 4)});
    sink.emit(opcode);
    encodeModRm(sink, destination.code, source);
}

function encodeRmReg(sink, opcode, destination, source, size, prefix = []) {
    sink.emit(prefix);
    operandPrefix(sink, size);
    const bits = rmRexBits(destination);
    rex(sink, {w: size === 8, r: source.code, ...bits, force: size === 1 && (source.code >= 4 || bits.b >= 4)});
    sink.emit(opcode);
    encodeModRm(sink, source.code, destination);
}

function operandSize(left, right) {
    return left.size ?? right.size;
}

function encodeImmediateRm(sink, destination, extension, value, size, byteOpcode, opcode) {
    operandPrefix(sink, size);
    const bits = rmRexBits(destination);
    rex(sink, {w: size === 8, ...bits, force: size === 1 && bits.b >= 4});
    sink.emit(size === 1 ? byteOpcode : opcode);
    encodeModRm(sink, extension, destination);
    const immediateSize = size === 1 ? 1 : size === 2 ? 2 : 4;
    if (!sink.sizing && destination.kind === 'mem' && destination.base?.name === 'rip' && destination.symbol) {
        sink.relocations[sink.relocations.length - 1].addend -= immediateSize;
    }
    sink.emit(little(value, immediateSize));
}

function encodeSseRegRm(sink, prefix, opcode, destination, source, w = false) {
    if (prefix !== null) sink.emit(prefix);
    const bits = rmRexBits(source);
    rex(sink, {w, r: destination.code, ...bits});
    sink.emit(0x0f, opcode);
    encodeModRm(sink, destination.code, source);
}

function encodeSseRmReg(sink, prefix, opcode, destination, source, w = false) {
    if (prefix !== null) sink.emit(prefix);
    const bits = rmRexBits(destination);
    rex(sink, {w, r: source.code, ...bits});
    sink.emit(0x0f, opcode);
    encodeModRm(sink, source.code, destination);
}

function encodeBinary(sink, mnemonic, left, right) {
    const table = {
        add: [0x00, 0x01, 0x02, 0x03, 0], or: [0x08, 0x09, 0x0a, 0x0b, 1],
        and: [0x20, 0x21, 0x22, 0x23, 4], sub: [0x28, 0x29, 0x2a, 0x2b, 5],
        xor: [0x30, 0x31, 0x32, 0x33, 6], cmp: [0x38, 0x39, 0x3a, 0x3b, 7]
    }[mnemonic];
    const size = operandSize(left, right);
    if (right.kind === 'imm') return encodeImmediateRm(sink, left, table[4], right.value, size, 0x80, 0x81);
    if (left.kind === 'reg') return encodeRegRm(sink, size === 1 ? table[2] : table[3], left, right, size);
    return encodeRmReg(sink, size === 1 ? table[0] : table[1], left, right, size);
}

function encodeInstruction(sink, mnemonic, operands) {
    const [left, right, third] = operands;
    if (['add', 'or', 'and', 'sub', 'xor', 'cmp'].includes(mnemonic)) return encodeBinary(sink, mnemonic, left, right);
    if (mnemonic === 'mov') {
        const size = operandSize(left, right);
        if (right.kind === 'imm') {
            if (left.kind === 'reg') {
                operandPrefix(sink, size);
                rex(sink, {w: size === 8, b: left.code, force: size === 1 && left.code >= 4});
                sink.emit((size === 1 ? 0xb0 : 0xb8) + (left.code & 7), little(right.value, size));
                return;
            }
            return encodeImmediateRm(sink, left, 0, right.value, size, 0xc6, 0xc7);
        }
        if (left.kind === 'reg') return encodeRegRm(sink, size === 1 ? 0x8a : 0x8b, left, right, size);
        return encodeRmReg(sink, size === 1 ? 0x88 : 0x89, left, right, size);
    }
    if (mnemonic === 'lea') return encodeRegRm(sink, 0x8d, left, right, left.size);
    if (mnemonic === 'test') {
        const size = operandSize(left, right);
        return encodeRmReg(sink, size === 1 ? 0x84 : 0x85, left, right, size);
    }
    if (mnemonic === 'push' || mnemonic === 'pop') {
        rex(sink, {b: left.code}); sink.emit((mnemonic === 'push' ? 0x50 : 0x58) + (left.code & 7)); return;
    }
    if (mnemonic === 'call' || mnemonic === 'jmp') {
        if (left.kind === 'symbol') {
            sink.emit(mnemonic === 'call' ? 0xe8 : 0xe9);
            const target = sink.symbols.get(left.name);
            if (target?.section === sink.section) sink.emit(little(BigInt(target.offset - (sink.offset + 5)), 4));
            else { sink.relocation(left.name, mnemonic === 'call' ? Elf.relocation.PLT32 : Elf.relocation.PC32, -4); sink.emit(0, 0, 0, 0); }
            return;
        }
        const bits = rmRexBits(left); rex(sink, {w: true, ...bits}); sink.emit(0xff); encodeModRm(sink, mnemonic === 'call' ? 2 : 4, left); return;
    }
    if (conditionCodes[mnemonic] !== undefined) {
        sink.emit(0x0f, 0x80 + conditionCodes[mnemonic]);
        const target = sink.symbols.get(left.name);
        if (sink.sizing) { sink.emit(0, 0, 0, 0); return; }
        if (!target || target.section !== sink.section) throw new Error(`Conditional branch target '${left.name}' is not local`);
        sink.emit(little(BigInt(target.offset - (sink.offset + 6)), 4)); return;
    }
    if (setConditionCodes[mnemonic] !== undefined) {
        const bits = rmRexBits(left); rex(sink, {...bits, force: bits.b >= 4}); sink.emit(0x0f, 0x90 + setConditionCodes[mnemonic]); encodeModRm(sink, 0, left); return;
    }
    if (cmovConditionCodes[mnemonic] !== undefined) return encodeRegRm(sink, [0x0f, 0x40 + cmovConditionCodes[mnemonic]], left, right, left.size);
    if (mnemonic === 'ret') { sink.emit(0xc3); return; }
    if (mnemonic === 'leave') { sink.emit(0xc9); return; }
    if (mnemonic === 'syscall') { sink.emit(0x0f, 0x05); return; }
    if (mnemonic === 'ud2') { sink.emit(0x0f, 0x0b); return; }
    if (mnemonic === 'cqo') { sink.emit(0x48, 0x99); return; }
    if (mnemonic === 'pause') { sink.emit(0xf3, 0x90); return; }
    if (mnemonic === 'movsb') { sink.emit(0xa4); return; }
    if (mnemonic === 'cmpsb') { sink.emit(0xa6); return; }
    if (mnemonic === 'cmpxchg') return encodeRmReg(sink, [0x0f, 0xb1], left, right, operandSize(left, right));
    if (mnemonic === 'xadd') return encodeRmReg(sink, [0x0f, 0xc1], left, right, operandSize(left, right));
    if (mnemonic === 'xchg') return encodeRmReg(sink, operandSize(left, right) === 1 ? 0x86 : 0x87, left, right, operandSize(left, right));
    if (mnemonic === 'neg' || mnemonic === 'div' || mnemonic === 'idiv' || mnemonic === 'inc' || mnemonic === 'dec') {
        const extension = {neg: 3, div: 6, idiv: 7, inc: 0, dec: 1}[mnemonic];
        const bits = rmRexBits(left); operandPrefix(sink, left.size); rex(sink, {w: left.size === 8, ...bits}); sink.emit(mnemonic === 'inc' || mnemonic === 'dec' ? 0xff : 0xf7); encodeModRm(sink, extension, left); return;
    }
    if (mnemonic === 'shl' || mnemonic === 'shr' || mnemonic === 'sar' || mnemonic === 'rol') {
        const bits = rmRexBits(left);
        const extension = mnemonic === 'rol' ? 0 : mnemonic === 'shl' ? 4 : mnemonic === 'shr' ? 5 : 7;
        operandPrefix(sink, left.size); rex(sink, {w: left.size === 8, ...bits});
        if (right.kind === 'reg' && right.name === 'cl') { sink.emit(0xd3); encodeModRm(sink, extension, left); return; }
        if (right.kind !== 'imm') throw new Error(`Shift count must be an immediate or cl`);
        sink.emit(0xc1); encodeModRm(sink, extension, left); sink.emit(Number(right.value & 255n)); return;
    }
    if (mnemonic === 'imul') {
        if (!right) { const bits = rmRexBits(left); rex(sink, {w: true, ...bits}); sink.emit(0xf7); encodeModRm(sink, 5, left); return; }
        if (right.kind === 'imm') { encodeRegRm(sink, 0x69, left, left, left.size); sink.emit(little(right.value, 4)); return; }
        if (third) { encodeRegRm(sink, 0x69, left, right, left.size); sink.emit(little(third.value, 4)); return; }
        return encodeRegRm(sink, [0x0f, 0xaf], left, right, left.size);
    }
    if (mnemonic === 'movsxd') return encodeRegRm(sink, 0x63, left, right, 8);
    if (mnemonic === 'movzx' || mnemonic === 'movsx') {
        const sourceSize = right.size;
        const opcode = sourceSize === 1 ? (mnemonic === 'movzx' ? 0xb6 : 0xbe) : (mnemonic === 'movzx' ? 0xb7 : 0xbf);
        return encodeRegRm(sink, [0x0f, opcode], left, right, left.size);
    }
    if (mnemonic === 'movsd') {
        if (left.kind === 'xmm') return encodeSseRegRm(sink, 0xf2, 0x10, left, right);
        return encodeSseRmReg(sink, 0xf2, 0x11, left, right);
    }
    if (mnemonic === 'movss') {
        if (left.kind === 'xmm') return encodeSseRegRm(sink, 0xf3, 0x10, left, right);
        return encodeSseRmReg(sink, 0xf3, 0x11, left, right);
    }
    if (mnemonic === 'addsd' || mnemonic === 'subsd' || mnemonic === 'mulsd' || mnemonic === 'divsd') {
        return encodeSseRegRm(sink, 0xf2, {addsd: 0x58, subsd: 0x5c, mulsd: 0x59, divsd: 0x5e}[mnemonic], left, right);
    }
    if (mnemonic === 'ucomisd') return encodeSseRegRm(sink, 0x66, 0x2e, left, right);
    if (mnemonic === 'ucomiss') return encodeSseRegRm(sink, null, 0x2e, left, right);
    if (mnemonic === 'cvtsi2sd') return encodeSseRegRm(sink, 0xf2, 0x2a, left, right, right.size === 8);
    if (mnemonic === 'cvttsd2si') return encodeSseRegRm(sink, 0xf2, 0x2c, left, right, left.size === 8);
    if (mnemonic === 'cvtsd2ss') return encodeSseRegRm(sink, 0xf2, 0x5a, left, right);
    if (mnemonic === 'cvtss2sd') return encodeSseRegRm(sink, 0xf3, 0x5a, left, right);
    if (mnemonic === 'movd' || mnemonic === 'movq') {
        const w = mnemonic === 'movq';
        if (left.kind === 'xmm') return encodeSseRegRm(sink, 0x66, 0x6e, left, right, w);
        return encodeSseRmReg(sink, 0x66, 0x7e, left, right, w);
    }
    throw new Error(`Unsupported x86-64 instruction '${mnemonic}'`);
}

/** Assembles the strict Intel-syntax subset emitted by Valen's x86-64 backend. */
export class X86Assembler {
    assemble(source) {
        return this.assembleObject(source).build();
    }

    assembleObject(source) {
        const lines = source.split('\n').map(line => line.trim()).filter(Boolean);
        const parsed = this.parse(lines);
        this.layout(parsed);
        return this.emit(parsed);
    }

    parse(lines) {
        const program = {items: [], globals: new Set(), externals: new Set(), commons: []};
        let section = '.text';
        const numericLabels = new Map();
        for (let line of lines) {
            if (line === '.intel_syntax noprefix' || line === '.note.GNU-stack,"",@progbits') continue;
            if (line === '.text') { section = '.text'; continue; }
            if (line === '.data') { section = '.data'; continue; }
            if (line === '.bss') { section = '.bss'; continue; }
            if (line.startsWith('.section ')) { section = line.slice(9).split(',')[0]; continue; }
            if (line.startsWith('.globl ')) { program.globals.add(line.slice(7).trim()); continue; }
            if (line.startsWith('.extern ')) { program.externals.add(line.slice(8).trim()); continue; }
            if (line.startsWith('.comm ')) {
                const [name, size, alignment] = splitOperands(line.slice(6));
                program.commons.push({name, size: Number(size), alignment: Number(alignment)}); continue;
            }
            if (/^[0-9]+:$/.test(line)) {
                const number = line.slice(0, -1);
                const sequence = (numericLabels.get(number) ?? 0) + 1;
                numericLabels.set(number, sequence);
                program.items.push({kind: 'label', section, name: `.Lnumeric_${number}_${sequence}`});
                continue;
            }
            if (line.endsWith(':')) { program.items.push({kind: 'label', section, name: line.slice(0, -1)}); continue; }
            if (line.startsWith('.align ')) { program.items.push({kind: 'align', section, alignment: Number(line.slice(7))}); continue; }
            if (line.startsWith('.zero ')) { program.items.push({kind: 'zero', section, size: Number(line.slice(6))}); continue; }
            if (line.startsWith('.byte ')) { program.items.push({kind: 'bytes', section, bytes: splitOperands(line.slice(6)).map(Number)}); continue; }
            if (line.startsWith('.quad ')) { program.items.push({kind: 'quad', section, value: line.slice(6).trim()}); continue; }
            if (line.startsWith('.double ')) {
                const data = Buffer.alloc(8); data.writeDoubleLE(Number(line.slice(8))); program.items.push({kind: 'bytes', section, bytes: [...data]}); continue;
            }
            if (line.startsWith('.float ')) {
                const data = Buffer.alloc(4); data.writeFloatLE(Number(line.slice(7))); program.items.push({kind: 'bytes', section, bytes: [...data]}); continue;
            }
            if (line.startsWith('.asciz ')) {
                const text = JSON.parse(line.slice(7)); program.items.push({kind: 'bytes', section, bytes: [...Buffer.from(`${text}\0`)]}); continue;
            }
            if (line.startsWith('.ascii ')) {
                const text = JSON.parse(line.slice(7)); program.items.push({kind: 'bytes', section, bytes: [...Buffer.from(text)]}); continue;
            }
            let instruction = line;
            let prefix = null;
            if (instruction.startsWith('lock ') || instruction.startsWith('rep ') || instruction.startsWith('repe ')) {
                [prefix, instruction] = [instruction.split(' ', 1)[0], instruction.slice(instruction.indexOf(' ') + 1)];
            }
            instruction = instruction.replace(/\b([0-9]+)([fb])\b/g, (_match, number, direction) => {
                const sequence = (numericLabels.get(number) ?? 0) + (direction === 'f' ? 1 : 0);
                return `.Lnumeric_${number}_${sequence}`;
            });
            const space = instruction.indexOf(' ');
            const mnemonic = space < 0 ? instruction : instruction.slice(0, space);
            const operands = space < 0 ? [] : splitOperands(instruction.slice(space + 1)).map(parseOperand);
            program.items.push({kind: 'instruction', section, mnemonic, operands, prefix});
        }
        return program;
    }

    layout(program) {
        const offsets = new Map(), symbols = new Map();
        for (const item of program.items) {
            let offset = offsets.get(item.section) ?? 0;
            if (item.kind === 'label') symbols.set(item.name, {section: item.section, offset});
            else if (item.kind === 'align') offset = Math.ceil(offset / item.alignment) * item.alignment;
            else if (item.kind === 'zero') offset += item.size;
            else if (item.kind === 'bytes') offset += item.bytes.length;
            else if (item.kind === 'quad') offset += 8;
            else if (item.kind === 'instruction') {
                const sink = new CodeSink(item.section, offset, symbols, [], true);
                if (item.prefix === 'lock') sink.emit(0xf0);
                if (item.prefix === 'rep') sink.emit(0xf3);
                if (item.prefix === 'repe') sink.emit(0xf3);
                encodeInstruction(sink, item.mnemonic, item.operands);
                offset += sink.bytes.length;
            }
            offsets.set(item.section, offset);
        }
        program.offsets = offsets;
        program.symbols = symbols;
    }

    emit(program) {
        const buffers = new Map([...program.offsets].map(([name, size]) => [name, Buffer.alloc(size)]));
        const positions = new Map(), relocations = [];
        for (const item of program.items) {
            let offset = positions.get(item.section) ?? 0;
            if (item.kind === 'align') offset = Math.ceil(offset / item.alignment) * item.alignment;
            else if (item.kind === 'zero') offset += item.size;
            else if (item.kind === 'bytes') { Buffer.from(item.bytes).copy(buffers.get(item.section), offset); offset += item.bytes.length; }
            else if (item.kind === 'quad') {
                const number = integer(item.value);
                if (number !== null) Buffer.from(little(number, 8)).copy(buffers.get(item.section), offset);
                else relocations.push({section: item.section, offset, symbol: item.value, type: Elf.relocation.X86_64_64, addend: 0});
                offset += 8;
            } else if (item.kind === 'instruction') {
                const sink = new CodeSink(item.section, offset, program.symbols, relocations);
                if (item.prefix === 'lock') sink.emit(0xf0);
                if (item.prefix === 'rep' || item.prefix === 'repe') sink.emit(0xf3);
                encodeInstruction(sink, item.mnemonic, item.operands);
                Buffer.from(sink.bytes).copy(buffers.get(item.section), offset);
                offset += sink.bytes.length;
            }
            positions.set(item.section, offset);
        }

        const object = new ElfObject();
        for (const [name, buffer] of buffers) {
            if (name === '.text') object.addText(buffer);
            else if (name === '.rodata') object.addReadOnlyData(buffer);
            else if (name === '.data') object.addData(buffer);
            else if (name.startsWith('.data.')) object.addSection(name, buffer, {flags: Elf.SHF.ALLOC | Elf.SHF.WRITE, alignment: 8});
            else if (name.startsWith('.rodata.')) object.addSection(name, buffer, {flags: Elf.SHF.ALLOC, alignment: 8});
            else if (name !== '.bss') object.addSection(name, buffer);
        }
        let bssSize = buffers.get('.bss')?.length ?? 0;
        for (const common of program.commons) {
            bssSize = Math.ceil(bssSize / common.alignment) * common.alignment;
            program.symbols.set(common.name, {section: '.bss', offset: bssSize, size: common.size});
            bssSize += common.size;
        }
        if (bssSize) object.addBss(bssSize);
        for (const [name, symbol] of program.symbols) object.addSymbol(name, {section: symbol.section, value: symbol.offset,
            size: symbol.size ?? 0, binding: program.globals.has(name) ? 'GLOBAL' : 'LOCAL', type: symbol.section === '.text' ? 'FUNC' : 'OBJECT'});
        for (const name of program.externals) if (!program.symbols.has(name)) object.addSymbol(name, {binding: 'GLOBAL'});
        const addedUndefined = new Set(program.externals);
        for (const relocation of relocations) {
            if (!program.symbols.has(relocation.symbol) && !addedUndefined.has(relocation.symbol)) {
                object.addSymbol(relocation.symbol, {binding: 'GLOBAL'});
                addedUndefined.add(relocation.symbol);
            }
            object.addRelocation(relocation.section, relocation.offset, relocation.symbol, relocation.type, relocation.addend);
        }
        return object;
    }
}
