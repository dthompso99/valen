import assert from 'node:assert/strict';
import test from 'node:test';
import {ElfObject} from '../elf.js';
import {ElfLinker, LinkerError} from '../linker.js';
import {LibraryMetadata} from '../library-metadata.js';
import {hostTarget, resolveTarget, supportedTargets} from '../target.js';

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
    assert.throws(() => new ElfLinker().link(arm), /Unsupported ELF machine 183/);
});
