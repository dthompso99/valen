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
        local joined:string = "ar" + "gon"
        local sliced:string = joined.slice(1, 3)
        if joined.length == 5 && joined[1] == 114 && joined == "argon" && joined != "other" && sliced == "rgo" {
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
    assert.match(result.diagnostics[0].message, /integer conversion requires integer types/);
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
    assert.match(assembly, /argon_System_arguments:/);
    assert.match(assembly, /argon_System_exit:/);
    assert.match(assembly, /argon_process_argv/);
});

test('standard output and error lower to distinct native descriptors', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/stdio.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.match(assembly, /argon_System_write:[\s\S]*?mov edi, 1/);
    assert.match(assembly, /argon_System_writeError:[\s\S]*?mov edi, 2/);
});

test('file operations lower to native open, read, write, and close facilities', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/files.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    for (const symbol of ['openRead', 'openWrite', 'read', 'writeFile', 'close']) {
        assert.match(assembly, new RegExp(`argon_System_${symbol}:`));
    }
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

    const invalid = new SemanticAnalyzer().analyze(new Parser().parse(`
        library Raw {{ unsafe native touch(bytes:Array<u8>) -> void }}
        entry {{ __() -> void { local bytes = new Array<u8>(1); Raw.touch(bytes) } }}
    `, 'unsafe-call.ar'));
    assert.equal(invalid.success, false);
    assert.match(invalid.diagnostics[0].message, /only be called inside an unsafe block/);
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
        assert.match(assembly, new RegExp(`argon_System_${symbol}:`));
    }
    assert.match(assembly, /\.Lallocation_error:/);
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

test('contract dispatch preserves register and stack arguments', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/abi-contract-arguments.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.match(assembly, /mov r11, QWORD PTR \[rax\+\d+\][\s\S]*call r11/);
});

test('Argon compiler source foundation and tokenizer load and lower', () => {
    const filePath = path.join(projectRoot, 'src/argon.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.ok(ir.types.some(type => type.displayName === 'Compiler.SourceFile'));
    assert.ok(ir.types.some(type => type.displayName === 'Compiler.SourceSpan'));
    assert.ok(ir.types.some(type => type.displayName === 'Compiler.Token'));
    assert.ok(ir.types.some(type => type.displayName === 'Compiler.Tokenizer'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Compiler.Tokenizer.tokenize'));
    assert.ok(ir.types.some(type => type.displayName === 'Ast.Program'));
    assert.ok(ir.types.some(type => type.displayName === 'Ast.Declaration'));
    assert.ok(ir.types.some(type => type.displayName === 'Ast.Statement'));
    assert.ok(ir.types.some(type => type.displayName === 'Ast.Expression'));
    assert.ok(ir.types.some(type => type.displayName === 'Parsing.Parser'));
    assert.ok(ir.functions.some(fn => fn.displayName === 'Parsing.Parser.parse'));
    assert.ok(ir.types.some(type => type.displayName === 'Diagnostics.Diagnostic'));
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

test('module imports fall back to ARGON_LIBRARY_PATH after importer-relative resolution', () => {
    const fixtureRoot = path.join(projectRoot, 'bootstrap/test/fixtures/library-path');
    const semantic = new SemanticAnalyzer().analyzeFile(path.join(fixtureRoot, 'app/main.ar'), {
        sourceRoot: fixtureRoot,
        libraryPath: path.join(fixtureRoot, 'lib')
    });
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    assert.ok([...semantic.modules.values()].some(module => module.path.endsWith('/lib/shared.ar')));
});

test('Argon symbols support duplicate checks, parent lookup, and shadowing', () => {
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
    assert.match(assembly, /call argon_array_append/);
    assert.match(assembly, /mov QWORD PTR \[rdx\+8\], 0/);
    assert.match(assembly, /cmp QWORD PTR \[rax\+8\], 0/);
});

test('managed objects publish precise roots, trace callbacks, and runtime finalizers', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/garbage-collection.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot, libraryPath: path.join(projectRoot, 'lib')});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    assert.match(assembly, /argon_gc_roots/);
    assert.match(assembly, /call argon_gc_mark/);
    assert.match(assembly, /argon_gc_collect:/);
    assert.match(assembly, /argon_gc_array_finalize:/);
    assert.match(assembly, /call rax\n\.Lgc_unmap:/);
    assert.match(assembly, /argon_System_collectGarbage:/);
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

test('optional propagation is restricted to optional-returning methods', () => {
    const source = 'entry {{ __() -> void { local value:string? = null\n local resolved = value? } }}';
    const result = new SemanticAnalyzer().analyze(new Parser().parse(source, 'propagation.ar'));
    assert.equal(result.success, false);
    assert.match(result.diagnostics[0].message, /enclosing method to return an optional type/);
});

test('test suites lower expectations into a native failure-counting runner', () => {
    const source = `test arithmetic {{
        passing() -> void { expect(2 + 2 == 4) }
        failing() -> void { expect(2 + 2 == 5) }
    }}`;
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(source, 'tests.ar'));
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    const ir = new IrGenerator().generate(semantic);
    assert.equal(ir.entry, '$argon.test.run');
    assert.equal(ir.functions.filter(fn => fn.name.startsWith('arithmetic.')).length, 2);
    assert.ok(ir.functions.flatMap(fn => fn.blocks).flatMap(block => block.instructions).some(instruction => instruction.op === 'test_expect'));
    assert.match(new X86_64Backend().generate(ir), /argon_test_failures/);
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

test('generated primitive executable returns success', t => {
    const semantic = new SemanticAnalyzer().analyze(new Parser().parse(primitiveProgram, 'primitives.ar'));
    const assembly = new X86_64Backend().generate(new IrGenerator().generate(semantic));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'argon-test-'));
    const assemblyPath = path.join(directory, 'primitives.s');
    const executablePath = path.join(directory, 'primitives');
    fs.writeFileSync(assemblyPath, assembly);

    const compile = spawnSync('cc', ['-no-pie', assemblyPath, '-o', executablePath], {encoding: 'utf8'});
    if (compile.error?.code === 'EPERM') {
        fs.rmSync(directory, {recursive: true});
        t.skip('process sandbox does not allow Node to spawn cc');
        return;
    }
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(executablePath, [], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
    fs.rmSync(directory, {recursive: true});
});
