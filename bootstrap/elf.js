const ELF_HEADER_SIZE = 64;
const SECTION_HEADER_SIZE = 64;

const SHT = {NULL: 0, PROGBITS: 1, SYMTAB: 2, STRTAB: 3, RELA: 4, NOBITS: 8};
const SHF = {WRITE: 1, ALLOC: 2, EXECINSTR: 4};

function align(value, alignment) {
    return alignment <= 1 ? value : Math.ceil(value / alignment) * alignment;
}

function writeU64(buffer, offset, value) {
    buffer.writeBigUInt64LE(BigInt(value), offset);
}

function writeI64(buffer, offset, value) {
    buffer.writeBigInt64LE(BigInt(value), offset);
}

class StringTable {
    constructor() {
        this.parts = [Buffer.from([0])];
        this.offsets = new Map([['', 0]]);
        this.length = 1;
    }

    add(value) {
        const existing = this.offsets.get(value);
        if (existing !== undefined) return existing;
        const offset = this.length;
        const bytes = Buffer.from(`${value}\0`);
        this.parts.push(bytes);
        this.offsets.set(value, offset);
        this.length += bytes.length;
        return offset;
    }

    build() {
        return Buffer.concat(this.parts, this.length);
    }
}

/** A deterministic ELF64 little-endian relocatable-object writer. */
export class ElfObject {
    constructor({machine = 62} = {}) {
        this.machine = machine;
        this.sections = [];
        this.symbols = [];
        this.relocations = [];
        this.sectionNames = new Set();
        this.symbolNames = new Set();
    }

    addSection(name, data, {type = 'PROGBITS', flags = 0, alignment = 1} = {}) {
        if (this.sectionNames.has(name)) throw new Error(`Duplicate ELF section '${name}'`);
        const section = {name, data: Buffer.from(data), type: SHT[type], flags, alignment};
        this.sections.push(section);
        this.sectionNames.add(name);
        return section;
    }

    addText(data, alignment = 16) {
        return this.addSection('.text', data, {flags: SHF.ALLOC | SHF.EXECINSTR, alignment});
    }

    addReadOnlyData(data, alignment = 8) {
        return this.addSection('.rodata', data, {flags: SHF.ALLOC, alignment});
    }

    addData(data, alignment = 8) {
        return this.addSection('.data', data, {flags: SHF.WRITE | SHF.ALLOC, alignment});
    }

    addBss(size, alignment = 8) {
        const section = this.addSection('.bss', Buffer.alloc(0), {type: 'NOBITS', flags: SHF.WRITE | SHF.ALLOC, alignment});
        section.size = size;
        return section;
    }

    addSymbol(name, {section = null, value = 0, size = 0, binding = 'LOCAL', type = 'NOTYPE'} = {}) {
        if (this.symbolNames.has(name)) throw new Error(`Duplicate ELF symbol '${name}'`);
        const symbol = {name, section, value, size, binding, type};
        this.symbols.push(symbol);
        this.symbolNames.add(name);
        return symbol;
    }

    addRelocation(section, offset, symbol, type, addend = 0) {
        this.relocations.push({section, offset, symbol, type, addend});
    }

