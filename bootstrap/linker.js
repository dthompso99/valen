const ELF_HEADER_SIZE = 64;
const PROGRAM_HEADER_SIZE = 56;
const PAGE_SIZE = 4096;
const BASE_ADDRESS = 0x400000;

const align = (value, alignment) => alignment <= 1 ? value : Math.ceil(value / alignment) * alignment;

export class LinkerError extends Error {}

/** Links the structured relocatable object emitted by Valen into a static ELF64 executable. */
export class ElfLinker {
    link(object, {entry = '_start'} = {}) {
        const alloc = object.sections.filter(section => (section.flags & 2) !== 0);
        const readOnly = alloc.filter(section => (section.flags & 1) === 0);
        const writable = alloc.filter(section => (section.flags & 1) !== 0);
        const layouts = new Map();

        let fileOffset = PAGE_SIZE;
        for (const section of readOnly) {
            fileOffset = align(fileOffset, section.alignment);
            layouts.set(section.name, {fileOffset, address: BASE_ADDRESS + fileOffset, section});
            if (section.type !== 8) fileOffset += section.data.length;
        }
        const readOnlyEnd = fileOffset;
        const writableStart = align(fileOffset, PAGE_SIZE);
        fileOffset = writableStart;
        let memoryEnd = writableStart;
        for (const section of writable) {
            fileOffset = align(fileOffset, section.alignment);
            memoryEnd = align(memoryEnd, section.alignment);
            const offset = section.type === 8 ? fileOffset : memoryEnd;
            layouts.set(section.name, {fileOffset: offset, address: BASE_ADDRESS + offset, section});
            memoryEnd = offset + (section.size ?? section.data.length);
            if (section.type !== 8) fileOffset = offset + section.data.length;
        }

        const symbols = new Map();
        for (const symbol of object.symbols) {
            if (!symbol.section) continue;
            const layout = layouts.get(symbol.section);
            if (!layout) throw new LinkerError(`Symbol '${symbol.name}' refers to non-allocated section '${symbol.section}'`);
            if (symbols.has(symbol.name)) throw new LinkerError(`Duplicate symbol '${symbol.name}'`);
            symbols.set(symbol.name, layout.address + symbol.value);
        }
        for (const symbol of object.symbols) {
            if (!symbol.section && symbol.binding !== 'LOCAL') throw new LinkerError(`Undefined symbol '${symbol.name}'`);
        }
        if (!symbols.has(entry)) throw new LinkerError(`Missing entry symbol '${entry}'`);

        const output = Buffer.alloc(Math.max(fileOffset, ELF_HEADER_SIZE + PROGRAM_HEADER_SIZE * 2));
        for (const layout of layouts.values()) {
            if (layout.section.type !== 8) Buffer.from(layout.section.data).copy(output, layout.fileOffset);
        }
        for (const relocation of object.relocations) {
            const layout = layouts.get(relocation.section);
            const symbol = symbols.get(relocation.symbol);
            if (!layout) throw new LinkerError(`Relocation targets non-allocated section '${relocation.section}'`);
            if (symbol === undefined) throw new LinkerError(`Undefined symbol '${relocation.symbol}'`);
            const location = layout.fileOffset + relocation.offset;
            const place = layout.address + relocation.offset;
            const value = BigInt(symbol) + BigInt(relocation.addend) - ([2, 4].includes(relocation.type) ? BigInt(place) : 0n);
            if (relocation.type === 1) output.writeBigUInt64LE(BigInt.asUintN(64, value), location);
            else if (relocation.type === 2 || relocation.type === 4 || relocation.type === 11) output.writeInt32LE(Number(BigInt.asIntN(32, value)), location);
            else if (relocation.type === 10) output.writeUInt32LE(Number(BigInt.asUintN(32, value)), location);
            else throw new LinkerError(`Unsupported x86-64 relocation ${relocation.type}`);
        }

        output.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
        output.writeUInt16LE(2, 16);
        output.writeUInt16LE(62, 18);
        output.writeUInt32LE(1, 20);
        output.writeBigUInt64LE(BigInt(symbols.get(entry)), 24);
        output.writeBigUInt64LE(64n, 32);
        output.writeUInt16LE(ELF_HEADER_SIZE, 52);
        output.writeUInt16LE(PROGRAM_HEADER_SIZE, 54);
        output.writeUInt16LE(2, 56);
        this.programHeader(output, 64, 5, 0, BASE_ADDRESS, readOnlyEnd, readOnlyEnd);
        this.programHeader(output, 64 + PROGRAM_HEADER_SIZE, 6, writableStart, BASE_ADDRESS + writableStart,
            Math.max(0, fileOffset - writableStart), Math.max(0, memoryEnd - writableStart));
        return output;
    }

    programHeader(output, offset, flags, fileOffset, address, fileSize, memorySize) {
        output.writeUInt32LE(1, offset);
        output.writeUInt32LE(flags, offset + 4);
        output.writeBigUInt64LE(BigInt(fileOffset), offset + 8);
        output.writeBigUInt64LE(BigInt(address), offset + 16);
        output.writeBigUInt64LE(BigInt(address), offset + 24);
        output.writeBigUInt64LE(BigInt(fileSize), offset + 32);
        output.writeBigUInt64LE(BigInt(memorySize), offset + 40);
        output.writeBigUInt64LE(BigInt(PAGE_SIZE), offset + 48);
    }
}
