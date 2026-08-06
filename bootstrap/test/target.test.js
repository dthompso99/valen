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

test('integrated AArch64 encoder emits literal byte data', () => {
    const object = new AArch64Assembler().assembleObject(`.section .data
.align 8
descriptor:
    .quad bytes
    .quad 3
bytes:
    .byte 104, 195, 169
`);
    const data = Buffer.from(object.sections.find(section => section.name === '.data').data);
    assert.equal(data.subarray(16).toString('hex'), '68c3a9');
    assert.ok(object.relocations.some(relocation => relocation.section === '.data' && relocation.type === 257));
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

test('bootstrap compiler emits AArch64 type descriptors and virtual dispatch', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-dispatch-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/inheritance.ar', import.meta.url));
    const output = path.join(directory, 'inheritance');
    const result = new Compiler().compile(source, output, {target: 'aarch64-linux'});
    const object = ElfObject.parse(fs.readFileSync(result.objectPath));

    assert.ok(object.sections.some(section => section.name === '.data'));
    assert.ok(object.relocations.some(relocation => relocation.section === '.data' && relocation.type === 257));
    assert.ok(object.relocations.some(relocation => relocation.section === '.text' && relocation.type === 275));
    assert.ok(object.relocations.some(relocation => relocation.section === '.text' && relocation.type === 277));
    assert.match(result.assembly, /ldr x9, \[x9, #40\]/);
    assert.match(result.assembly, /ldr x9, \[x9, #48\]/);
    assert.match(result.assembly, /ldr x9, \[x9, #56\]/);
    assert.match(result.assembly, /blr x9/);
});

test('bootstrap compiler emits AArch64 contract dispatch and checked type relationships', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-contracts-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const contractSource = fileURLToPath(new URL('fixtures/aarch64-contracts.ar', import.meta.url));
    const contractResult = new Compiler().compile(contractSource, path.join(directory, 'contracts'), {target: 'aarch64-linux'});
    const subtypeSource = fileURLToPath(new URL('fixtures/subtypes.ar', import.meta.url));
    const subtypeResult = new Compiler().compile(subtypeSource, path.join(directory, 'subtypes'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'contracts')).readUInt16LE(18), 183);
    assert.match(contractResult.assembly, /\.Lcontract_call_\d+:/);
    assert.match(contractResult.assembly, /ldr x11, \[x11, #0\]/);
    assert.match(contractResult.assembly, /blr x11/);
    assert.match(contractResult.assembly, /_contracts:\n    \.quad 1/);
    assert.match(contractResult.assembly, /_as___valen_/);
    assert.match(subtypeResult.assembly, /\.Ltype_test_\d+:/);
    assert.match(subtypeResult.assembly, /ldr x12, \[x11, #8\]/);
    assert.match(subtypeResult.assembly, /mov x0, x9/);
    assert.match(subtypeResult.assembly, /cbz x9, \.Loptional_unwrap_error/);
});

test('bootstrap compiler emits fixed-size AArch64 arrays with checked indexing', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-arrays-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-arrays.ar', import.meta.url));
    const result = new Compiler().compile(source, path.join(directory, 'arrays'), {target: 'aarch64-linux'});
    const boundsSource = fileURLToPath(new URL('fixtures/aarch64-array-bounds.ar', import.meta.url));
    const bounds = new Compiler().compile(boundsSource, path.join(directory, 'array-bounds'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'arrays')).readUInt16LE(18), 183);
    assert.match(result.assembly, /bl valen_array_new/);
    assert.match(result.assembly, /bl valen_array_address/);
    assert.match(result.assembly, /strb w9, \[x0, #0\]/);
    assert.match(result.assembly, /strh w9, \[x0, #0\]/);
    assert.match(result.assembly, /str w9, \[x0, #0\]/);
    assert.match(result.assembly, /str x9, \[x0, #0\]/);
    assert.match(bounds.assembly, /b\.cs \.Larray_bounds_error/);
    assert.match(bounds.assembly, /mov x0, #70/);
});

test('bootstrap compiler grows and compacts AArch64 arrays', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-array-capacity-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-array-capacity.ar', import.meta.url));
    const result = new Compiler().compile(source, path.join(directory, 'capacity'), {target: 'aarch64-linux'});
    const negativeSource = fileURLToPath(new URL('fixtures/array-reserve-negative.ar', import.meta.url));
    const negative = new Compiler().compile(negativeSource, path.join(directory, 'negative'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'capacity')).readUInt16LE(18), 183);
    assert.match(result.assembly, /bl valen_array_append/);
    assert.match(result.assembly, /bl valen_array_reserve/);
    assert.match(result.assembly, /bl valen_array_shrink_to_fit/);
    assert.match(result.assembly, /\.Larray_resize_copy:/);
    assert.match(result.assembly, /strb w1, \[x5, #0\]/);
    assert.match(result.assembly, /strh w1, \[x5, #0\]/);
    assert.match(result.assembly, /str w1, \[x5, #0\]/);
    assert.match(result.assembly, /str x1, \[x5, #0\]/);
    assert.match(negative.assembly, /b\.lt \.Larray_bounds_error/);
});

test('bootstrap compiler inserts and removes AArch64 array elements', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-array-mutation-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/array-insert-remove.ar', import.meta.url));
    const result = new Compiler().compile(source, path.join(directory, 'mutation'), {target: 'aarch64-linux'});
    const boundsSource = fileURLToPath(new URL('fixtures/array-remove-bounds.ar', import.meta.url));
    const bounds = new Compiler().compile(boundsSource, path.join(directory, 'remove-bounds'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'mutation')).readUInt16LE(18), 183);
    assert.match(result.assembly, /bl valen_array_insert/);
    assert.match(result.assembly, /bl valen_array_remove/);
    assert.match(result.assembly, /\.Larray_insert_move:/);
    assert.match(result.assembly, /\.Larray_remove_move:/);
    assert.match(result.assembly, /\.Larray_remove_clear:/);
    assert.match(bounds.assembly, /b\.cs \.Larray_bounds_error/);
});

test('bootstrap compiler copies value and reference AArch64 array slices', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-array-slices-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-array-slices.ar', import.meta.url));
    const result = new Compiler().compile(source, path.join(directory, 'slices'), {target: 'aarch64-linux'});
    const boundsSource = fileURLToPath(new URL('fixtures/array-slice-bounds.ar', import.meta.url));
    const bounds = new Compiler().compile(boundsSource, path.join(directory, 'slice-bounds'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'slices')).readUInt16LE(18), 183);
    assert.match(result.assembly, /bl valen_array_slice/);
    assert.match(result.assembly, /\.Larray_slice_copy:/);
    assert.match(bounds.assembly, /b\.hi \.Larray_bounds_error/);
});

test('bootstrap compiler emits foundational UTF-8 AArch64 string operations', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-strings-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-strings.ar', import.meta.url));
    const result = new Compiler().compile(source, path.join(directory, 'strings'), {target: 'aarch64-linux'});
    const boundsSource = fileURLToPath(new URL('fixtures/aarch64-string-bounds.ar', import.meta.url));
    const bounds = new Compiler().compile(boundsSource, path.join(directory, 'string-bounds'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'strings')).readUInt16LE(18), 183);
    assert.match(result.assembly, /\.byte 104, 195, 169, 240, 159, 153, 130/);
    assert.match(result.assembly, /bl valen_string_equal/);
    assert.match(result.assembly, /bl valen_string_concat/);
    assert.match(result.assembly, /bl valen_string_slice/);
    assert.match(bounds.assembly, /b\.cs \.Larray_bounds_error/);
});

test('bootstrap compiler copies between AArch64 strings and byte arrays', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-byte-conversions-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-byte-conversions.ar', import.meta.url));
    const result = new Compiler().compile(source, path.join(directory, 'byte-conversions'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'byte-conversions')).readUInt16LE(18), 183);
    assert.match(result.assembly, /bl valen_string_to_bytes/);
    assert.match(result.assembly, /bl valen_bytes_to_string/);
    assert.match(result.assembly, /\.Lstring_to_bytes_copy:/);
    assert.match(result.assembly, /\.Lbytes_to_string_copy:/);
});

test('bootstrap compiler decodes UTF-8 code points on AArch64', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-codepoints-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-codepoints.ar', import.meta.url));
    const result = new Compiler().compile(source, path.join(directory, 'codepoints'), {target: 'aarch64-linux'});
    const boundsSource = fileURLToPath(new URL('fixtures/aarch64-codepoint-bounds.ar', import.meta.url));
    const bounds = new Compiler().compile(boundsSource, path.join(directory, 'codepoint-bounds'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'codepoints')).readUInt16LE(18), 183);
    assert.match(result.assembly, /bl valen_string_codepoint_length/);
    assert.match(result.assembly, /bl valen_string_codepoint_at/);
    assert.match(result.assembly, /valen_utf8_decode:/);
    assert.match(result.assembly, /\.Lutf8_decode_four:/);
    assert.match(bounds.assembly, /\.Lcodepoint_at_error:[\s\S]*b \.Larray_bounds_error/);
});

test('bootstrap compiler segments Unicode graphemes on AArch64', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-graphemes-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/unicode-strings.ar', import.meta.url));
    const result = new Compiler().compile(source, path.join(directory, 'graphemes'), {target: 'aarch64-linux'});
    const boundsSource = fileURLToPath(new URL('fixtures/unicode-index-bounds.ar', import.meta.url));
    const bounds = new Compiler().compile(boundsSource, path.join(directory, 'grapheme-bounds'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'graphemes')).readUInt16LE(18), 183);
    assert.match(result.assembly, /bl valen_string_grapheme_length/);
    assert.match(result.assembly, /bl valen_string_grapheme_at/);
    assert.match(result.assembly, /valen_grapheme_next:/);
    assert.match(result.assembly, /\.Lgrapheme_check_ri:/);
    assert.match(result.assembly, /\.Lgrapheme_extend_modifier:/);
    assert.match(bounds.assembly, /\.Lgrapheme_at_error:[\s\S]*b \.Larray_bounds_error/);
});

test('bootstrap compiler formats signed and unsigned AArch64 integers', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-integer-formatting-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-integer-formatting.ar', import.meta.url));
    const result = new Compiler().compile(source, path.join(directory, 'integer-formatting'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'integer-formatting')).readUInt16LE(18), 183);
    assert.match(result.assembly, /bl valen_integer_to_string/);
    assert.match(result.assembly, /\.Linteger_string_digits:/);
    assert.match(result.assembly, /udiv x7, x4, x6/);
    assert.match(result.assembly, /\.Linteger_string_copy:/);
});

test('bootstrap compiler builds immutable strings and interpolation on AArch64', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-string-builder-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/aarch64-string-builder.ar', import.meta.url));
    const result = new Compiler().compile(source, path.join(directory, 'string-builder'), {target: 'aarch64-linux'});
    const interpolationSource = fileURLToPath(new URL('fixtures/string-interpolation.ar', import.meta.url));
    const interpolation = new Compiler().compile(interpolationSource, path.join(directory, 'interpolation'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'string-builder')).readUInt16LE(18), 183);
    assert.match(result.assembly, /bl valen_builder_append_string/);
    assert.match(result.assembly, /bl valen_builder_append_bytes/);
    assert.match(result.assembly, /bl valen_builder_build/);
    assert.match(result.assembly, /\.Lbuilder_append_copy:/);
    assert.match(result.assembly, /\.Lbuilder_build_copy:/);
    assert.match(interpolation.assembly, /bl valen_integer_to_string/);
    assert.match(interpolation.assembly, /bl valen_builder_append_string/);
    assert.match(interpolation.assembly, /bl valen_builder_build/);
});

test('bootstrap compiler invalidates weak AArch64 fields and array elements', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-weak-references-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const source = fileURLToPath(new URL('fixtures/weak-reference.ar', import.meta.url));
    const field = new Compiler().compile(source, path.join(directory, 'weak-field'), {target: 'aarch64-linux'});
    const collectionSource = fileURLToPath(new URL('fixtures/collection-ownership.ar', import.meta.url));
    const collection = new Compiler().compile(collectionSource, path.join(directory, 'weak-array'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'weak-field')).readUInt16LE(18), 183);
    assert.match(field.assembly, /\.Lweak_field_live_/);
    assert.match(field.assembly, /ldr x10, \[x9, #8\]/);
    assert.match(collection.assembly, /\.Lweak_array_live_/);
    assert.doesNotMatch(collection.assembly, /does not yet support weak/);
});

test('bootstrap compiler tracks AArch64 managed allocations and precise roots', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-aarch64-gc-foundation-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const objectSource = fileURLToPath(new URL('fixtures/aarch64-objects.ar', import.meta.url));
    const objects = new Compiler().compile(objectSource, path.join(directory, 'objects'), {target: 'aarch64-linux'});
    const builderSource = fileURLToPath(new URL('fixtures/aarch64-string-builder.ar', import.meta.url));
    const builders = new Compiler().compile(builderSource, path.join(directory, 'builders'), {target: 'aarch64-linux'});

    assert.equal(fs.readFileSync(path.join(directory, 'objects')).readUInt16LE(18), 183);
    assert.match(objects.assembly, /valen_gc_alloc:/);
    assert.match(objects.assembly, /valen_gc_heap:/);
    assert.match(objects.assembly, /valen_gc_roots:/);
    assert.match(objects.assembly, /__gc_roots:/);
    assert.match(objects.assembly, /bl valen_gc_mark/);
    assert.match(objects.assembly, /add x0, x0, #48/);
    assert.match(builders.assembly, /valen_array_new:[\s\S]*bl valen_gc_alloc/);
    assert.match(builders.assembly, /valen_string_new:[\s\S]*bl valen_gc_alloc/);
});