    static parse(input) {
        const buffer = Buffer.from(input);
        if (buffer.length < ELF_HEADER_SIZE || buffer.subarray(0, 4).toString('hex') !== '7f454c46' ||
            buffer[4] !== 2 || buffer[5] !== 1 || buffer.readUInt16LE(16) !== 1 || ![62, 183].includes(buffer.readUInt16LE(18))) {
            throw new Error('Unsupported compiled-library object');
        }
        const headerOffset = Number(buffer.readBigUInt64LE(40));
        const headerSize = buffer.readUInt16LE(58), count = buffer.readUInt16LE(60), nameIndex = buffer.readUInt16LE(62);
        if (headerSize !== SECTION_HEADER_SIZE || headerOffset + count * headerSize > buffer.length || nameIndex >= count) {
            throw new Error('Malformed compiled-library section table');
        }
        const headers = Array.from({length: count}, (_, index) => {
            const offset = headerOffset + index * headerSize;
            return {nameOffset: buffer.readUInt32LE(offset), type: buffer.readUInt32LE(offset + 4),
                flags: Number(buffer.readBigUInt64LE(offset + 8)), offset: Number(buffer.readBigUInt64LE(offset + 24)),
                size: Number(buffer.readBigUInt64LE(offset + 32)), link: buffer.readUInt32LE(offset + 40),
                info: buffer.readUInt32LE(offset + 44), alignment: Number(buffer.readBigUInt64LE(offset + 48)),
                entrySize: Number(buffer.readBigUInt64LE(offset + 56))};
        });
        const bytes = header => {
            if (header.type === SHT.NOBITS) return Buffer.alloc(0);
            if (header.offset + header.size > buffer.length) throw new Error('Malformed compiled-library section');
            return buffer.subarray(header.offset, header.offset + header.size);
        };
        const stringAt = (table, offset) => {
            if (offset < 0 || offset >= table.length) throw new Error('Malformed compiled-library string table');
            const end = table.indexOf(0, offset);
            if (end < 0) throw new Error('Malformed compiled-library string table');
            return table.subarray(offset, end).toString();
        };
        const sectionNames = bytes(headers[nameIndex]);
        headers.forEach(header => { header.name = stringAt(sectionNames, header.nameOffset); });
        const object = new ElfObject({machine: buffer.readUInt16LE(18)});
        headers.forEach((header, index) => {
            if (index === 0 || [SHT.SYMTAB, SHT.STRTAB, SHT.RELA].includes(header.type)) return;
            const section = object.addSection(header.name, bytes(header), {type: header.type === SHT.NOBITS ? 'NOBITS' : 'PROGBITS',
                flags: header.flags, alignment: header.alignment || 1});
            if (header.type === SHT.NOBITS) section.size = header.size;
        });
        const symbolHeader = headers.find(header => header.type === SHT.SYMTAB);
        const symbols = [null];
        if (symbolHeader) {
            const table = bytes(symbolHeader), strings = bytes(headers[symbolHeader.link]);
            if (symbolHeader.entrySize !== 24 || table.length % 24 !== 0) throw new Error('Malformed compiled-library symbol table');
            for (let offset = 24; offset < table.length; offset += 24) {
                const info = table[offset + 4], sectionIndex = table.readUInt16LE(offset + 6);
                const name = stringAt(strings, table.readUInt32LE(offset));
                const symbol = {name, section: sectionIndex === 0 ? null : headers[sectionIndex]?.name,
                    value: Number(table.readBigUInt64LE(offset + 8)), size: Number(table.readBigUInt64LE(offset + 16)),
                    binding: info >> 4 === 1 ? 'GLOBAL' : info >> 4 === 2 ? 'WEAK' : 'LOCAL',
                    type: (info & 15) === 1 ? 'OBJECT' : (info & 15) === 2 ? 'FUNC' : (info & 15) === 3 ? 'SECTION' : 'NOTYPE'};
                if (!symbol.name) symbol.name = `$section.${offset / 24}`;
                object.addSymbol(symbol.name, symbol);
                symbols.push(symbol);
            }
        }
        for (const header of headers.filter(item => item.type === SHT.RELA)) {
            const table = bytes(header);
            if (header.entrySize !== 24 || table.length % 24 !== 0 || !headers[header.info]) throw new Error('Malformed compiled-library relocation table');
            for (let offset = 0; offset < table.length; offset += 24) {
                const info = table.readBigUInt64LE(offset + 8), symbol = symbols[Number(info >> 32n)];
                if (!symbol) throw new Error('Malformed compiled-library relocation symbol');
                object.addRelocation(headers[header.info].name, Number(table.readBigUInt64LE(offset)), symbol.name,
                    Number(info & 0xffffffffn), Number(table.readBigInt64LE(offset + 16)));
            }
        }
        return object;
    }

