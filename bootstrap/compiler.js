import fs from 'fs';
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';
import {IrGenerator} from './ir.js';
import {X86_64Backend} from './x86-64.js';

export class Compiler {
    compile(sourcePath, outputPath, {assemblyPath = `${outputPath}.s`, sourceRoot} = {}) {
        const ir = new IrGenerator().generateFile(sourcePath, sourceRoot ? {sourceRoot} : {});
        const assembly = new X86_64Backend().generate(ir);
        fs.writeFileSync(assemblyPath, assembly);

        const libraries = ir.foreignLibraries.map(library => `-l${library}`);
        const result = spawnSync('cc', ['-no-pie', assemblyPath, '-o', outputPath, ...libraries], {encoding: 'utf8'});
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr || `cc exited with status ${result.status}`);
        return {ir, assembly, assemblyPath, outputPath};
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const sourcePath = process.argv[2];
    const outputPath = process.argv[3] ?? 'a.out';
    if (!sourcePath) throw new Error('Usage: node compiler.js <source-file> [output]');
    new Compiler().compile(sourcePath, outputPath);
}
