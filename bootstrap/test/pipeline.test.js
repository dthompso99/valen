import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Parser} from '../parser.js';
import {SemanticAnalyzer} from '../semantic.js';
import {IrGenerator} from '../ir.js';
import {IrCanonicalizer, IrValidationError, IrValidator} from '../ir-validation.js';
import {X86_64Backend} from '../x86-64.js';
import {AArch64Backend} from '../aarch64.js';
import {formatDiagnostic} from '../diagnostics.js';
import {ModuleLoader} from '../module-loader.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const primitiveProgram = `
entry {{
    member a:u8
    member b:i8
    member c:u16
    member d:i16
    member e:u32
    member f:i32
    member g:u64

    __() -> i64 {
        self.a = 255
        self.b = -5
        self.c = 65535
        self.d = -300
        self.e = 4294967295
        self.f = -100000
        self.g = 4294967296
        local narrowed:u8 = 300 as u8
        local signed:i8 = 255 as i8

        if self.a == 255 && self.b == -5 && self.c == 65535 && self.d == -300 && self.e == 4294967295 && self.f == -100000 && self.g == 4294967296 && narrowed == 44 && signed == -1 {
            return 0
        } else {
            return 1
        }
    }
}}
`;

const arrayProgram = `
entry {{
    __() -> i64 {
        local values:Array<i64> = new Array<i64>(2)
        values[0] = 10
        values[1] = 20
        values.append(30)
        values.append(40)
        values.append(50)
        local bytes:Array<u8> = new Array<u8>(0)
        bytes.append(255)
        if values.length == 5 && values[0] == 10 && values[4] == 50 && bytes.length == 1 && bytes[0] == 255 {
            return 0
        } else {
            return 1
        }
    }
}}
`;

const stringProgram = `
entry {{
    __() -> i64 {
        local joined:string = "va" + "len"
        local sliced:string = joined.slice(1, 3)
        if joined.length == 5 && joined[1] == 97 && joined == "valen" && joined != "other" && sliced == "ale" {
            return 0
        } else {
            return 1
        }
    }
}}
`;

const builderProgram = `
entry {{
    __() -> i64 {
        local builder:StringBuilder = new StringBuilder()
        builder.append("value=")
        builder.append(42)
        builder.appendByte(33)
        local first:string = builder.build()
        builder.append(" changed")
        if first == "value=42!" && builder.length == 17 && (-12).toString() == "-12" && (255 as u8).toString() == "255" {
            return 0
        } else {
            return 1
        }
    }
}}
`;

test('sample programs pass semantic analysis and IR generation', () => {
    for (const file of ['examples/simple/simple.ar', 'examples/nested/nested.ar']) {
        const filePath = path.join(projectRoot, file);
        const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
        assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
        const ir = new IrGenerator().generate(semantic);
        assert.ok(ir.entry);
        assert.ok(ir.functions.length > 0);
    }
});

test('integer widths pass through semantics, layout, and x86 generation', () => {
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(primitiveProgram, 'primitives.ar'));
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const assembly = new X86_64Backend().generate(ir);
    assert.match(assembly, /BYTE PTR/);
    assert.match(assembly, /WORD PTR/);
    assert.match(assembly, /DWORD PTR/);
    assert.match(assembly, /QWORD PTR/);
});

test('out-of-range integer literals are rejected', () => {
    const source = 'entry {{ member value:u8\n __() -> void { self.value = 256 } }}';
    const result = new SemanticAnalyzer().analyze(new Parser().parse(source, 'range.ar'));
    assert.equal(result.success, false);
    assert.match(result.diagnostics[0].message, /outside the range of 'u8'/);
});

test('integer conversions require integer source and target types', () => {
    const source = 'entry {{ __() -> void { local value:i64 = true as i64 } }}';
    const result = new SemanticAnalyzer().analyze(new Parser().parse(source, 'conversion.ar'));
    assert.equal(result.success, false);
    assert.match(result.diagnostics[0].message, /numeric conversion requires numeric types/);
});

test('dynamic arrays support construction, indexing, assignment, length, and append', () => {
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(arrayProgram, 'arrays.ar'));
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const operations = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions.map(i => i.op)));
    for (const operation of ['array_new', 'array_load', 'array_store', 'array_length', 'array_append']) {
        assert.ok(operations.includes(operation), `missing ${operation}`);
    }
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('arrays insert, shift, remove, and transfer removed ownership', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/array-insert-remove.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const instructions = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions));
    assert.ok(instructions.some(instruction => instruction.op === 'array_insert' && instruction.elementType === 'i16'));
    assert.ok(instructions.some(instruction => instruction.op === 'array_remove' && instruction.elementType === 'i16'));
    assert.ok(instructions.some(instruction => instruction.op === 'array_insert' && instruction.elementOwnership === 'owned'));
    assert.ok(instructions.some(instruction => instruction.op === 'array_remove' && instruction.elementOwnership === 'owned'));
    const assembly = new X86_64Backend().generate(ir);
    assert.match(assembly, /call valen_array_insert/);
    assert.match(assembly, /call valen_array_remove/);
    assert.match(assembly, /\.Larray_insert_shift:[\s\S]*\.Larray_insert_move:[\s\S]*jnz \.Larray_insert_move/);
});

test('array literals infer homogeneous element types and lower allocation plus stores', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/array-literals.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const instructions = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions));
    assert.ok(instructions.filter(instruction => instruction.op === 'array_new').length >= 6);
    assert.ok(instructions.filter(instruction => instruction.op === 'array_store').length >= 11);

    const empty = new SemanticAnalyzer().analyze(new Parser().parse('entry {{ __() -> void { local values = [] } }}', 'empty-array.ar'));
    assert.equal(empty.success, false);
    assert.match(empty.diagnostics[0].message, /Cannot infer the element type of an empty array literal/);

    const mixed = new SemanticAnalyzer().analyze(new Parser().parse('entry {{ __() -> void { local values = [1, "two"] } }}', 'mixed-array.ar'));
    assert.equal(mixed.success, false);
    assert.match(mixed.diagnostics[0].message, /Array literal element has type 'string'/);

    const consumed = new SemanticAnalyzer().analyze(new Parser().parse(
        'Item {{}} entry {{ __() -> void { local item = new Item(); local items = [item]; local duplicates = [item] } }}',
        'owned-array-literal.ar'
    ));
    assert.equal(consumed.success, false);
    assert.ok(consumed.diagnostics.some(diagnostic => /Cannot insert borrowed reference/.test(diagnostic.message)));
});

test('hashed symbol collections and parent-linked scopes resolve end to end', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/scopes.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const declarations = ir.functions.flatMap(fn => fn.blocks.flatMap(block =>
        block.instructions.filter(instruction => instruction.op === 'declare_local')));
    const markers = declarations.filter(instruction => instruction.name.startsWith('marker#'));
    assert.equal(new Set(markers.map(instruction => instruction.name)).size, 2);
    assert.ok(ir.functions.some(fn => fn.displayName === 'Scopes.SymbolMap.grow'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Scopes.StringSet.contains'));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('object allocation provides defaults before constructors run', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/default-fields.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.ok(ir.functions.flatMap(fn => fn.blocks).flatMap(block => block.instructions)
        .some(instruction => instruction.op === 'allocate' && instruction.objectType.endsWith('Defaults')));
    assert.equal(ir.functions.filter(fn => fn.name.endsWith('.$initialize')).length, 2);
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('reference identity rejects primitive operands', () => {
    const source = 'entry {{ __() -> i64 { if 1 === 1 { return 1 }\n return 0 } }}';
    const result = new SemanticAnalyzer().analyze(new Parser().parse(source, 'identity.ar'));
    assert.equal(result.success, false);
    assert.match(result.diagnostics[0].message, /compatible reference operands/);
});

test('constructor return rules distinguish entry from ordinary objects', () => {
    const valid = 'entry {{ __() -> void {} Thing {{ __() -> void {} }} }}';
    const validResult = new SemanticAnalyzer().analyze(new Parser().parse(valid, 'constructors-valid.ar'));
    assert.equal(validResult.success, true, JSON.stringify(validResult.diagnostics));

    const objectResult = new SemanticAnalyzer().analyze(new Parser().parse(
        'entry {{ __() -> i64 { return 0 } Thing {{ __() -> i64 { return 0 } }} }}',
        'constructor-object.ar'
    ));
    assert.equal(objectResult.success, false);
    assert.match(objectResult.diagnostics[0].message, /must return void/);

    const entryResult = new SemanticAnalyzer().analyze(new Parser().parse(
        'entry {{ __() -> bool { return true } }}',
        'constructor-entry.ar'
    ));
    assert.equal(entryResult.success, false);
    assert.match(entryResult.diagnostics[0].message, /void or an integer/);
});

test('process arguments and exit lower to native runtime facilities', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/process.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const assembly = new X86_64Backend().generate(ir);
    assert.match(assembly, /valen_System_arguments:/);
    assert.match(assembly, /valen_System_exit:/);
    assert.match(assembly, /valen_process_argv/);
});

test('standard output and error lower to distinct native descriptors', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/stdio.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const assembly = new X86_64Backend().generate(ir);
    assert.match(assembly, /valen_System_write:[\s\S]*?mov edi, 1/);
    assert.match(assembly, /valen_System_writeError:[\s\S]*?mov edi, 2/);
});

test('file operations lower to native open, read, write, and close facilities', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/files.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    for (const symbol of ['openRead', 'openWrite', 'read', 'writeFile', 'close']) {
        assert.match(assembly, new RegExp(`valen_System_${symbol}:`));
    }
});

test('self-hosted ELF writer lowers binary object output without string conversion', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/elf-writer.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.match(assembly, /valen_System_writeBytes:/);
    assert.match(assembly, /mov rsi, QWORD PTR \[rsi\+16\]/);
});

test('native networking lowers socket lifecycle operations without foreign libraries', () => {
    const filePath = path.join(projectRoot, 'examples/http-native/server.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.deepEqual(ir.foreignLibraries, []);
    const assembly = new X86_64Backend().generate(ir);
    for (const symbol of ['listen', 'accept', 'receive', 'send', 'closeListener', 'closeConnection', 'lastError']) {
        assert.match(assembly, new RegExp(`valen_Network_${symbol}:`));
    }
    for (const syscall of [41, 49, 50, 43]) assert.match(assembly, new RegExp(`mov eax, ${syscall}`));
});

test('native object handles transfer through owning cleanup operations and cannot be copied or deleted', () => {
    const valid = new SemanticAnalyzer().analyze(new Parser().parse(`
        library Native {{
            native acquire() -> Handle?
            native release(own handle:Handle) -> void
            Handle {{}}
        }}
        entry {{
            __() -> void {
                local handle = Native.acquire()
                if handle != null { Native.release(handle!) }
            }
        }}
    `, 'native-resource.ar'));
    assert.equal(valid.success, true, JSON.stringify(valid.diagnostics));
    const release = valid.program.libraries[0].members.find(member => member.name === 'release');
    assert.equal(release.semanticSymbol.parameters[0].ownership, 'owned');

    for (const operation of ['copy handle!', 'delete handle!']) {
        const invalid = new SemanticAnalyzer().analyze(new Parser().parse(`
            library Native {{ native acquire() -> Handle?; Handle {{}} }}
            entry {{ __() -> void { local handle = Native.acquire(); ${operation} } }}
        `, 'invalid-native-resource.ar'));
        assert.equal(invalid.success, false);
        assert.match(invalid.diagnostics[0].message, /Native resource/);
    }
});

test('unsafe native operations require an explicit lexical unsafe boundary', () => {
    const valid = new SemanticAnalyzer().analyze(new Parser().parse(`
        library Raw {{
            unsafe native touch(bytes:Array<u8>) -> void
            touchSafely(bytes:Array<u8>) -> void { unsafe { Raw.touch(bytes) } }
        }}
        entry {{ __() -> void { local bytes = new Array<u8>(1); unsafe { Raw.touch(bytes) } } }}
    `, 'unsafe-boundary.ar'));
    assert.equal(valid.success, true, JSON.stringify(valid.diagnostics));
    const ir = new IrGenerator().generate(valid);
    assert.ok(ir.externals.some(external => external.displayName === 'Raw.touch'));
    assert.throws(() => new X86_64Backend().generate(ir), /runtime does not provide valen_Raw_touch/);

    const invalid = new SemanticAnalyzer().analyze(new Parser().parse(`
        library Raw {{ unsafe native touch(bytes:Array<u8>) -> void }}
        entry {{ __() -> void { local bytes = new Array<u8>(1); Raw.touch(bytes) } }}
    `, 'unsafe-call.ar'));
    assert.equal(invalid.success, false);
    assert.match(invalid.diagnostics[0].message, /only be called inside an unsafe block/);
});

test('foreign native declarations lower explicit libraries and C symbols', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/foreign-libc.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.deepEqual(ir.foreignLibraries, ['c']);
    const external = ir.externals.find(item => item.displayName === 'Posix.processId');
    assert.equal(external.runtimeSymbol, 'getpid');
    assert.equal(external.foreignLibrary, 'c');
    assert.match(new X86_64Backend().generate(ir), /\.extern getpid/);

    for (const source of [
        'library Bad {{ native call() -> i64 from "c" as "getpid" }}',
        'library Bad {{ unsafe native call(value:string) -> i64 from "c" }}',
        'library Bad {{ unsafe native call() -> i64 from "c;rm" }}'
    ]) {
        const result = new SemanticAnalyzer().analyze(new Parser().parse(source, 'invalid-ffi.ar'));
        assert.equal(result.success, false);
    }
});

test('floating types lower literals, SSE arithmetic, conversions, and mixed ABI calls', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/floating-point.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.ok(ir.functions.flatMap(fn => fn.blocks).flatMap(block => block.instructions).some(item => item.op === 'float_constant'));
    assert.deepEqual(ir.foreignLibraries, ['m']);
    const assembly = new X86_64Backend().generate(ir);
    for (const opcode of ['addsd', 'divsd', 'ucomisd', 'cvtsi2sd', 'cvttsd2si']) assert.match(assembly, new RegExp(opcode));
    assert.match(assembly, /movq xmm7/);
    assert.match(assembly, /push rax/);
});

test('mixed-width numeric operations use a lossless common type', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/numeric-promotion.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const conversions = ir.functions.flatMap(fn => fn.blocks)
        .flatMap(block => block.instructions)
        .filter(instruction => instruction.op === 'convert');
    assert.ok(conversions.some(instruction => instruction.type === 'i16'));
    assert.ok(conversions.some(instruction => instruction.type === 'i32'));
    assert.ok(conversions.some(instruction => instruction.type === 'i64'));
    assert.ok(conversions.some(instruction => instruction.type === 'f64'));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('u64 mixed with a signed integer requires an explicit conversion', () => {
    const source = 'entry {{ __() -> void { local left:u64 = 1; local right:i64 = 1; local invalid = left + right } }}';
    const result = new SemanticAnalyzer().analyze(new Parser().parse(source, 'numeric-promotion.ar'));
    assert.equal(result.success, false);
    assert.match(result.diagnostics[0].message, /No lossless implicit promotion exists between 'u64' and 'i64'/);
});

test('generic objects monomorphize concrete invariant specializations', () => {
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(`
        Box<T> {{
            member value:T
            __(value:T) -> void { self.value = value }
            get() -> ref T { return self.value }
        }}
        Engine {{ member code:i64 }}
        entry {{
            __() -> i64 {
                local engine = new Engine()
                local box = new Box<Engine>(engine)
                return box.get().code
            }
        }}
    `, 'generic-object.ar'));
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.ok(ir.types.some(type => type.name === 'Box<Engine>'));
    assert.ok(ir.functions.some(fn => fn.owner === 'Box<Engine>' && fn.displayName.includes('.get')));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));

    const multiple = new SemanticAnalyzer().analyze(new Parser().parse(`
        Box<T> {{ member value:T; __(value:T) -> void { self.value = value } }}
        Animal {{}}
        Dog inherits Animal {{}}
        entry {{
            __() -> void {
                local animal = new Animal()
                local dog = new Dog()
                local animalBox = new Box<Animal>(animal)
                local dogBox = new Box<Dog>(dog)
            }
        }}
    `, 'generic-specializations.ar'));
    assert.equal(multiple.success, true, JSON.stringify(multiple.diagnostics));
    const multipleIr = new IrGenerator().generate(multiple);
    assert.ok(multipleIr.types.some(type => type.name === 'Box<Animal>'));
    assert.ok(multipleIr.types.some(type => type.name === 'Box<Dog>'));

    const open = new SemanticAnalyzer().analyze(new Parser().parse(`
        Box<T> {{ member value:T }}
        entry {{ __() -> void { local box:Box } }}
    `, 'open-generic.ar'));
    assert.equal(open.success, false);
    assert.match(open.diagnostics[0].message, /requires type arguments/);

    const wrongArity = new SemanticAnalyzer().analyze(new Parser().parse(`
        Pair<A, B> {{ member left:A; member right:B }}
        entry {{ __() -> void { local pair:Pair<i64> } }}
    `, 'generic-arity.ar'));
    assert.equal(wrongArity.success, false);
    assert.match(wrongArity.diagnostics[0].message, /requires 2 type arguments, got 1/);
});

test('imported generic templates specialize once in the consuming module', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-cross-module-generic-'));
    try {
        const library = path.join(directory, 'box.ar');
        const consumer = path.join(directory, 'consumer.ar');
        fs.writeFileSync(library, `
            Box<T> {{ member value:T; __(value:T) -> void { self.value = value }; get() -> T { return self.value } }}
            library Box {{}}
        `);
        fs.writeFileSync(consumer, `
            import Box from './box.ar'
            entry {{ __() -> i64 { local first = new Box<i64>(20); local second = new Box<i64>(22); return first.get() + second.get() - 42 } }}
        `);
        const semantic = new SemanticAnalyzer().analyzeFile(consumer, {sourceRoot: directory});
        assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
        const specialization = semantic.program.objects.filter(item => item.name === 'Box<i64>');
        assert.equal(specialization.length, 1);
        const ir = new IrGenerator().generate(semantic);
        assert.equal(ir.types.filter(type => type.name.endsWith('::Box<i64>')).length, 1);
        assert.doesNotThrow(() => new X86_64Backend().generate(ir));
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test('generic constraints require type arguments to satisfy contracts', () => {
    const valid = new SemanticAnalyzer().analyze(new Parser().parse(`
        Printable {{ print() -> i64 { return 0 } }}
        Report implements Printable {{ print() -> i64 { return 7 } }}
        Box<T:Printable> {{ read(value:T) -> i64 { return value.print() } }}
        entry {{ __() -> i64 { local box = new Box<Report>(); local report = new Report(); return box.read(report) - 7 } }}
    `, 'generic-constraint.ar'));
    assert.equal(valid.success, true, JSON.stringify(valid.diagnostics));
    assert.doesNotThrow(() => new X86_64Backend().generate(new IrGenerator().generate(valid)));

    const invalid = new SemanticAnalyzer().analyze(new Parser().parse(`
        Printable {{ print() -> i64 { return 0 } }}
        Engine {{}}
        Box<T:Printable> {{}}
        entry {{ __() -> void { local box = new Box<Engine>() } }}
    `, 'invalid-generic-constraint.ar'));
    assert.equal(invalid.success, false);
    assert.ok(invalid.diagnostics.some(diagnostic => /Type argument 'Engine' does not satisfy constraint 'Printable'/.test(diagnostic.message)));
});

test('unconditional field-initializer allocation cycles are rejected', () => {
    const cyclic = new SemanticAnalyzer().analyze(new Parser().parse(`
        First {{ member second:Second = new Second() }}
        Second {{ member first:First = new First() }}
        entry {{ __() -> void {} }}
    `, 'initializer-cycle.ar'));
    assert.equal(cyclic.success, false);
    assert.ok(cyclic.diagnostics.some(diagnostic => /field-initializer cycle/.test(diagnostic.message)));

    const finite = new SemanticAnalyzer().analyze(new Parser().parse(`
        Node {{ member next:Node? = null }}
        entry {{ __() -> void { local node = new Node() } }}
    `, 'finite-initializer.ar'));
    assert.equal(finite.success, true, JSON.stringify(finite.diagnostics));
});

test('runtime paths, filesystem errors, allocation checks, and memory operations lower natively', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/runtime-foundation.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    for (const symbol of ['lastError', 'currentDirectory', 'memoryCopy', 'memoryCompare']) {
        assert.match(assembly, new RegExp(`valen_System_${symbol}:`));
    }
    assert.match(assembly, /\.Lallocation_error:/);
    assert.match(assembly, /valen_arena_cursor:/);
    assert.match(assembly, /valen_System_enableProcessArena:/);
    assert.match(assembly, /mov rsi, 1048576/);
    assert.match(assembly, /lea r12, \[rdi\+15\]/);
    assert.match(assembly, /valen_gc_array_finalize:\n    cmp DWORD PTR \[rip\+valen_arena_enabled\], 0/);
    assert.match(assembly, /\.Lalloc_direct:/);
});

test('stack arguments, runtime errors, division checks, and symbol mangling are backend-safe', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/backend-completeness.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.match(assembly, /QWORD PTR \[rbp\+16\]/);
    assert.match(assembly, /push rax/);
    assert.match(assembly, /\.Lruntime_error:/);

    const divisionPath = path.join(projectRoot, 'bootstrap/test/fixtures/division-by-zero.ar');
    const division = new SemanticAnalyzer().analyzeFile(divisionPath, {sourceRoot: projectRoot});
    const divisionAssembly = new X86_64Backend().generate(new IrGenerator().generate(division));
    assert.match(divisionAssembly, /test rcx, rcx\n    jz \.Ldivision_by_zero_error/);

    const backend = new X86_64Backend();
    assert.notEqual(backend.mangle('A.B'), backend.mangle('A_2e_B'));
    assert.notEqual(backend.mangle('A/B'), backend.mangle('A_2f_B'));
});

test('linear-scan register allocation keeps primitive temporaries across calls and reduces stack slots', () => {
    const source = `entry {{
        value() -> i64 { return 20 }
        __() -> i64 { return self.value() + self.value() + self.value() }
    }}`;
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(source, 'register-allocation.ar'));
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    const constructor = assembly.match(/\.globl (__valen_entry[^\n]*_5f__5f_)\n[\s\S]*?\1__return:[\s\S]*?\n    ret/)?.[0];
    assert.ok(constructor);
    assert.match(constructor, /mov QWORD PTR \[rbp-\d+\], r1[2-5]/);
    assert.match(constructor, /call QWORD PTR[\s\S]*mov r1[2-5], rax[\s\S]*call QWORD PTR/);
    const frameSize = Number(constructor.match(/sub rsp, (\d+)/)?.[1]);
    assert.ok(frameSize <= 48, `expected an allocated frame no larger than 48 bytes, got ${frameSize}`);
});

test('instruction selection uses immediate operands and removes redundant moves', () => {
    const source = `entry {{
        calculate(value:i64) -> i64 { return ((value + 7) * 3) & 255 }
        __() -> i64 { return self.calculate(5) }
    }}`;
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(source, 'instruction-selection.ar'));
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.match(assembly, /add rax, 7/);
    assert.match(assembly, /imul rax, 3/);
    assert.match(assembly, /and rax, 255/);
    assert.doesNotMatch(assembly, /^    mov (r(?:ax|bx|cx|dx|si|di|bp|sp|8|9|1[0-5])), \1$/m);
});

test('optimization levels make O0 conservative and O1 predictably optimized', () => {
    const source = `entry {{
        calculate(value:i64) -> i64 { return (value + 7) * 3 }
        __() -> i64 { return self.calculate(5) }
    }}`;
    const analyze = () => new SemanticAnalyzer().analyze(new Parser().parse(source, 'optimization-levels.ar'));
    const unoptimized = new X86_64Backend().generate(new IrGenerator().generate(analyze()), {optimizationLevel: 0});
    const optimized = new X86_64Backend().generate(new IrGenerator().generate(analyze()), {optimizationLevel: 1});
    assert.doesNotMatch(unoptimized, /add rax, 7/);
    assert.doesNotMatch(unoptimized, /imul rax, 3/);
    assert.match(optimized, /add rax, 7/);
    assert.match(optimized, /imul rax, 3/);
    assert.throws(() => new X86_64Backend().generate(new IrGenerator().generate(analyze()), {optimizationLevel: 2}), /Unsupported optimization level/);
});

test('contract dispatch preserves register and stack arguments', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/abi-contract-arguments.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic), {optimizationLevel: 0});
    assert.match(assembly, /mov r11, QWORD PTR \[rax\+\d+\][\s\S]*call r11/);
});

test('Valen compiler source foundation and tokenizer load and lower', () => {
    const filePath = path.join(projectRoot, 'src/valen.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath,
        {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.ok(ir.types.some(type => type.displayName === 'Compiler.SourceFile'));
    assert.ok(ir.types.some(type => type.displayName === 'Compiler.SourceSpan'));
    assert.ok(ir.types.some(type => type.displayName === 'Compiler.Token'));
    const tokenType = ir.types.find(type => type.displayName === 'Compiler.Token');
    assert.match(tokenType.fields.find(field => field.name === 'kind').type, /Compiler\.TokenKind$/);
    assert.ok(ir.types.some(type => type.displayName === 'Compiler.Tokenizer'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Compiler.Tokenizer.tokenize'));
    assert.ok(ir.types.some(type => type.displayName === 'Ast.Program'));
    assert.ok(ir.types.some(type => type.displayName === 'Ast.Declaration'));
    assert.ok(ir.types.some(type => type.displayName === 'Ast.Statement'));
    assert.ok(ir.types.some(type => type.displayName === 'Ast.Expression'));
    assert.ok(ir.types.some(type => type.displayName === 'Parsing.Parser'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Parsing.Parser.parse'));
    assert.ok(ir.types.some(type => type.displayName === 'Diagnostics.Diagnostic'));
    const diagnosticType = ir.types.find(type => type.displayName === 'Diagnostics.Diagnostic');
    assert.match(diagnosticType.fields.find(field => field.name === 'severity').type, /Diagnostics\.DiagnosticSeverity$/);
    assert.ok(ir.types.some(type => type.displayName === 'Diagnostics.DiagnosticBag'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Diagnostics.format'));
    assert.ok(ir.types.some(type => type.displayName === 'ModuleLoading.Module'));
    assert.ok(ir.types.some(type => type.displayName === 'ModuleLoading.ModuleGraph'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'ModuleLoading.ModuleLoader.loadModule'));
    assert.ok(ir.types.some(type => type.displayName === 'Symbols.Symbol'));
    assert.ok(ir.types.some(type => type.displayName === 'Symbols.Scope'));
    assert.ok(ir.types.some(type => type.displayName === 'Semantics.Analysis'));
    assert.ok(ir.types.some(type => type.displayName === 'Semantics.Analyzer'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Semantics.Analyzer.analyze'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Semantics.Analyzer.analyzeExpression'));
    assert.ok(ir.types.some(type => type.displayName === 'Ir.Program'));
    assert.ok(ir.types.some(type => type.displayName === 'Ir.Instruction'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Ir.Generator.generate'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Ir.Generator.lowerExpression'));
    assert.ok(ir.types.some(type => type.displayName === 'X86_64.Backend'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'X86_64.Backend.generate'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'X86_64.Backend.generateInstruction'));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('module imports distinguish local, project-root, and ordered external-library roots', () => {
    const fixtureRoot = path.join(projectRoot, 'bootstrap/test/fixtures/library-path');
    const semantic = new SemanticAnalyzer().analyzeFile(path.join(fixtureRoot, 'app/main.ar'), {
        sourceRoot: fixtureRoot,
        libraryPath: path.join(fixtureRoot, 'lib')
    });
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    assert.ok([...semantic.modules.values()].some(module => module.path.endsWith('/lib/shared.ar')));
    assert.ok([...semantic.modules.values()].some(module => module.path.endsWith('/lib/helper.ar')));
    assert.ok(![...semantic.modules.values()].some(module => module.path.endsWith('/app/shared.ar')));

    const documents = new Map([
        [path.join(fixtureRoot, 'project/main.ar'), "import Local from './local.ar'\nimport Root from '/root.ar'\nentry {{ __() -> i64 { return 0 } }}"],
        [path.join(fixtureRoot, 'project/local.ar'), 'library Local {{}}'],
        [path.join(fixtureRoot, 'root.ar'), 'library Root {{}}']
    ]);
    const graph = new ModuleLoader({sourceRoot: fixtureRoot, documents}).load(path.join(fixtureRoot, 'project/main.ar'));
    assert.equal(graph.diagnostics.length, 0, JSON.stringify(graph.diagnostics));

    const escaped = new ModuleLoader({sourceRoot: path.join(fixtureRoot, 'app'), documents: new Map([
        [path.join(fixtureRoot, 'app/escape.ar'), "import Outside from '../outside.ar'\nentry {{ __() -> i64 { return 0 } }}"],
        [path.join(fixtureRoot, 'outside.ar'), 'library Outside {{}}']
    ])}).load(path.join(fixtureRoot, 'app/escape.ar'));
    assert.match(escaped.diagnostics[0].message, /escapes its owning root/);
});

test('Valen symbols support duplicate checks, parent lookup, and shadowing', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/native-symbols.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    assert.doesNotThrow(() => new X86_64Backend().generate(new IrGenerator().generate(semantic)));
});

test('objects inherit methods, override by name, and satisfy implemented contracts', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/inheritance.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.ok(ir.functions.some(fn => fn.displayName === 'Base.inherited'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Child.replaced'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Child.render'));
    const childType = ir.types.find(type => type.displayName === 'Child');
    assert.deepEqual(childType.fields.map(field => field.name), ['baseValue', 'childValue']);
    const childConstructor = ir.functions.find(fn => fn.displayName === 'Child.__');
    assert.ok(childConstructor.blocks.some(block => block.instructions.some(instruction =>
        instruction.op === 'call' && instruction.target.endsWith('Base.__'))));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));

    const missing = new SemanticAnalyzer().analyze(new Parser().parse(
        'Contract {{ required() -> void {} }} Broken implements Contract {{ __() -> void {} }}',
        'missing-implementation.ar'
    ));
    assert.equal(missing.success, false);
    assert.match(missing.diagnostics[0].message, /missing method 'required'/);

    const illegalSuper = new SemanticAnalyzer().analyze(new Parser().parse(
        'Plain {{ run() -> void { super() } }} entry {{ __() -> i32 { return 0 } }}',
        'illegal-super.ar'
    ));
    assert.equal(illegalSuper.success, false);
    assert.match(illegalSuper.diagnostics[0].message, /only valid in a child constructor/);
});

test('subtypes preserve identity, dispatch overrides, and support checked recovery', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/subtypes.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const operations = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions.map(i => i.op)));
    assert.ok(operations.includes('virtual_call'));
    assert.ok(operations.includes('type_test'));
    assert.ok(operations.includes('checked_cast'));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('one-word contract references dispatch through concrete object descriptors', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/contract-references.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const operations = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions.map(i => i.op)));
    assert.ok(operations.includes('contract_call'));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));

    const hiddenField = new SemanticAnalyzer().analyze(new Parser().parse(
        'Contract {{ member storage:i64; required() -> i64 { return self.storage } }} Impl implements Contract {{ required() -> i64 { return 1 } }} entry {{ __() -> i32 { local value:Contract = new Impl(); return value.storage as i32 } }}',
        'contract-field.ar'
    ));
    assert.equal(hiddenField.success, false);
    assert.match(hiddenField.diagnostics[0].message, /does not expose field 'storage'/);
});

test('contracts cross modules, inherit requirements, and compose operation capabilities', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/contracts/contract-stress.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const contractCalls = ir.functions.flatMap(fn => fn.blocks.flatMap(block =>
        block.instructions.filter(instruction => instruction.op === 'contract_call')));
    assert.ok(contractCalls.length >= 10);
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('operation state has stable success, failure, cancellation, and waiting semantics', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/operation-state.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.ok(ir.functions.some(fn => fn.displayName === 'Operations.Operation.wait'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'ManualOperation.cancel'));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));

    const reusedWork = new SemanticAnalyzer().analyze(new Parser().parse(
        'Result {{}} Work {{ run() -> Result { return new Result() } }} Executor {{ submit(own work:Work) -> Result { return work.run() } }} Job implements Work {{ run() -> Result { return new Result() } }} Direct implements Executor {{ submit(own work:Work) -> Result { return work.run() } }} entry {{ __() -> void { local executor:Executor = new Direct(); local work = new Job(); executor.submit(work); executor.submit(work) } }}',
        'submitted-work-reuse.ar'
    ));
    assert.equal(reusedWork.success, false);
    assert.match(reusedWork.diagnostics[0].message, /Cannot pass borrowed reference 'work'/);
});

test('native synchronization and pooled execution coordinate with tracing collection', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/threading.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const assembly = new X86_64Backend().generate(ir);
    assert.match(assembly, /valen_Operations_threadStart:/);
    assert.match(assembly, /call pthread_create/);
    assert.match(assembly, /lock inc QWORD PTR \[rip\+valen_gc_workers\]/);
    assert.match(assembly, /lock dec QWORD PTR \[rip\+valen_gc_workers\]/);
    assert.match(assembly, /valen_gc_root_push:/);
    assert.match(assembly, /valen_gc_root_pop:/);
    assert.match(assembly, /valen_gc_collect:[\s\S]*cmp QWORD PTR \[rip\+valen_gc_workers\], 0/);
    assert.match(assembly, /valen_gc_mutator_register:[\s\S]*call valen_gc_state_lock[\s\S]*inc QWORD PTR \[rip\+valen_gc_mutators\]/);
    assert.match(assembly, /valen_gc_safepoint:[\s\S]*valen_gc_parked/);
    assert.match(assembly, /valen_gc_collect:[\s\S]*valen_gc_request[\s\S]*\.Lgc_collect_wait/);
    assert.match(assembly, /valen_Operations_conditionWait:[\s\S]*call valen_gc_mutator_leave[\s\S]*call valen_gc_mutator_enter/);
    assert.match(assembly, /lock cmpxchg DWORD PTR/);
    assert.match(assembly, /lock xadd QWORD PTR/);
});

test('readiness work lowers through the event-loop executor and poll runtime', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/event-loop.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.match(assembly, /valen_EventLoop_available:/);
    assert.match(assembly, /valen_EventLoop_wait:[\s\S]*?mov eax, 7/);
});

test('members default public while private members stay owner-only and non-virtual', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/visibility.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const vault = ir.types.find(type => type.displayName === 'Vault');
    assert.ok(!vault.virtualMethods.some(method => method.name === 'doubled'));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));

    const inaccessible = new SemanticAnalyzer().analyze(new Parser().parse(
        'Secret {{ private hidden() -> i64 { return 1 } }} entry {{ __() -> i32 { local secret = new Secret(); secret.hidden(); return 0 } }}',
        'private-access.ar'
    ));
    assert.equal(inaccessible.success, false);
    assert.match(inaccessible.diagnostics[0].message, /Private method 'Secret.hidden' is not visible/);

    const override = new SemanticAnalyzer().analyze(new Parser().parse(
        'Base {{ private hidden() -> i64 { return 1 } }} Child inherits Base {{ hidden() -> i64 { return 2 } }} entry {{ __() -> i32 { return 0 } }}',
        'private-override.ar'
    ));
    assert.equal(override.success, false);
    assert.match(override.diagnostics[0].message, /cannot replace private method/);
});

test('methods and constructors resolve overloads by parameter signature', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/overloads.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.ok(ir.functions.some(fn => fn.displayName.includes('Base.add#i64,i64')));
    assert.ok(ir.functions.some(fn => fn.displayName.includes('Base.add#string,string')));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));

    const duplicate = new SemanticAnalyzer().analyze(new Parser().parse(
        'Duplicate {{ run(value:i64) -> i64 { return value } run(value:i64) -> string { return "bad" } }} entry {{ __() -> i32 { return 0 } }}',
        'duplicate-overload.ar'
    ));
    assert.equal(duplicate.success, false);
    assert.match(duplicate.diagnostics[0].message, /Duplicate overload/);

    const missing = new SemanticAnalyzer().analyze(new Parser().parse(
        'Only {{ run(value:string) -> void {} }} entry {{ __() -> i32 { local value = new Only(); value.run(1); return 0 } }}',
        'missing-overload.ar'
    ));
    assert.equal(missing.success, false);
    assert.match(missing.diagnostics[0].message, /No overload/);
});

test('trailing default arguments lower at method, constructor, and super call sites', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/default-arguments.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));

    const invalidOrder = new SemanticAnalyzer().analyze(new Parser().parse(
        'Bad {{ run(first:i64=0, second:i64) -> void {} }} entry {{ __() -> i32 { return 0 } }}',
        'invalid-default-order.ar'
    ));
    assert.equal(invalidOrder.success, false);
    assert.match(invalidOrder.diagnostics[0].message, /cannot follow a default parameter/);

    const ambiguous = new SemanticAnalyzer().analyze(new Parser().parse(
        'Choice {{ run(value:i64) -> i64 { return 1 } run(value:i64, extra:i64=0) -> i64 { return 2 } }} entry {{ __() -> i32 { local choice = new Choice(); return choice.run(1) as i32 } }}',
        'ambiguous-default.ar'
    ));
    assert.equal(ambiguous.success, false);
    assert.match(ambiguous.diagnostics[0].message, /ambiguous/);
});

test('structural equality and hashing are cycle-safe and preserve identity operators', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/structural-equality.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.ok(ir.functions.some(fn => fn.blocks.some(block => block.instructions.some(instruction => instruction.op === 'structural_equal'))));
    assert.ok(ir.functions.some(fn => fn.blocks.some(block => block.instructions.some(instruction => instruction.op === 'structural_hash'))));
    assert.ok(ir.functions.some(fn => fn.blocks.some(block => block.instructions.some(instruction => instruction.op === 'structural_copy'))));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('owning members receive transferred values while copy creates a second owner', () => {
    const program = new Parser().parse(`
        Engine {{}}
        Holder {{
            member first:Engine?
            member second:Engine?
            set(own value:Engine) -> void {
                self.first = value
                self.second = copy value
            }
        }}
        entry {{ __() -> void {} }}
    `, 'ownership-transfer.ar');
    const valid = new SemanticAnalyzer().analyze(program);
    assert.equal(valid.success, true, JSON.stringify(valid.diagnostics));
    const holder = program.objects.find(declaration => declaration.name === 'Holder');
    const method = holder.members.find(member => member.name === 'set');
    assert.equal(method.body.statements[0].expression.ownership, 'transfer');
    assert.equal(method.body.statements[1].expression.ownership, 'transfer');
});

test('ref members borrow without consuming the assigned owner', () => {
    const program = new Parser().parse(`
        Engine {{} }
        Holder {{
            member ref engine:Engine?
            attach(value:Engine) -> void { self.engine = value }
        }}
        entry {{ __() -> void {} }}
    `, 'member-reference.ar');
    const valid = new SemanticAnalyzer().analyze(program);
    assert.equal(valid.success, true, JSON.stringify(valid.diagnostics));
    const holder = program.objects.find(declaration => declaration.name === 'Holder');
    const field = holder.members.find(member => member.name === 'engine');
    const assignment = holder.members.find(member => member.name === 'attach').body.statements[0].expression;
    assert.equal(field.semanticSymbol.ownership, 'member-reference');
    assert.notEqual(assignment.ownership, 'transfer');

    const invalid = new SemanticAnalyzer().analyze(new Parser().parse(`
        Holder {{ member ref count:i64 }}
        entry {{ __() -> void {} }}
    `, 'invalid-member-reference.ar'));
    assert.equal(invalid.success, false);
    assert.match(invalid.diagnostics[0].message, /'ref' requires an object, array, or builder member/);
});

test('weak members are nullable, non-owning, and retained in IR', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/weak-reference.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const observer = semantic.program.objects.find(declaration => declaration.name === 'Observer');
    const field = observer.members.find(member => member.name === 'engine');
    const assignment = observer.members.find(member => member.name === 'watch').body.statements[0].expression;
    assert.equal(field.semanticSymbol.ownership, 'member-weak');
    assert.notEqual(assignment.ownership, 'transfer');
    const ir = new IrGenerator().generate(semantic);
    assert.equal(ir.types.find(type => type.displayName === 'Observer').fields[0].ownership, 'member-weak');
    assert.ok(ir.functions.some(fn => fn.blocks.some(block => block.instructions.some(instruction => instruction.op === 'destroy_object'))));
    const assembly = new X86_64Backend().generate(ir);
    assert.match(assembly, /cmp QWORD PTR \[rax\+8\], 0/);

    const invalid = new SemanticAnalyzer().analyze(new Parser().parse(`
        Engine {{}}
        Observer {{ member weak engine:Engine }}
        entry {{ __() -> void {} }}
    `, 'invalid-weak-reference.ar'));
    assert.equal(invalid.success, false);
    assert.match(invalid.diagnostics[0].message, /'weak' requires an optional object member/);

    const useAfterDelete = new SemanticAnalyzer().analyze(new Parser().parse(`
        Engine {{ inspect() -> void {} }}
        entry {{ __() -> void { local engine = new Engine(); delete engine; engine.inspect() } }}
    `, 'use-after-delete.ar'));
    assert.equal(useAfterDelete.success, false);
    assert.match(useAfterDelete.diagnostics[0].message, /was already deleted/);
});

test('parameters borrow by default while own parameters consume caller ownership', () => {
    const valid = new SemanticAnalyzer().analyze(new Parser().parse(`
        Engine {{}}
        Sink {{
            inspect(value:Engine) -> void {}
            retain(own value:Engine) -> void {}
        }}
        entry {{
            __() -> void {
                local engine = new Engine()
                local sink = new Sink()
                sink.inspect(engine)
                sink.retain(engine)
                sink.inspect(engine)
            }
        }}
    `, 'parameter-borrowing.ar'));
    assert.equal(valid.success, true, JSON.stringify(valid.diagnostics));

    const invalid = new SemanticAnalyzer().analyze(new Parser().parse(`
        Engine {{}}
        Sink {{ retain(own value:Engine) -> void {} }}
        entry {{
            __() -> void {
                local engine = new Engine()
                local sink = new Sink()
                sink.retain(engine)
                sink.retain(engine)
            }
        }}
    `, 'parameter-double-consume.ar'));
    assert.equal(invalid.success, false);
    assert.match(invalid.diagnostics[0].message, /Cannot pass borrowed reference 'engine'/);
    assert.equal(invalid.diagnostics[0].labels.length, 2);
    assert.match(invalid.diagnostics[0].labels[1].message, /takes ownership/);
    assert.deepEqual(invalid.diagnostics[0].notes, ['ordinary arguments borrow references unless ownership is transferred explicitly']);
    assert.equal(invalid.diagnostics[0].fixes[0].replacement, 'copy engine');
    assert.match(formatDiagnostic(invalid.diagnostics[0]), /--> parameter-double-consume\.ar:3:\d+: parameter 'value' takes ownership[\s\S]*note:[\s\S]*help:[\s\S]*replace with 'copy engine'/);

    const lifetime = new SemanticAnalyzer().analyze(new Parser().parse(`
        Engine {{ inspect() -> void {} }}
        entry {{
            __() -> void {
                local engine = new Engine()
                local alias = engine
                alias.inspect()
                engine = new Engine()
                alias.inspect()
            }
        }}
    `, 'expired-local-borrow.ar'));
    assert.equal(lifetime.success, false);
    assert.match(lifetime.diagnostics[0].message, /outlives the value previously held by 'engine'/);
});

test('reference returns transfer owners while borrowed returns are explicit', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/return-lifetimes.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.ok(ir.functions.some(fn => fn.blocks.some(block => block.instructions.some(instruction => instruction.op === 'destroy_object'))));

    const invalid = new SemanticAnalyzer().analyze(new Parser().parse(`
        Engine {{} }
        Factory {{ leak(value:Engine) -> Engine { return value } }}
        entry {{ __() -> void {} }}
    `, 'borrowed-return.ar'));
    assert.equal(invalid.success, false);
    assert.match(invalid.diagnostics[0].message, /requires an owned value/);

    const borrowed = new SemanticAnalyzer().analyze(new Parser().parse(`
        Engine {{} }
        Factory {{ identity(value:Engine) -> ref Engine { return value } }}
        entry {{ __() -> void {} }}
    `, 'explicit-borrowed-return.ar'));
    assert.equal(borrowed.success, true, JSON.stringify(borrowed.diagnostics));
});

test('array insertion transfers element ownership through semantic analysis and IR', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/collection-ownership.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const instructions = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions));
    assert.ok(instructions.some(instruction => instruction.op === 'array_append' && instruction.elementOwnership === 'owned'));
    assert.ok(instructions.some(instruction => instruction.op === 'array_append' && instruction.elementOwnership === 'ref'));
    assert.ok(instructions.some(instruction => instruction.op === 'array_append' && instruction.elementOwnership === 'weak'));
    assert.ok(instructions.some(instruction => instruction.op === 'array_store' && instruction.elementOwnership === 'owned'));
    assert.ok(instructions.some(instruction => instruction.op === 'array_load' && instruction.elementOwnership === 'weak'));
    const assembly = new X86_64Backend().generate(ir);
    assert.match(assembly, /call valen_array_append/);
    assert.match(assembly, /mov QWORD PTR \[rdx\+8\], 0/);
    assert.match(assembly, /cmp QWORD PTR \[rax\+8\], 0/);
});

test('managed objects publish precise roots, trace callbacks, and runtime finalizers', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/garbage-collection.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.match(assembly, /valen_gc_roots/);
    assert.match(assembly, /call valen_gc_mark/);
    assert.match(assembly, /valen_gc_collect:/);
    assert.match(assembly, /valen_gc_array_finalize:/);
    assert.match(assembly, /call rax\n\.Lgc_unmap:/);
    assert.match(assembly, /valen_System_collectGarbage:/);
});

test('managed allocation triggers adaptive collection and native handles use GC layout', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/garbage-collection-repeated.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.match(assembly, /valen_gc_alloc:[\s\S]*call valen_gc_maybe_collect/);
    assert.match(assembly, /valen_gc_alloc:[\s\S]*cmp DWORD PTR \[rip\+valen_arena_enabled\], 0[\s\S]*call valen_alloc[\s\S]*\.Lgc_alloc_direct:/);
    assert.match(assembly, /valen_gc_maybe_collect:[\s\S]*cmp rax, QWORD PTR \[rip\+valen_gc_threshold\][\s\S]*jmp valen_gc_collect/);
    assert.match(assembly, /valen_Network_listen:[\s\S]*call valen_gc_alloc[\s\S]*mov QWORD PTR \[rax\+16\], r12/);
    assert.match(assembly, /valen_gc_native_handle_finalize:[\s\S]*mov QWORD PTR \[r10\+16\], -1/);
});

test('runtime GC metrics count allocations, roots, collections, and reclamation', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/runtime-metrics.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const disabled = new X86_64Backend().generate(structuredClone(ir));
    assert.doesNotMatch(disabled, /valen_gc_(allocated_bytes|objects|root_count|peak_roots|collections|reclaimed_objects|reclaimed_bytes|weak_cleared|weak_retained|native_handles_open|native_handles_finalized)/);
    const assembly = new X86_64Backend().generate(ir, {runtimeMetrics: true});
    assert.match(assembly, /valen_System_gcTrackedBytes:[\s\S]*valen_gc_bytes/);
    assert.match(assembly, /valen_gc_alloc:[\s\S]*valen_gc_allocated_bytes[\s\S]*valen_gc_objects/);
    assert.match(assembly, /valen_gc_root_push:[\s\S]*valen_gc_root_count[\s\S]*valen_gc_peak_roots/);
    assert.match(assembly, /\.Lgc_collect_begin:[\s\S]*valen_gc_collections/);
    assert.match(assembly, /\.Lgc_reclaim:[\s\S]*valen_gc_reclaimed_objects[\s\S]*valen_gc_reclaimed_bytes/);
    assert.match(assembly, /valen_System_gcWeakReferencesCleared:[\s\S]*valen_gc_weak_cleared/);
    assert.match(assembly, /valen_gc_native_handle_finalize:[\s\S]*valen_gc_native_handles_open[\s\S]*valen_gc_native_handles_finalized/);
});

test('production runtime omits metrics storage and counter updates', () => {
    const semantic = new SemanticAnalyzer().analyzeFile(path.join(projectRoot, 'bootstrap/test/fixtures/garbage-collection-repeated.ar'), {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.doesNotMatch(assembly, /valen_gc_(allocated_bytes|objects|root_count|peak_roots|collections|reclaimed_objects|reclaimed_bytes|weak_cleared|weak_retained|native_handles_open|native_handles_finalized)/);
});

test('shutdown signals lower to async-safe flags checked by application safe points', () => {
    const semantic = new SemanticAnalyzer().analyzeFile(path.join(projectRoot, 'examples/clippy/server.ar'), {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.match(assembly, /valen_System_enableShutdownSignals:[\s\S]*mov edi, 2[\s\S]*mov edi, 15[\s\S]*valen_System_shutdownRequested:/);
    assert.match(assembly, /\.Lshutdown_signal_handler:[\s\S]*mov QWORD PTR \[rip\+valen_shutdown_requested\], 1/);
});

test('UTF-8 strings support length, byte indexing, equality, concatenation, and slicing', () => {
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(stringProgram, 'strings.ar'));
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const operations = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions.map(i => i.op)));
    for (const operation of ['string_constant', 'string_length', 'string_load', 'string_equal', 'string_concat', 'string_slice']) {
        assert.ok(operations.includes(operation), `missing ${operation}`);
    }
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('integer formatting and StringBuilder produce immutable strings', () => {
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(builderProgram, 'builder.ar'));
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const operations = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions.map(i => i.op)));
    for (const operation of ['integer_to_string', 'builder_new', 'builder_append_string', 'builder_append_byte', 'builder_length', 'builder_build']) {
        assert.ok(operations.includes(operation), `missing ${operation}`);
    }
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('string interpolation parses nested expressions and lowers through one builder', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/string-interpolation.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const operations = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions.map(instruction => instruction.op)));
    assert.ok(operations.includes('builder_new'));
    assert.ok(operations.includes('integer_to_string'));
    assert.ok(operations.includes('builder_append_string'));
    assert.ok(operations.includes('builder_build'));

    const invalid = new SemanticAnalyzer().analyze(new Parser().parse('entry {{ __() -> void { local value = "bad ${true}" } }}', 'invalid-interpolation.ar'));
    assert.equal(invalid.success, false);
    assert.ok(invalid.diagnostics.some(diagnostic => /requires a string or integer/.test(diagnostic.message)));
});

test('strings and byte arrays convert and append through bulk-copy builder operations', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/byte-conversions.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const operations = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions.map(instruction => instruction.op)));
    assert.ok(operations.includes('string_to_bytes'));
    assert.ok(operations.includes('bytes_to_string'));
    assert.ok(operations.includes('builder_append_bytes'));
    const assembly = new X86_64Backend().generate(ir);
    assert.match(assembly, /valen_builder_append_raw:[\s\S]*rep movsb/);
    assert.doesNotMatch(assembly, /\.Lbuilder_append_(?:loop|next):/);

    const invalid = new SemanticAnalyzer().analyze(new Parser().parse('entry {{ __() -> void { local builder = new StringBuilder(); builder.appendBytes("no") } }}', 'invalid-append-bytes.ar'));
    assert.equal(invalid.success, false);
    assert.ok(invalid.diagnostics.some(diagnostic => /Array<u8>/.test(diagnostic.message)));
});

test('optional references and diagnostic collections resolve end to end', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/diagnostics.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const operations = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions.map(i => i.op)));
    assert.ok(operations.includes('unwrap'));
    assert.ok(ir.functions.some(fn => fn.blocks.some(block => block.label.startsWith('propagate_null'))));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('primitive optionals preserve zero, null, narrowing, propagation, calls, and fields', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/optional-primitives.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const instructions = ir.functions.flatMap(fn => fn.blocks.flatMap(block => block.instructions));
    assert.ok(instructions.some(instruction => instruction.op === 'optional_box' && instruction.valueType === 'i64'));
    assert.ok(instructions.some(instruction => instruction.op === 'optional_box' && instruction.valueType === 'f64'));
    assert.ok(instructions.some(instruction => instruction.op === 'unwrap' && instruction.optionalType === 'i64?'));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('optional propagation is restricted to optional-returning methods', () => {
    const source = 'entry {{ __() -> void { local value:string? = null\n local resolved = value? } }}';
    const result = new SemanticAnalyzer().analyze(new Parser().parse(source, 'propagation.ar'));
    assert.equal(result.success, false);
    assert.match(result.diagnostics[0].message, /enclosing method to return an optional type/);
});

test('optional locals and parameters narrow across branches, guards, logical expressions, and loops', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/optional-narrowing.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('assignment invalidates optional narrowing', () => {
    const source = `Box {{ member value:i64 }} entry {{ read(box:Box?) -> i64 {
        if box != null { box = null; return box.value }
        return 0
    } __() -> void {} }}`;
    const result = new SemanticAnalyzer().analyze(new Parser().parse(source, 'narrowing-assignment.ar'));
    assert.equal(result.success, false);
    assert.match(result.diagnostics.at(-1).message, /Type 'Box\?' has no members/);
});

test('result propagation unwraps valid values and returns invalid results', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/result-propagation.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const propagation = ir.functions.flatMap(fn => fn.blocks)
        .find(block => block.label.startsWith('propagate_value'));
    assert.ok(propagation?.instructions.some(instruction => instruction.op === 'load_field' && instruction.type === 'i64'));
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('result propagation requires the result protocol and matching return type', () => {
    const missingProtocol = 'Value {{ member value:i64 }} entry {{ bad(value:Value) -> Value { return value? } __() -> void {} }}';
    const missing = new SemanticAnalyzer().analyze(new Parser().parse(missingProtocol, 'missing-result.ar'));
    assert.equal(missing.success, false);
    assert.match(missing.diagnostics[0].message, /result object with public 'valid:bool' and 'value' fields/);

    const wrongReturn = 'Result {{ member valid:bool; member value:i64 }} entry {{ bad(value:Result) -> i64 { return value? } __() -> void {} }}';
    const wrong = new SemanticAnalyzer().analyze(new Parser().parse(wrongReturn, 'wrong-result.ar'));
    assert.equal(wrong.success, false);
    assert.match(wrong.diagnostics[0].message, /enclosing method to return 'Result'/);
});

test('test suites lower expectations into a native failure-counting runner', () => {
    const source = `test arithmetic {{
        passing() -> void { expect(2 + 2 == 4) }
        failing() -> void { expect(2 + 2 == 5) }
    }}`;
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(source, 'tests.ar'));
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.equal(ir.entry, '$valen.test.run');
    assert.equal(ir.functions.filter(fn => fn.name.startsWith('arithmetic.')).length, 2);
    assert.ok(ir.functions.flatMap(fn => fn.blocks).flatMap(block => block.instructions).some(instruction => instruction.op === 'test_expect'));
    assert.match(new X86_64Backend().generate(ir), /valen_test_failures/);
});

test('expect is rejected outside test suites', () => {
    const result = new SemanticAnalyzer().analyze(new Parser().parse('entry {{ __() -> void { expect(true) } }}', 'invalid-expect.ar'));
    assert.equal(result.success, false);
    assert.match(result.diagnostics[0].message, /only available inside a test suite/);
});

test('logical operators lower their right operands into short-circuit blocks', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/short-circuit.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath);
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const fn = ir.functions.find(candidate => candidate.name === ir.entry);
    assert.equal(fn.blocks.filter(block => block.label.startsWith('short_right')).length, 2);
    assert.equal(fn.blocks.filter(block => block.label.startsWith('short_end')).length, 2);
    assert.equal(fn.blocks.flatMap(block => block.instructions).filter(instruction => instruction.op === 'binary' && ['&&', '||'].includes(instruction.operator)).length, 0);
});

test('for loops iterate arrays and strings with loop-local values', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/for-loops.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath);
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    const instructions = ir.functions.flatMap(fn => fn.blocks).flatMap(block => block.instructions);
    assert.ok(instructions.some(instruction => instruction.op === 'array_load'));
    assert.ok(instructions.some(instruction => instruction.op === 'string_load'));
    assert.ok(instructions.some(instruction => instruction.op === 'call' && instruction.target.endsWith('Counter.hasNext')));
    assert.ok(instructions.some(instruction => instruction.op === 'call' && instruction.target.endsWith('Counter.next')));
    assert.ok(ir.functions.flatMap(fn => fn.blocks).some(block => block.label.startsWith('for_increment')));
});

test('for loops reject non-iterable values', () => {
    const source = 'entry {{ __() -> void { for value in 42 { } } }}';
    const result = new SemanticAnalyzer().analyze(new Parser().parse(source, 'invalid-for.ar'));
    assert.equal(result.success, false);
    assert.match(result.diagnostics[0].message, /not iterable/);
});

test('IR canonicalization removes unreachable blocks and instructions after terminators', () => {
    const fn = {name: 'entry.__', owner: 'entry', parameters: [{name: 'self', type: 'entry'}], returnType: 'void', blocks: [
        {label: 'entry', instructions: [{op: 'return'}, {op: 'constant', result: '%0', type: 'i64', value: 1}]},
        {label: 'dead', instructions: [{op: 'return'}]}
    ]};
    const program = {types: [{name: 'entry', fields: [], virtualMethods: [], contracts: []}], functions: [fn], externals: [], entry: fn.name};
    new IrCanonicalizer().run(program);
    assert.deepEqual(fn.blocks.map(block => block.label), ['entry']);
    assert.deepEqual(fn.blocks[0].instructions.map(instruction => instruction.op), ['return']);
    assert.doesNotThrow(() => new IrValidator().validate(program));
});

test('IR optimization folds constants, simplifies branches, and removes dead pure values', () => {
    const temporary = (name, type = 'i64') => ({kind: 'temporary', name, type});
    const fn = {name: 'entry.__', owner: 'entry', parameters: [{name: 'self', type: 'entry'}], returnType: 'i64', blocks: [
        {label: 'entry', instructions: [
            {op: 'constant', result: '%0', type: 'i64', value: 2},
            {op: 'constant', result: '%1', type: 'i64', value: 3},
            {op: 'binary', result: '%2', type: 'i64', operator: '+', left: temporary('%0'), right: temporary('%1')},
            {op: 'constant', result: '%3', type: 'i64', value: 5},
            {op: 'binary', result: '%4', type: 'bool', operator: '==', left: temporary('%2'), right: temporary('%3')},
            {op: 'branch', condition: temporary('%4', 'bool'), thenTarget: 'live', elseTarget: 'dead'}
        ]},
        {label: 'live', instructions: [
            {op: 'constant', result: '%5', type: 'i64', value: 99},
            {op: 'constant', result: '%6', type: 'i64', value: 1},
            {op: 'constant', result: '%7', type: 'i64', value: 0},
            {op: 'binary', result: '%8', type: 'i64', operator: '/', left: temporary('%6'), right: temporary('%7')},
            {op: 'return', value: temporary('%2')}
        ]},
        {label: 'dead', instructions: [{op: 'return', value: temporary('%3')}]}
    ]};
    const program = {types: [{name: 'entry', fields: [], virtualMethods: [], contracts: []}], functions: [fn], externals: [], entry: fn.name};
    new IrCanonicalizer().run(program);
    assert.deepEqual(fn.blocks.map(block => block.label), ['entry', 'live']);
    assert.deepEqual(fn.blocks[0].instructions.map(instruction => instruction.op), ['constant', 'jump']);
    assert.equal(fn.blocks[0].instructions[0].value, '5');
    assert.equal(fn.blocks[0].instructions[1].target, 'live');
    assert.ok(!fn.blocks.flatMap(block => block.instructions).some(instruction => instruction.result === '%5'));
    assert.ok(fn.blocks.flatMap(block => block.instructions).some(instruction => instruction.result === '%8' && instruction.op === 'binary'));
    assert.doesNotThrow(() => new IrValidator().validate(program));
});

test('IR optimization bypasses jump-only blocks and folds identical branch targets', () => {
    const condition = {kind: 'parameter', name: 'condition', type: 'bool'};
    const create = () => ({name: 'entry.__', owner: 'entry', parameters: [condition], returnType: 'void', blocks: [
        {label: 'entry', instructions: [{op: 'branch', condition, thenTarget: 'left', elseTarget: 'right'}]},
        {label: 'left', instructions: [{op: 'jump', target: 'exit'}]},
        {label: 'right', instructions: [{op: 'jump', target: 'exit'}]},
        {label: 'exit', instructions: [{op: 'return'}]}
    ]});
    const optimized = create();
    new IrCanonicalizer().canonicalizeFunction(optimized, true);
    assert.deepEqual(optimized.blocks.map(block => block.label), ['entry', 'exit']);
    assert.deepEqual(optimized.blocks[0].instructions, [{op: 'jump', target: 'exit'}]);
    const unoptimized = create();
    new IrCanonicalizer().canonicalizeFunction(unoptimized, false);
    assert.equal(unoptimized.blocks[0].instructions[0].op, 'branch');
    assert.deepEqual(unoptimized.blocks.map(block => block.label), ['entry', 'left', 'right', 'exit']);
});

test('IR optimization discovers predecessors and splits critical edges deterministically', () => {
    const condition = {kind: 'parameter', name: 'condition', type: 'bool'};
    const create = () => ({name: 'entry.__', owner: 'entry', parameters: [condition], returnType: 'void', blocks: [
        {label: 'entry', instructions: [{op: 'branch', condition, thenTarget: 'left', elseTarget: 'right'}]},
        {label: 'left', instructions: [{op: 'branch', condition, thenTarget: 'join', elseTarget: 'left_exit'}]},
        {label: 'right', instructions: [{op: 'jump', target: 'join'}]},
        {label: 'join', instructions: [{op: 'return'}]},
        {label: 'left_exit', instructions: [{op: 'return'}]}
    ]});
    const canonicalizer = new IrCanonicalizer();
    const optimized = create();
    assert.deepEqual(canonicalizer.predecessors(optimized).get('join'), ['left', 'right']);
    canonicalizer.canonicalizeFunction(optimized, true);
    const left = optimized.blocks.find(block => block.label === 'left');
    assert.equal(left.instructions[0].thenTarget, 'critical_edge_1');
    assert.deepEqual(optimized.blocks.find(block => block.label === 'critical_edge_0').instructions, [{op: 'jump', target: 'join'}]);
    assert.deepEqual(optimized.blocks.find(block => block.label === 'critical_edge_1').instructions, [{op: 'jump', target: 'join'}]);
    assert.deepEqual(canonicalizer.predecessors(optimized).get('join'), ['critical_edge_0', 'critical_edge_1']);

    const unoptimized = create();
    canonicalizer.canonicalizeFunction(unoptimized, false);
    assert.ok(!unoptimized.blocks.some(block => block.label.startsWith('critical_edge_')));
});

test('IR validation accepts complete loop values and rejects mismatched incoming edges', () => {
    const initial = {kind: 'parameter', name: 'initial', type: 'i64'};
    const condition = {kind: 'parameter', name: 'condition', type: 'bool'};
    const loop = {kind: 'temporary', name: '%loop', type: 'i64'};
    const next = {kind: 'temporary', name: '%next', type: 'i64'};
    const fn = {name: 'entry.__', owner: 'entry', parameters: [{name: 'initial', type: 'i64'}, {name: 'condition', type: 'bool'}], returnType: 'i64', blocks: [
        {label: 'entry', instructions: [{op: 'jump', target: 'header'}]},
        {label: 'header', instructions: [
            {op: 'loop_value', result: '%loop', type: 'i64', first: initial, second: next, target: 'entry', alternateTarget: 'body'},
            {op: 'branch', condition, thenTarget: 'body', elseTarget: 'exit'}
        ]},
        {label: 'body', instructions: [
            {op: 'constant', result: '%one', type: 'i64', value: '1'},
            {op: 'binary', result: '%next', type: 'i64', operator: '+', left: loop, right: {kind: 'temporary', name: '%one', type: 'i64'}},
            {op: 'jump', target: 'header'}
        ]},
        {label: 'exit', instructions: [{op: 'return', value: loop}]}
    ]};
    const program = {types: [{name: 'entry', fields: [], virtualMethods: [], contracts: []}], functions: [fn], externals: [], entry: fn.name};
    assert.doesNotThrow(() => new IrValidator().validate(program));
    const invalid = structuredClone(program);
    invalid.functions[0].blocks[1].instructions[0].alternateTarget = 'exit';
    assert.throws(() => new IrValidator().validate(invalid), /incoming blocks do not match block predecessors/);
});

test('native backends lower loop values as staged parallel copies', () => {
    const parameter = (name, type) => ({kind: 'parameter', name, type});
    const temporary = (name, type) => ({kind: 'temporary', name, type});
    const first = temporary('%first', 'i64');
    const second = temporary('%second', 'i64');
    const fn = {name: 'entry.__', owner: 'entry', parameters: [{name: 'a', type: 'i64'}, {name: 'b', type: 'i64'}, {name: 'condition', type: 'bool'}], returnType: 'i64', blocks: [
        {label: 'entry', instructions: [{op: 'jump', target: 'header'}]},
        {label: 'header', instructions: [
            {op: 'loop_value', result: '%first', type: 'i64', first: parameter('a', 'i64'), second, target: 'entry', alternateTarget: 'body'},
            {op: 'loop_value', result: '%second', type: 'i64', first: parameter('b', 'i64'), second: first, target: 'entry', alternateTarget: 'body'},
            {op: 'branch', condition: parameter('condition', 'bool'), thenTarget: 'body', elseTarget: 'exit'}
        ]},
        {label: 'body', instructions: [{op: 'constant', result: '%keep_body', type: 'i64', value: '0'}, {op: 'jump', target: 'header'}]},
        {label: 'exit', instructions: [{op: 'return', value: first}]}
    ]};
    const create = () => ({types: [{name: 'entry', fields: [], virtualMethods: [], contracts: []}], functions: [structuredClone(fn)], externals: [], entry: fn.name});

    const x86 = new X86_64Backend().generate(create(), {optimizationLevel: 0});
    const x86Body = x86.slice(x86.indexOf('__body:'), x86.indexOf('__exit:'));
    assert.match(x86Body, /mov rax, QWORD PTR \[rbp-\d+\]\n    mov QWORD PTR \[rbp-\d+\], rax\n    mov rax, QWORD PTR \[rbp-\d+\]\n    mov QWORD PTR \[rbp-\d+\], rax\n    mov rax, QWORD PTR \[rbp-\d+\]\n    mov QWORD PTR \[rbp-\d+\], rax\n    mov rax, QWORD PTR \[rbp-\d+\]\n    mov QWORD PTR \[rbp-\d+\], rax\n    jmp /);
    const arm = new AArch64Backend().generate(create(), {optimizationLevel: 0});
    const armBody = arm;
    assert.match(armBody, /ldr x9, \[sp, #\d+\]\n    str x9, \[sp, #\d+\]\n    ldr x9, \[sp, #\d+\]\n    str x9, \[sp, #\d+\]\n    ldr x9, \[sp, #\d+\]\n    str x9, \[sp, #\d+\]\n    ldr x9, \[sp, #\d+\]\n    str x9, \[sp, #\d+\]\n    b /);
});

test('IR optimization promotes canonical primitive loop locals', () => {
    const temporary = (name, type = 'i64') => ({kind: 'temporary', name, type});
    const create = () => {
        const fn = {name: 'entry.__', owner: 'entry', parameters: [], returnType: 'i64', blocks: [
            {label: 'entry', instructions: [
                {op: 'constant', result: '%zero', type: 'i64', value: '0'},
                {op: 'declare_local', name: 'index', type: 'i64', value: temporary('%zero')},
                {op: 'jump', target: 'header'}
            ]},
            {label: 'header', instructions: [
                {op: 'load_local', result: '%current', type: 'i64', name: 'index'},
                {op: 'constant', result: '%limit', type: 'i64', value: '10'},
                {op: 'binary', result: '%condition', type: 'bool', operator: '<', left: temporary('%current'), right: temporary('%limit')},
                {op: 'branch', condition: temporary('%condition', 'bool'), thenTarget: 'body', elseTarget: 'exit'}
            ]},
            {label: 'body', instructions: [
                {op: 'load_local', result: '%loaded', type: 'i64', name: 'index'},
                {op: 'constant', result: '%one', type: 'i64', value: '1'},
                {op: 'binary', result: '%next', type: 'i64', operator: '+', left: temporary('%loaded'), right: temporary('%one')},
                {op: 'store_local', name: 'index', value: temporary('%next')},
                {op: 'jump', target: 'header'}
            ]},
            {label: 'exit', instructions: [
                {op: 'load_local', result: '%result', type: 'i64', name: 'index'},
                {op: 'return', value: temporary('%result')}
            ]}
        ]};
        return {program: {types: [{name: 'entry', fields: [], virtualMethods: [], contracts: []}], functions: [fn], externals: [], entry: fn.name}, fn};
    };
    const optimized = create();
    new IrCanonicalizer().run(optimized.program);
    const loop = optimized.fn.blocks.find(block => block.label === 'header').instructions[0];
    assert.equal(loop.op, 'loop_value');
    assert.equal(loop.target, 'entry');
    assert.equal(loop.alternateTarget, 'body');
    assert.ok(!optimized.fn.blocks.flatMap(block => block.instructions).some(item => ['declare_local', 'load_local', 'store_local'].includes(item.op) && item.name === 'index'));
    assert.doesNotThrow(() => new IrValidator().validate(optimized.program));
    const optimizedBackend = new X86_64Backend();
    optimizedBackend.generate(structuredClone(optimized.program));
    assert.ok(optimizedBackend.registers.has(loop.result));

    const unoptimized = create();
    new IrCanonicalizer().run(unoptimized.program, {optimize: false});
    assert.ok(unoptimized.fn.blocks.flatMap(block => block.instructions).some(item => item.op === 'store_local' && item.name === 'index'));

    const rejected = create();
    rejected.fn.blocks[2].instructions.splice(-1, 0, {op: 'store_local', name: 'index', value: temporary('%next')});
    new IrCanonicalizer().run(rejected.program);
    assert.ok(!rejected.fn.blocks.flatMap(block => block.instructions).some(item => item.op === 'loop_value'));
});

test('IR optimization propagates block-local primitive values without crossing control flow', () => {
    const value = {kind: 'temporary', name: '%0', type: 'i64'};
    const loaded = {kind: 'temporary', name: '%1', type: 'i64'};
    const fn = {name: 'entry.__', owner: 'entry', parameters: [], returnType: 'i64', blocks: [
        {label: 'entry', instructions: [
            {op: 'constant', result: '%0', type: 'i64', value: '7'},
            {op: 'declare_local', name: 'value#0', type: 'i64', value},
            {op: 'load_local', result: '%1', type: 'i64', name: 'value#0'},
            {op: 'return', value: loaded}
        ]}
    ]};
    new IrCanonicalizer().canonicalizeFunction(fn, true);
    assert.deepEqual(fn.blocks[0].instructions.map(instruction => instruction.op), ['constant', 'declare_local', 'return']);
    assert.equal(fn.blocks[0].instructions.at(-1).value.name, '%0');
});

test('IR optimization scalar-replaces non-escaping primitive objects', () => {
    const temporary = (name, type) => ({kind: 'temporary', name, type});
    const parameter = (name, type) => ({kind: 'parameter', name, type});
    const box = {name: 'Box', initializer: 'Box.__', fields: [{name: 'value', qualifiedName: 'Box.value', type: 'i64', ownership: 'value'}], virtualMethods: [], contracts: [{name: 'Box', isSelf: true}]};
    const constructor = {name: 'Box.__', owner: 'Box', parameters: [{name: 'self', type: 'Box'}, {name: 'value', type: 'i64'}], returnType: 'void', blocks: [{label: 'entry', instructions: [
        {op: 'store_field', object: parameter('self', 'Box'), value: parameter('value', 'i64'), field: 'Box.value'}, {op: 'return'}
    ]}]};
    const fn = {name: 'entry.__', owner: 'entry', parameters: [], returnType: 'i64', blocks: [{label: 'entry', instructions: [
        {op: 'constant', result: '%0', type: 'i64', value: '7'},
        {op: 'allocate', result: '%1', type: 'Box'},
        {op: 'call', target: 'Box.__', arguments: [temporary('%1', 'Box'), temporary('%0', 'i64')]},
        {op: 'declare_local', name: 'box#0', type: 'Box', value: temporary('%1', 'Box')},
        {op: 'load_local', result: '%2', type: 'Box', name: 'box#0'},
        {op: 'load_field', result: '%3', type: 'i64', object: temporary('%2', 'Box'), field: 'Box.value'},
        {op: 'destroy_object', value: {kind: 'local', name: 'box#0', type: 'Box'}, type: 'Box'},
        {op: 'return', value: temporary('%3', 'i64')}
    ]}]};
    const program = {types: [box, {name: 'entry', fields: [], virtualMethods: [], contracts: []}], functions: [constructor, fn], externals: [], entry: fn.name};
    const instrumented = structuredClone(program);
    new IrCanonicalizer().run(program);
    assert.deepEqual(fn.blocks[0].instructions.map(instruction => instruction.op), ['constant', 'return']);
    assert.equal(fn.blocks[0].instructions[1].value.name, '%0');
    new IrCanonicalizer().run(instrumented, {scalarReplacement: false});
    assert.ok(instrumented.functions[1].blocks[0].instructions.some(instruction => instruction.op === 'allocate'));

    const crossBlock = structuredClone(instrumented.functions[1]);
    crossBlock.blocks[0].instructions = crossBlock.blocks[0].instructions.slice(0, 4).concat({op: 'jump', target: 'exit'});
    crossBlock.blocks.push({label: 'exit', instructions: [
        {op: 'load_local', result: '%4', type: 'Box', name: 'box#0'},
        {op: 'return', value: temporary('%4', 'Box')}
    ]});
    new IrCanonicalizer().canonicalizeFunction(crossBlock, true, program);
    assert.ok(crossBlock.blocks[0].instructions.some(instruction => instruction.op === 'allocate'));

    const escaping = structuredClone(fn);
    escaping.blocks[0].instructions = [
        {op: 'allocate', result: '%1', type: 'Box'},
        {op: 'return', value: temporary('%1', 'Box')}
    ];
    new IrCanonicalizer().canonicalizeFunction(escaping, true, program);
    assert.ok(escaping.blocks[0].instructions.some(instruction => instruction.op === 'allocate'));
});

test('IR optimization devirtualizes exact receivers and inlines tiny leaf methods', () => {
    const source = `
        Base {{ apply(value:i64) -> i64 { return value + 1 } }}
        Child inherits Base {{ apply(value:i64) -> i64 { return value + 2 } }}
        entry {{ __() -> i64 { local receiver:Base = new Child(); return receiver.apply(5) } }}
    `;
    const analyze = () => new SemanticAnalyzer().analyze(new Parser().parse(source, 'inline-exact.ar'));
    const optimized = new IrGenerator().generate(analyze());
    new IrCanonicalizer().run(optimized);
    const entry = optimized.functions.find(fn => fn.displayName === 'entry.__');
    assert.ok(!entry.blocks.flatMap(block => block.instructions).some(instruction => ['call', 'virtual_call'].includes(instruction.op) && instruction.target.endsWith('apply')));
    assert.ok(entry.blocks.flatMap(block => block.instructions).some(instruction => instruction.op === 'binary' && instruction.operator === '+'));

    const mutatedSource = `
        Base {{ apply(value:i64) -> i64 { return value + 1 } }}
        Child inherits Base {{ apply(value:i64) -> i64 { return value + 2 } }}
        entry {{ __() -> i64 { local receiver:Base = new Child(); receiver = new Base(); return receiver.apply(5) } }}
    `;
    const mutatedSemantic = new SemanticAnalyzer().analyze(new Parser().parse(mutatedSource, 'inline-mutated.ar'));
    assert.equal(mutatedSemantic.success, true, JSON.stringify(mutatedSemantic.diagnostics));
    const mutated = new IrGenerator().generate(mutatedSemantic);
    new IrCanonicalizer().run(mutated);
    const mutatedEntry = mutated.functions.find(fn => fn.displayName === 'entry.__');
    assert.ok(mutatedEntry.blocks.flatMap(block => block.instructions).some(instruction => instruction.op === 'virtual_call'));
});

test('IR validation rejects malformed control flow and calls before assembly', () => {
    const fn = {name: 'entry.__', owner: 'entry', parameters: [{name: 'self', type: 'entry'}], returnType: 'void', blocks: [
        {label: 'entry', instructions: [
            {op: 'call', target: 'missing.method', arguments: []},
            {op: 'jump', target: 'missing_block'}
        ]}
    ]};
    const program = {types: [{name: 'entry', fields: [], virtualMethods: [], contracts: []}], functions: [fn], externals: [], entry: fn.name};
    assert.throws(() => new IrValidator().validate(program), error =>
        error instanceof IrValidationError && /unknown function/.test(error.message) && /unknown block/.test(error.message));
});

test('generated primitive executable is self-starting and has no implicit shared libraries', t => {
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(primitiveProgram, 'primitives.ar'));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-test-'));
    const assemblyPath = path.join(directory, 'primitives.s');
    const executablePath = path.join(directory, 'primitives');
    fs.writeFileSync(assemblyPath, assembly);

    assert.match(assembly, /\.globl _start\n_start:/);
    const compile = spawnSync('cc', ['-nostdlib', '-no-pie', assemblyPath, '-o', executablePath], {encoding: 'utf8'});
    if (compile.error?.code === 'EPERM') {
        fs.rmSync(directory, {recursive: true});
        t.skip('process sandbox does not allow Node to spawn cc');
        return;
    }
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(executablePath, [], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    const dynamic = spawnSync('readelf', ['-d', executablePath], {encoding: 'utf8'});
    assert.equal(dynamic.status, 0, dynamic.stderr);
    assert.doesNotMatch(dynamic.stdout, /NEEDED/);
    fs.rmSync(directory, {recursive: true});
});
