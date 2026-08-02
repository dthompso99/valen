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
    for (const file of ['sample.ar', 'nested.ar']) {
        const filePath = path.join(projectRoot, file);
        const semantic = new SemanticAnalyzer().analyzeFile(filePath);
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
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
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
    assert.doesNotThrow(() => new X86_64Backend().generate(ir));
});

test('Argon symbols support duplicate checks, parent lookup, and shadowing', () => {
    const filePath = path.join(projectRoot, 'bootstrap/test/fixtures/native-symbols.ar');
    const semantic = new SemanticAnalyzer().analyzeFile(filePath, {sourceRoot: projectRoot});
    assert.equal(semantic.success, true, JSON.stringify(semantic.diagnostics));
    assert.doesNotThrow(() => new X86_64Backend().generate(new IrGenerator().generate(semantic)));
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
