import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {ElfObject} from '../elf.js';
import {X86Assembler} from '../x86-assembler.js';
import {Compiler} from '../compiler.js';
import {ElfLinker, LinkerError} from '../linker.js';

test('ELF writer produces a directly linkable x86-64 relocatable object', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-elf-'));
    try {
        const objectPath = path.join(directory, 'exit.o');
        const executablePath = path.join(directory, 'exit');
        const object = new ElfObject();
        object.addText(Buffer.from([
            0xb8, 0x3c, 0x00, 0x00, 0x00, // mov eax, 60
            0x31, 0xff,                   // xor edi, edi
            0x0f, 0x05                    // syscall
        ]));
        object.addSymbol('_start', {section: '.text', value: 0, size: 9, binding: 'GLOBAL', type: 'FUNC'});
        fs.writeFileSync(objectPath, object.build());

        const inspect = spawnSync('readelf', ['-h', '-S', '-s', objectPath], {encoding: 'utf8'});
        if (inspect.error?.code === 'EPERM') {
            t.skip('process sandbox does not allow readelf');
            return;
        }
        assert.equal(inspect.status, 0, inspect.stderr);
        assert.match(inspect.stdout, /Type:\s+REL/);
        assert.match(inspect.stdout, /Machine:\s+Advanced Micro Devices X86-64/);
        assert.match(inspect.stdout, /\.text/);
        assert.match(inspect.stdout, /_start/);

        const link = spawnSync('ld', ['-o', executablePath, objectPath], {encoding: 'utf8'});
        assert.equal(link.status, 0, link.stderr);
        const run = spawnSync(executablePath);
        assert.equal(run.status, 0, run.stderr?.toString());
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test('ELF writer emits symbol relocations with the correct section links', () => {
    const object = new ElfObject();
    object.addText(Buffer.alloc(4));
    object.addSymbol('external', {binding: 'GLOBAL'});
    object.addRelocation('.text', 0, 'external', 2, -4);
    const bytes = object.build();
    assert.equal(bytes.subarray(0, 4).toString('binary'), '\x7fELF');
    assert.ok(bytes.includes(Buffer.from('.rela.text\0')));
    assert.ok(bytes.includes(Buffer.from('external\0')));
});

test('Valen x86 assembler encodes backend syntax and RIP-relative data relocations', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-assembler-'));
    try {
        const objectPath = path.join(directory, 'program.o');
        const executablePath = path.join(directory, 'program');
        const source = `.intel_syntax noprefix
.text
.globl _start
_start:
    lea rsi, [rip+message]
    mov eax, 60
    xor edi, edi
    syscall
.section .rodata
message:
    .asciz "valen"
`;
        fs.writeFileSync(objectPath, new X86Assembler().assemble(source));
        const link = spawnSync('ld', ['-o', executablePath, objectPath], {encoding: 'utf8'});
        if (link.error?.code === 'EPERM') {
            t.skip('process sandbox does not allow ld');
            return;
        }
        assert.equal(link.status, 0, link.stderr);
        assert.equal(spawnSync(executablePath).status, 0);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test('compiler can stop at a relocatable object without selecting a linker', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-emit-object-'));
    try {
        const sourcePath = path.join(directory, 'main.ar');
        const objectPath = path.join(directory, 'main.o');
        fs.writeFileSync(sourcePath, 'entry {{ __() -> i32 { return 0 } }}\n');
        const result = new Compiler().emitObject(sourcePath, objectPath);
        assert.equal(result.objectPath, objectPath);
        assert.equal(fs.readFileSync(objectPath).subarray(0, 4).toString('binary'), '\x7fELF');
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test('integrated linker resolves generated relocations into a runnable static ELF', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-native-linker-'));
    try {
        const executablePath = path.join(directory, 'program');
        const source = `.intel_syntax noprefix
.text
.globl _start
_start:
    lea rax, [rip+message]
    mov eax, 60
    xor edi, edi
    syscall
.section .rodata
message:
    .quad _start
`;
        const object = new X86Assembler().assembleObject(source);
        fs.writeFileSync(executablePath, new ElfLinker().link(object), {mode: 0o755});
        const run = spawnSync(executablePath);
        if (run.error?.code === 'EPERM') {
            t.skip('process sandbox does not allow generated executables');
            return;
        }
        assert.equal(run.status, 0, run.stderr?.toString());
        const bytes = fs.readFileSync(executablePath);
        assert.equal(bytes.readUInt16LE(16), 2);
        assert.equal(bytes.readUInt16LE(56), 2);
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

test('integrated linker rejects undefined symbols', () => {
    const object = new X86Assembler().assembleObject(`.text
.globl _start
.extern missing
_start:
    call missing
`);
    assert.throws(() => new ElfLinker().link(object), LinkerError);
});

test('integrated linker resolves symbols across independent objects', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'valen-multi-object-'));
    try {
        const executablePath = path.join(directory, 'program');
        const assembler = new X86Assembler();
        const entry = assembler.assembleObject(`.text
.globl _start
.extern answer
_start:
    call answer
    mov edi, eax
    mov eax, 60
    syscall
`);
        const implementation = new X86Assembler().assembleObject(`.text
.globl answer
answer:
    mov eax, 0
    ret
`);
        fs.writeFileSync(executablePath, new ElfLinker().linkObjects([entry, implementation]), {mode: 0o755});
        const run = spawnSync(executablePath);
        if (run.error?.code === 'EPERM') { t.skip('process sandbox does not allow generated executables'); return; }
        assert.equal(run.status, 0, run.stderr?.toString());
    } finally {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});
