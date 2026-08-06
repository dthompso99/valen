import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Compiler} from '../compiler.js';
import {ElfObject} from '../elf.js';
import {ElfLinker, LinkerError} from '../linker.js';
import {LibraryMetadata} from '../library-metadata.js';
import {hostTarget, resolveTarget, supportedTargets} from '../target.js';
import {AArch64Assembler} from '../aarch64-assembler.js';

test('target model normalizes supported Linux architecture names', () => {
    assert.deepEqual(supportedTargets, ['x86_64-linux', 'aarch64-linux']);
    assert.equal(resolveTarget('amd64-linux').name, 'x86_64-linux');
    assert.equal(resolveTarget('arm64-linux').name, 'aarch64-linux');
    assert.equal(resolveTarget(hostTarget()).operatingSystem, 'linux');
    assert.throws(() => resolveTarget('mips-linux'), /Unsupported target 'mips-linux'/);
});

test('library metadata prevents target-specific artifacts from being mixed', () => {
    const artifact = LibraryMetadata.create({name: 'Portable', version: '1.0.0', target: 'aarch64-linux',
        interfaceFingerprint: '1', implementationFingerprint: '2', object: Buffer.from([3])});
    const serialized = LibraryMetadata.serialize(artifact);
    assert.equal(LibraryMetadata.parse(serialized, {target: 'aarch64-linux'}).target, 'aarch64-linux');
    assert.throws(() => LibraryMetadata.parse(serialized, {target: 'x86_64-linux'}), /Incompatible library target/);
});

test('ELF objects retain their target machine and reject mixed-architecture links', () => {
    const arm = new ElfObject({machine: 183});
    arm.addText(Buffer.alloc(4));
    arm.addSymbol('_start', {section: '.text', binding: 'GLOBAL', type: 'FUNC'});
    const parsed = ElfObject.parse(arm.build());
    assert.equal(parsed.machine, 183);
    assert.equal(parsed.build().readUInt16LE(18), 183);

    const x86 = new ElfObject();
    x86.addText(Buffer.alloc(1));
    x86.addSymbol('_start', {section: '.text', binding: 'GLOBAL', type: 'FUNC'});
    assert.throws(() => new ElfLinker().linkObjects([x86, arm]), LinkerError);
    const executable = new ElfLinker().link(arm);
    assert.equal(executable.readUInt16LE(18), 183);
    assert.equal(Number(executable.readBigUInt64LE(112)), 65536);
});

test('integrated AArch64 encoder emits Linux exit instructions and call relocations', () => {
    const assembler = new AArch64Assembler();
    const exit = assembler.assembleObject(`.text
.globl _start
_start:
    mov x0, #0
    mov x8, #93
    svc #0
`);
    assert.equal(exit.machine, 183);
    assert.equal(Buffer.from(exit.sections.find(section => section.name === '.text').data).toString('hex'),
        '000080d2a80b80d2010000d4');

    const call = assembler.assembleObject(`.text
.globl caller
.extern callee
caller:
    bl callee
    ret
`);
    assert.deepEqual(call.relocations.map(relocation => ({symbol: relocation.symbol, type: relocation.type})),
        [{symbol: 'callee', type: 283}]);
});

test('integrated AArch64 encoder emits scalar floating-point instructions', () => {
    const object = new AArch64Assembler().assembleObject(`.text
sample:
    fmov d0, x9
    fadd d0, d0, d1
    fcmp d0, d1
    fcvt s0, d0
    scvtf d0, x9
    fmov x9, d0
    ret
`);
    assert.equal(Buffer.from(object.sections.find(section => section.name === '.text').data).toString('hex'),
        '2001679e0028611e0020611e0040621e2001629e0900669ec0035fd6');

    const conversion = new AArch64Assembler().assembleObject(`.text
sample:
    fcmp d0, d0
    b.vs conversion_error
    fcvtzs x9, d0
    fcvtzu x9, d0
conversion_error:
    ret
`);
    assert.equal(Buffer.from(conversion.sections.find(section => section.name === '.text').data).toString('hex'),
        '0020601e660000540900789e0900799ec0035fd6');
});

test('bootstrap compiler cross-compiles primitive AArch64 programs', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-primitives.ar', import.meta.url));
    const output = path.join(directory, 'primitives');
    const result = new Compiler().compile(source, output, {target: 'aarch64-linux'});

    const executable = fs.readFileSync(output);
    assert.equal(result.target.name, 'aarch64-linux');
    assert.equal(result.linker, 'native');
    assert.equal(executable.subarray(0, 4).toString('hex'), '7f454c46');
    assert.equal(executable.readUInt16LE(18), 183);
    assert.match(result.assembly, /movk x9, #1, lsl #32/);
    assert.match(result.assembly, /sdiv x9, x9, x10/);
    assert.match(result.assembly, /bl __valen_.*entry_2e_twice/);
});

test('bootstrap compiler cross-compiles scalar AArch64 floating point', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-float-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-floating-point.ar', import.meta.url));
    const output = path.join(directory, 'floating-point');
    const result = new Compiler().compile(source, output, {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(output).readUInt16LE(18), 183);
    assert.match(result.assembly, /fadd d0, d0, d1/);
    assert.match(result.assembly, /fcvt d0, s0/);
    assert.match(result.assembly, /scvtf d0, x9/);
    assert.match(result.assembly, /ucvtf s0, x9/);
    assert.match(result.assembly, /fcmp d0, d1/);
    assert.match(result.assembly, /fcvtzs x9, d0/);
    assert.match(result.assembly, /fcvtzu x9, d0/);
    assert.match(result.assembly, /b\.vs \.Lfloat_conversion_error/);

    for (const fixture of ['float-conversion-failing.ar', 'aarch64-float-range-error.ar']) {
        const failing = new Compiler().compile(fileURLToPath(new URL(`fixtures/${fixture}`, import.meta.url)),
            path.join(directory, fixture), {target: 'aarch64-linux'});
        assert.match(failing.assembly, /mov x0, #76/);
        assert.match(failing.assembly, /b\.ge \.Lfloat_conversion_error|b\.vs \.Lfloat_conversion_error/);
    }
});

test('bootstrap compiler uses AAPCS64 stack argument slots after register exhaustion', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-args-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-stack-arguments.ar', import.meta.url));
    const output = path.join(directory, 'stack-arguments');
    const result = new Compiler().compile(source, output, {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(output).readUInt16LE(18), 183);
    assert.match(result.assembly, /ldr x9, \[x29, #16\]/);
    assert.match(result.assembly, /ldr x9, \[x29, #48\]/);
    assert.match(result.assembly, /str x9, \[sp, #0\]/);
    assert.match(result.assembly, /str x9, \[sp, #32\]/);
});

test('bootstrap compiler lays out and constructs basic AArch64 objects', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-objects-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-objects.ar', import.meta.url));
    const output = path.join(directory, 'objects');
    const result = new Compiler().compile(source, output, {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(output).readUInt16LE(18), 183);
    assert.match(result.assembly, /bl valen_alloc/);
    assert.match(result.assembly, /strb w10, \[x9, #16\]/);
    assert.match(result.assembly, /strh w10, \[x9, #18\]/);
    assert.match(result.assembly, /str w10, \[x9, #20\]/);
    assert.match(result.assembly, /str x10, \[x9, #24\]/);
    assert.match(result.assembly, /mov x0, #72/);
});
