import fs from 'fs';
import {spawnSync} from 'child_process';
import {fileURLToPath} from 'url';
import {IrGenerator} from './ir.js';
import {X86_64Backend} from './x86-64.js';
import {X86Assembler} from './x86-assembler.js';
import {ElfLinker} from './linker.js';
import {ModuleLoader} from './module-loader.js';
import {SemanticAnalyzer} from './semantic.js';
import {ModuleInterfaceCache} from './module-interface.js';

export class Compiler {
    emitObject(sourcePath, objectPath, {assemblyPath = `${objectPath}.s`, sourceRoot, optimizationLevel = 1} = {}) {
        const graph = new ModuleLoader(sourceRoot ? {sourceRoot} : {}).load(sourcePath);
        new ModuleInterfaceCache(process.env.VALEN_CACHE_PATH ?? process.env.ARGON_CACHE_PATH,
            process.env.VALEN_CACHE_TRACE != null || process.env.ARGON_CACHE_TRACE != null).prepare(graph);
        const ir = new IrGenerator().generate(new SemanticAnalyzer().analyzeModules(graph));
        const assembly = new X86_64Backend().generate(ir, {optimizationLevel});
        fs.writeFileSync(assemblyPath, assembly);
        fs.writeFileSync(objectPath, new X86Assembler().assemble(assembly));
        return {ir, assembly, assemblyPath, objectPath};
    }

    compile(sourcePath, outputPath, {assemblyPath = `${outputPath}.s`, objectPath = `${outputPath}.o`, sourceRoot, linker = 'auto', optimizationLevel = 1} = {}) {
        const emitted = this.emitObject(sourcePath, objectPath, {assemblyPath, sourceRoot, optimizationLevel});
        if (!['auto', 'native', 'system'].includes(linker)) throw new Error(`Unsupported linker '${linker}'`);
        const {ir} = emitted;
        if (linker === 'native' || linker === 'auto' && ir.foreignLibraries.length === 0) {
            if (ir.foreignLibraries.length) throw new Error('Native linker cannot resolve foreign libraries; use --linker system');
            const moduleIds = [...new Set(ir.functions.map(fn => fn.moduleId).filter(Boolean))];
            const entryModule = ir.functions.find(fn => fn.name === ir.entry)?.moduleId;
            const objects = moduleIds.length > 1 ? moduleIds.map(moduleId => {
                const assembly = new X86_64Backend().generate(structuredClone(ir), {
                    optimizationLevel, moduleId, includeRuntime: moduleId === entryModule
                });
                return new X86Assembler().assembleObject(assembly);
            }) : [new X86Assembler().assembleObject(emitted.assembly)];
            fs.writeFileSync(outputPath, new ElfLinker().linkObjects(objects));
            fs.chmodSync(outputPath, 0o755);
            return {...emitted, outputPath, linker: 'native'};
        }
        const libraries = ir.foreignLibraries.map(library => `-l${library}`);
        const result = spawnSync('cc', ['-nostdlib', '-no-pie', objectPath, '-o', outputPath, ...libraries], {encoding: 'utf8'});
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr || `cc exited with status ${result.status}`);
        return {...emitted, outputPath, linker};
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const args = process.argv.slice(2);
    const levelFlag = args.find(argument => /^-O/.test(argument));
    if (levelFlag && !['-O0', '-O1'].includes(levelFlag)) throw new Error(`Unsupported optimization level '${levelFlag}'`);
    const optimizationLevel = levelFlag === '-O0' ? 0 : 1;
    const sourceRootIndex = args.indexOf('--source-root');
    if (sourceRootIndex >= 0 && !args[sourceRootIndex + 1]) throw new Error('--source-root requires a directory');
    const sourceRoot = sourceRootIndex >= 0 ? args[sourceRootIndex + 1] : undefined;
    const linkerIndex = args.indexOf('--linker');
    if (linkerIndex >= 0 && !args[linkerIndex + 1]) throw new Error('--linker requires auto, native, or system');
    const linker = linkerIndex >= 0 ? args[linkerIndex + 1] : 'auto';
    const positional = args.filter((argument, index) => argument !== levelFlag &&
        (sourceRootIndex < 0 || index !== sourceRootIndex && index !== sourceRootIndex + 1) &&
        (linkerIndex < 0 || index !== linkerIndex && index !== linkerIndex + 1));
    const emitObject = positional[0] === '--emit-object';
    const sourcePath = positional[emitObject ? 1 : 0];
    const outputPath = positional[emitObject ? 2 : 1] ?? (emitObject ? 'a.o' : 'a.out');
    if (!sourcePath) throw new Error('Usage: node compiler.js [-O0|-O1] <source-file> [output]');
    if (emitObject) new Compiler().emitObject(sourcePath, outputPath, {optimizationLevel, sourceRoot});
    else new Compiler().compile(sourcePath, outputPath, {optimizationLevel, sourceRoot, linker});
}
