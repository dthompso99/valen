import assert from 'node:assert/strict';
import test from 'node:test';
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
