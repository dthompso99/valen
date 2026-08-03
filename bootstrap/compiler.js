import fs from 'fs';
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';
import {IrGenerator} from './ir.js';
import {X86_64Backend} from './x86-64.js';
import {X86Assembler} from './x86-assembler.js';

export class Compiler {
    emitObject(sourcePath, objectPath, {assemblyPath = `${objectPath}.s`, sourceRoot} = {}) {
        const ir = new IrGenerator().generateFile(sourcePath, sourceRoot ? {sourceRoot} : {});
        const assembly = new X86_64Backend().generate(ir);
        fs.writeFileSync(assemblyPath, assembly);
        fs.writeFileSync(objectPath, new X86Assembler().assemble(assembly));
        return {ir, assembly, assemblyPath, objectPath};
    }

    compile(sourcePath, outputPath, {assemblyPath = `${outputPath}.s`, objectPath = `${outputPath}.o`, sourceRoot, linker = 'system'} = {}) {
        const emitted = this.emitObject(sourcePath, objectPath, {assemblyPath, sourceRoot});
        if (linker !== 'system') throw new Error(`Unsupported linker '${linker}'`);
        const {ir} = emitted;
        const libraries = ir.foreignLibraries.map(library => `-l${library}`);
        const result = spawnSync('cc', ['-nostdlib', '-no-pie', objectPath, '-o', outputPath, ...libraries], {encoding: 'utf8'});
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr || `cc exited with status ${result.status}`);
        return {...emitted, outputPath, linker};
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const emitObject = process.argv[2] === '--emit-object';
    const sourcePath = process.argv[emitObject ? 3 : 2];
    const outputPath = process.argv[emitObject ? 4 : 3] ?? (emitObject ? 'a.o' : 'a.out');
    if (!sourcePath) throw new Error('Usage: node compiler.js <source-file> [output]');
    if (emitObject) new Compiler().emitObject(sourcePath, outputPath);
    else new Compiler().compile(sourcePath, outputPath);
}
