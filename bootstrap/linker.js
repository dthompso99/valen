import {ElfObject} from './elf.js';

const ELF_HEADER_SIZE = 64;
const PROGRAM_HEADER_SIZE = 56;
const BASE_ADDRESS = 0x400000;

const align = (value, alignment) => alignment <= 1 ? value : Math.ceil(value / alignment) * alignment;

export class LinkerError extends Error {}

/** Links the structured relocatable object emitted by Valen into a static ELF64 executable. */
export class ElfLinker {
    linkObjects(objects, options = {}) {
        if (objects.length === 0) throw new LinkerError('No input objects');
        if (objects.length === 1) return this.link(objects[0], options);
        const machine = objects[0].machine;
        if (objects.some(object => object.machine !== machine)) throw new LinkerError('Cannot link objects for different target architectures');
        const merged = new ElfObject({machine});
        const requiredGlobals = new Set(objects.flatMap(object => object.symbols
            .filter(symbol => !symbol.section && symbol.binding !== 'LOCAL').map(symbol => symbol.name)));
        objects.forEach((object, objectIndex) => {
            const sectionNames = new Map();
            for (const section of object.sections) {
                const name = `${section.name}.m${objectIndex}`;
                sectionNames.set(section.name, name);
                if (section.type === 8) {
                    const added = merged.addSection(name, Buffer.alloc(0), {type: 'NOBITS', flags: section.flags, alignment: section.alignment});
                    added.size = section.size;
                } else merged.addSection(name, section.data, {flags: section.flags, alignment: section.alignment});
            }
            const localNames = new Map(object.symbols.filter(symbol => symbol.binding === 'LOCAL' && !requiredGlobals.has(symbol.name))
                .map(symbol => [symbol.name, `$m${objectIndex}.${symbol.name}`]));
            for (const symbol of object.symbols) {
                const name = localNames.get(symbol.name) ?? symbol.name;
                const existing = merged.symbols.find(candidate => candidate.name === name);
                if (existing && (symbol.binding !== 'LOCAL' || requiredGlobals.has(name))) {
                    if (existing.section && symbol.section) throw new LinkerError(`Duplicate symbol '${name}'`);
                    if (!existing.section && symbol.section) Object.assign(existing, {section: sectionNames.get(symbol.section),
                        value: symbol.value, size: symbol.size, binding: 'GLOBAL', type: symbol.type});
                    continue;
                }
                if (!merged.symbolNames.has(name)) merged.addSymbol(name, {section: symbol.section ? sectionNames.get(symbol.section) : null,
                    value: symbol.value, size: symbol.size, binding: requiredGlobals.has(name) ? 'GLOBAL' : symbol.binding, type: symbol.type});
            }
            for (const relocation of object.relocations) merged.addRelocation(sectionNames.get(relocation.section), relocation.offset,
                localNames.get(relocation.symbol) ?? relocation.symbol, relocation.type, relocation.addend);
        });
        return this.link(merged, options);
    }

    link(object, {entry = '_start'} = {}) {
        if (![62, 183].includes(object.machine)) throw new LinkerError(`Unsupported ELF machine ${object.machine}`);
        const pageSize = object.machine === 183 ? 65536 : 4096;
        const alloc = object.sections.filter(section => (section.flags & 2) !== 0);
        const readOnly = alloc.filter(section => (section.flags & 1) === 0);
        const writable = alloc.filter(section => (section.flags & 1) !== 0);
        const layouts = new Map();

        let fileOffset = pageSize;
        for (const section of readOnly) {
            fileOffset = align(fileOffset, section.alignment);
            layouts.set(section.name, {fileOffset, address: BASE_ADDRESS + fileOffset, section});
            if (section.type !== 8) fileOffset += section.data.length;
        }
        const readOnlyEnd = fileOffset;
        const writableStart = align(fileOffset, pageSize);
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
            if (!layout) {
                if (symbol.binding === 'LOCAL') continue;
                throw new LinkerError(`Symbol '${symbol.name}' refers to non-allocated section '${symbol.section}'`);
            }
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
            if (object.machine === 183) this.applyAArch64Relocation(output, location, place, symbol, relocation);
            else {
                const value = BigInt(symbol) + BigInt(relocation.addend) - ([2, 4].includes(relocation.type) ? BigInt(place) : 0n);
                if (relocation.type === 1) output.writeBigUInt64LE(BigInt.asUintN(64, value), location);
                else if (relocation.type === 2 || relocation.type === 4 || relocation.type === 11) output.writeInt32LE(Number(BigInt.asIntN(32, value)), location);
                else if (relocation.type === 10) output.writeUInt32LE(Number(BigInt.asUintN(32, value)), location);
                else throw new LinkerError(`Unsupported x86-64 relocation ${relocation.type}`);
            }
        }

