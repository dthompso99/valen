import {ElfObject} from './elf.js';

const conditionCodes = new Map([['eq', 0], ['ne', 1], ['cs', 2], ['cc', 3], ['mi', 4], ['pl', 5], ['vs', 6], ['vc', 7],
    ['hi', 8], ['ls', 9], ['ge', 10], ['lt', 11], ['gt', 12], ['le', 13]]);

const register = value => {
    if (value === 'sp' || value === 'xzr') return 31;
    const match = value.match(/^x([0-9]|[12][0-9]|30)$/);
    if (!match) throw new Error(`Invalid AArch64 register '${value}'`);
    return Number(match[1]);
};

const immediate = value => {
    if (!/^#-?(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw new Error(`Invalid AArch64 immediate '${value}'`);
    const raw = value.slice(1);
    return Number(raw.startsWith('-0x') ? -BigInt(`0x${raw.slice(3)}`) : BigInt(raw));
};

/** Direct encoder for the controlled AArch64 syntax emitted by Valen. */
export class AArch64Assembler {
    assemble(source) { return this.assembleObject(source).build(); }

    assembleObject(source) {
        const labels = new Map();
        const globals = new Set();
        const externals = new Set();
        const instructions = [];
        let offset = 0;
        for (const raw of source.split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('.type ') || line.startsWith('.size ') || line.startsWith('.section ') || line === '.text') continue;
            if (line.startsWith('.globl ')) { globals.add(line.slice(7).trim()); continue; }
            if (line.startsWith('.extern ')) { externals.add(line.slice(8).trim()); continue; }
            if (line.endsWith(':')) {
                const name = line.slice(0, -1);
                if (labels.has(name)) throw new Error(`Duplicate AArch64 label '${name}'`);
                labels.set(name, offset);
                continue;
            }
            instructions.push({line, offset});
            offset += 4;
        }

        const text = Buffer.alloc(offset);
        const object = new ElfObject({machine: 183});
        for (const instruction of instructions) {
            const encoded = this.encode(instruction.line, instruction.offset, labels);
            text.writeUInt32LE(encoded.word >>> 0, instruction.offset);
            if (encoded.relocation) object.addRelocation('.text', instruction.offset, encoded.relocation, 283, 0);
        }
        object.addText(text, 4);
        for (const [name, value] of labels) object.addSymbol(name, {section: '.text', value,
            binding: globals.has(name) ? 'GLOBAL' : 'LOCAL', type: globals.has(name) ? 'FUNC' : 'NOTYPE'});
        for (const name of externals) if (!labels.has(name)) object.addSymbol(name, {binding: 'GLOBAL'});
        for (const instruction of instructions) {
            const target = this.branchTarget(instruction.line);
            if (target && !labels.has(target) && !object.symbolNames.has(target)) object.addSymbol(target, {binding: 'GLOBAL'});
        }
        return object;
    }

    encode(line, offset, labels) {
        let match;
        if ((match = line.match(/^(add|sub) (x(?:[0-9]|[12][0-9]|30)|sp), (x(?:[0-9]|[12][0-9]|30)|sp), (#-?(?:0x[0-9a-f]+|[0-9]+))$/i))) {
            const value = immediate(match[4]);
            if (value < 0 || value > 4095) throw new Error(`AArch64 ${match[1]} immediate is out of range`);
            const base = match[1] === 'add' ? 0x91000000 : 0xd1000000;
            return {word: base | (value << 10) | (register(match[3]) << 5) | register(match[2])};
        }
        if ((match = line.match(/^(add|sub|and|orr|eor|lsl|lsr|asr|mul) (x(?:[0-9]|[12][0-9]|30)), (x(?:[0-9]|[12][0-9]|30)), (x(?:[0-9]|[12][0-9]|30))$/))) {
            const [destination, left, right] = [register(match[2]), register(match[3]), register(match[4])];
            const base = {add: 0x8b000000, sub: 0xcb000000, and: 0x8a000000, orr: 0xaa000000, eor: 0xca000000,
                lsl: 0x9ac02000, lsr: 0x9ac02400, asr: 0x9ac02800, mul: 0x9b007c00}[match[1]];
            return {word: base | (right << 16) | (left << 5) | destination};
        }
        if ((match = line.match(/^(ldr|str) (x(?:[0-9]|[12][0-9]|30)), \[(x(?:[0-9]|[12][0-9]|30)|sp), (#(?:0x[0-9a-f]+|[0-9]+))\]$/i))) {
            const value = immediate(match[4]);
            if (value < 0 || value % 8 || value / 8 > 4095) throw new Error(`AArch64 ${match[1]} offset is out of range`);
            const base = match[1] === 'ldr' ? 0xf9400000 : 0xf9000000;
            return {word: base | ((value / 8) << 10) | (register(match[3]) << 5) | register(match[2])};
        }
        if ((match = line.match(/^mov (x(?:[0-9]|[12][0-9]|30)), (#-?(?:0x[0-9a-f]+|[0-9]+))$/i))) {
            const destination = register(match[1]), value = immediate(match[2]);
            if (value >= 0 && value <= 65535) return {word: 0xd2800000 | (value << 5) | destination};
            if (value < 0 && value >= -65536) return {word: 0x92800000 | ((~value & 0xffff) << 5) | destination};
            throw new Error('AArch64 mov immediate is out of range');
        }
        if ((match = line.match(/^mov (x(?:[0-9]|[12][0-9]|30)), (x(?:[0-9]|[12][0-9]|30))$/))) {
            return {word: 0xaa0003e0 | (register(match[2]) << 16) | register(match[1])};
        }
        if ((match = line.match(/^neg (x(?:[0-9]|[12][0-9]|30)), (x(?:[0-9]|[12][0-9]|30))$/))) {
            return {word: 0xcb0003e0 | (register(match[2]) << 16) | register(match[1])};
        }
        if ((match = line.match(/^cmp (x(?:[0-9]|[12][0-9]|30)), (x(?:[0-9]|[12][0-9]|30))$/))) {
            return {word: 0xeb00001f | (register(match[2]) << 16) | (register(match[1]) << 5)};
        }
        if ((match = line.match(/^cmp (x(?:[0-9]|[12][0-9]|30)), (#(?:0x[0-9a-f]+|[0-9]+))$/i))) {
            const value = immediate(match[2]);
            if (value < 0 || value > 4095) throw new Error('AArch64 cmp immediate is out of range');
            return {word: 0xf100001f | (value << 10) | (register(match[1]) << 5)};
        }
        if ((match = line.match(/^cset (x(?:[0-9]|[12][0-9]|30)), ([a-z]{2})$/))) {
            const condition = conditionCodes.get(match[2]);
            if (condition === undefined) throw new Error(`Invalid AArch64 condition '${match[2]}'`);
            return {word: 0x9a9f07e0 | ((condition ^ 1) << 12) | register(match[1])};
        }
        if ((match = line.match(/^cbnz (x(?:[0-9]|[12][0-9]|30)), ([A-Za-z0-9_.$]+)$/))) {
            const displacement = this.displacement(labels, match[2], offset, 19);
            return {word: 0xb5000000 | (displacement << 5) | register(match[1])};
        }
        if ((match = line.match(/^(b|bl) ([A-Za-z0-9_.$]+)$/))) {
            if (!labels.has(match[2])) {
                if (match[1] !== 'bl') throw new Error(`Undefined local AArch64 branch target '${match[2]}'`);
                return {word: 0x94000000, relocation: match[2]};
            }
            const displacement = this.displacement(labels, match[2], offset, 26);
            return {word: (match[1] === 'bl' ? 0x94000000 : 0x14000000) | displacement};
        }
        if (line === 'ret') return {word: 0xd65f03c0};
        if (line === 'svc #0') return {word: 0xd4000001};
        throw new Error(`Unsupported AArch64 instruction '${line}'`);
    }

    displacement(labels, target, offset, bits) {
        if (!labels.has(target)) throw new Error(`Undefined AArch64 label '${target}'`);
        const bytes = labels.get(target) - offset;
        const minimum = -(2 ** (bits - 1)), maximum = 2 ** (bits - 1) - 1;
        if (bytes % 4 || bytes / 4 < minimum || bytes / 4 > maximum) throw new Error(`AArch64 branch to '${target}' is out of range`);
        return Number(BigInt.asUintN(bits, BigInt(bytes / 4)));
    }

    branchTarget(line) { return line.match(/^bl ([A-Za-z0-9_.$]+)$/)?.[1] ?? null; }
}