    build() {
        const userSections = this.sections.map(section => ({...section}));
        const sectionIndexes = new Map(userSections.map((section, index) => [section.name, index + 1]));
        const locals = this.symbols.filter(symbol => symbol.binding === 'LOCAL');
        const globals = this.symbols.filter(symbol => symbol.binding !== 'LOCAL');
        const orderedSymbols = [...locals, ...globals];
        const symbolIndexes = new Map(orderedSymbols.map((symbol, index) => [symbol.name, index + 1]));

        const strings = new StringTable();
        const symbolData = Buffer.alloc((orderedSymbols.length + 1) * 24);
        orderedSymbols.forEach((symbol, index) => {
            const offset = (index + 1) * 24;
            symbolData.writeUInt32LE(strings.add(symbol.name), offset);
            const binding = symbol.binding === 'GLOBAL' ? 1 : symbol.binding === 'WEAK' ? 2 : 0;
            const type = symbol.type === 'OBJECT' ? 1 : symbol.type === 'FUNC' ? 2 : symbol.type === 'SECTION' ? 3 : 0;
            symbolData[offset + 4] = (binding << 4) | type;
            symbolData.writeUInt16LE(symbol.section ? sectionIndexes.get(symbol.section) : 0, offset + 6);
            writeU64(symbolData, offset + 8, symbol.value);
            writeU64(symbolData, offset + 16, symbol.size);
        });

        const relocationSections = [];
        for (const section of userSections) {
            const entries = this.relocations.filter(relocation => relocation.section === section.name);
            if (!entries.length) continue;
            const data = Buffer.alloc(entries.length * 24);
            entries.forEach((relocation, index) => {
                const offset = index * 24;
                const symbolIndex = symbolIndexes.get(relocation.symbol);
                if (symbolIndex === undefined) throw new Error(`ELF relocation references unknown symbol '${relocation.symbol}'`);
                writeU64(data, offset, relocation.offset);
                writeU64(data, offset + 8, (BigInt(symbolIndex) << 32n) | BigInt(relocation.type));
                writeI64(data, offset + 16, relocation.addend);
            });
            relocationSections.push({name: `.rela${section.name}`, data, type: SHT.RELA, flags: 0, alignment: 8,
                target: section.name, entrySize: 24});
        }

        const strtab = {name: '.strtab', data: strings.build(), type: SHT.STRTAB, flags: 0, alignment: 1};
        const symtab = {name: '.symtab', data: symbolData, type: SHT.SYMTAB, flags: 0, alignment: 8, entrySize: 24,
            localCount: locals.length + 1};
        const allWithoutNames = [...userSections, ...relocationSections, symtab, strtab];
        const shstrings = new StringTable();
        for (const section of [...allWithoutNames, {name: '.shstrtab'}]) section.nameOffset = shstrings.add(section.name);
        const shstrtab = {name: '.shstrtab', nameOffset: shstrings.offsets.get('.shstrtab'), data: shstrings.build(),
            type: SHT.STRTAB, flags: 0, alignment: 1};
        const allSections = [...allWithoutNames, shstrtab];
        const indexes = new Map(allSections.map((section, index) => [section.name, index + 1]));

        let fileOffset = ELF_HEADER_SIZE;
        for (const section of allSections) {
            fileOffset = align(fileOffset, section.alignment);
            section.offset = fileOffset;
            if (section.type !== SHT.NOBITS) fileOffset += section.data.length;
        }
        const sectionHeaderOffset = align(fileOffset, 8);
        const output = Buffer.alloc(sectionHeaderOffset + (allSections.length + 1) * SECTION_HEADER_SIZE);
        for (const section of allSections) if (section.type !== SHT.NOBITS) section.data.copy(output, section.offset);

        output.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
        output.writeUInt16LE(1, 16); // ET_REL
        output.writeUInt16LE(this.machine, 18);
        output.writeUInt32LE(1, 20);
        writeU64(output, 40, sectionHeaderOffset);
        output.writeUInt16LE(ELF_HEADER_SIZE, 52);
        output.writeUInt16LE(SECTION_HEADER_SIZE, 58);
        output.writeUInt16LE(allSections.length + 1, 60);
        output.writeUInt16LE(indexes.get('.shstrtab'), 62);

        allSections.forEach((section, index) => {
            const offset = sectionHeaderOffset + (index + 1) * SECTION_HEADER_SIZE;
            output.writeUInt32LE(section.nameOffset, offset);
            output.writeUInt32LE(section.type, offset + 4);
            writeU64(output, offset + 8, section.flags);
            writeU64(output, offset + 24, section.offset);
            writeU64(output, offset + 32, section.type === SHT.NOBITS ? section.size : section.data.length);
            if (section.type === SHT.SYMTAB) {
                output.writeUInt32LE(indexes.get('.strtab'), offset + 40);
                output.writeUInt32LE(section.localCount, offset + 44);
            } else if (section.type === SHT.RELA) {
                output.writeUInt32LE(indexes.get('.symtab'), offset + 40);
                output.writeUInt32LE(indexes.get(section.target), offset + 44);
            }
            writeU64(output, offset + 48, section.alignment);
            writeU64(output, offset + 56, section.entrySize ?? 0);
        });
        return output;
    }
}

export const Elf = Object.freeze({SHT, SHF, relocation: Object.freeze({X86_64_64: 1, PC32: 2, PLT32: 4, X86_64_32: 10, X86_64_32S: 11})});