        output.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
        output.writeUInt16LE(2, 16);
        output.writeUInt16LE(object.machine, 18);
        output.writeUInt32LE(1, 20);
        output.writeBigUInt64LE(BigInt(symbols.get(entry)), 24);
        output.writeBigUInt64LE(64n, 32);
        output.writeUInt16LE(ELF_HEADER_SIZE, 52);
        output.writeUInt16LE(PROGRAM_HEADER_SIZE, 54);
        output.writeUInt16LE(2, 56);
        this.programHeader(output, 64, 5, 0, BASE_ADDRESS, readOnlyEnd, readOnlyEnd, pageSize);
        this.programHeader(output, 64 + PROGRAM_HEADER_SIZE, 6, writableStart, BASE_ADDRESS + writableStart,
            Math.max(0, fileOffset - writableStart), Math.max(0, memoryEnd - writableStart), pageSize);
        return output;
    }

    applyAArch64Relocation(output, location, place, symbol, relocation) {
        const target = BigInt(symbol) + BigInt(relocation.addend);
        if (relocation.type === 257) {
            output.writeBigUInt64LE(BigInt.asUintN(64, target), location);
            return;
        }
        if (relocation.type === 275) {
            const pages = (target >> 12n) - (BigInt(place) >> 12n);
            if (pages < -(1n << 20n) || pages >= 1n << 20n) throw new LinkerError(`AArch64 page relocation to '${relocation.symbol}' is out of range`);
            const immediate = BigInt.asUintN(21, pages);
            const instruction = output.readUInt32LE(location);
            const encoded = (instruction & 0x9f00001f) | (Number(immediate & 3n) << 29) | (Number((immediate >> 2n) & 0x7ffffn) << 5);
            output.writeUInt32LE(encoded >>> 0, location);
            return;
        }
        if (relocation.type === 277) {
            const instruction = output.readUInt32LE(location);
            output.writeUInt32LE(((instruction & 0xffc003ff) | (Number(target & 0xfffn) << 10)) >>> 0, location);
            return;
        }
        if (![282, 283].includes(relocation.type)) throw new LinkerError(`Unsupported AArch64 relocation ${relocation.type}`);
        const displacement = target - BigInt(place);
        if ((displacement & 3n) !== 0n || displacement < -134217728n || displacement > 134217724n) {
            throw new LinkerError(`AArch64 branch relocation to '${relocation.symbol}' is out of range`);
        }
        const instruction = output.readUInt32LE(location);
        const immediate = Number(BigInt.asUintN(26, displacement >> 2n));
        output.writeUInt32LE(((instruction & 0xfc000000) | immediate) >>> 0, location);
    }

    programHeader(output, offset, flags, fileOffset, address, fileSize, memorySize, alignment) {
        output.writeUInt32LE(1, offset);
        output.writeUInt32LE(flags, offset + 4);
        output.writeBigUInt64LE(BigInt(fileOffset), offset + 8);
        output.writeBigUInt64LE(BigInt(address), offset + 16);
        output.writeBigUInt64LE(BigInt(address), offset + 24);
        output.writeBigUInt64LE(BigInt(fileSize), offset + 32);
        output.writeBigUInt64LE(BigInt(memorySize), offset + 40);
        output.writeBigUInt64LE(BigInt(alignment), offset + 48);
    }
}
