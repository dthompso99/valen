import fs from 'fs';
import {spawnSync} from 'child_process';
import path from 'node:path';
import {fileURLToPath} from 'url';
import {IrGenerator} from './ir.js';
import {X86_64Backend} from './x86-64.js';
import {X86Assembler} from './x86-assembler.js';
import {ElfLinker} from './linker.js';
import {ModuleLoader} from './module-loader.js';
import {SemanticAnalyzer} from './semantic.js';
import {ModuleInterface, ModuleInterfaceCache} from './module-interface.js';
import {LibraryMetadata} from './library-metadata.js';
import {ElfObject} from './elf.js';
import {defaultSysroot, resolveTarget} from './target.js';
import {AArch64Backend} from './aarch64.js';
import {AArch64Assembler} from './aarch64-assembler.js';

const bootstrapRoot = path.dirname(fileURLToPath(import.meta.url));

const targetTools = target => {
    if (target.name === 'x86_64-linux') return {Backend: X86_64Backend, Assembler: X86Assembler};
    if (target.name === 'aarch64-linux') return {Backend: AArch64Backend, Assembler: AArch64Assembler};
    throw new Error(`Target '${target.name}' has no backend`);
};

export class Compiler {
    emitLibrary(sourcePath, objectPath, version, {sourceRoot, optimizationLevel = 1, target: targetName} = {}) {
        const target = resolveTarget(targetName);
        const {Backend, Assembler} = targetTools(target);
        const graph = new ModuleLoader({sourceRoot, target, sysroot: process.env.VALEN_SYSROOT ?? defaultSysroot(bootstrapRoot, target)}).load(sourcePath);
        const interfaces = new Map([...graph.modules.values()].map(module => [module, ModuleInterface.create(module)]));
        const semantic = new SemanticAnalyzer().analyzeModules(graph);
        if (!semantic.success) throw new Error(semantic.diagnostics.map(item => item.message).join('\n'));
        const entry = graph.entry;
        const libraries = entry.program.libraries.filter(item => item.visibility !== 'private');
        if (libraries.length !== 1) throw new Error('A compiled library source must declare exactly one public library');
        const artifact = interfaces.get(entry);
        const ir = new IrGenerator().generate(semantic);
        const assembly = new Backend().generate(ir, {optimizationLevel, moduleId: entry.id, includeRuntime: false, includeModuleMetadata: true});
        const object = new Assembler().assemble(assembly);
        fs.writeFileSync(objectPath, object);
        fs.writeFileSync(`${objectPath}.vmi`, ModuleInterface.serialize(artifact, new Map(artifact.imports.map(item => {
            const imported = [...graph.modules.values()].find(module => module.id === item.moduleId);
            return [item.moduleId, interfaces.get(imported).interfaceFingerprint];
        }))));
        const dependencies = artifact.imports.map(item => {
            const imported = [...graph.modules.values()].find(module => module.id === item.moduleId);
            return {name: item.name, interfaceFingerprint: interfaces.get(imported).interfaceFingerprint};
        });
        const metadata = LibraryMetadata.create({name: libraries[0].name, version,
            interfaceFingerprint: artifact.interfaceFingerprint, implementationFingerprint: artifact.implementationFingerprint,
            object, dependencies, target: target.name});
        LibraryMetadata.write(`${objectPath}.vmeta`, metadata);
        return {objectPath, metadataPath: `${objectPath}.vmeta`, metadata};
    }

    emitObject(sourcePath, objectPath, {assemblyPath = `${objectPath}.s`, sourceRoot, optimizationLevel = 1, runtimeMetrics = false, target: targetName} = {}) {
        const target = resolveTarget(targetName);
        const {Backend, Assembler} = targetTools(target);
        const graph = new ModuleLoader({sourceRoot, target, sysroot: process.env.VALEN_SYSROOT ?? defaultSysroot(bootstrapRoot, target)}).load(sourcePath);
        new ModuleInterfaceCache(process.env.VALEN_CACHE_PATH ?? process.env.ARGON_CACHE_PATH,
            process.env.VALEN_CACHE_TRACE != null || process.env.ARGON_CACHE_TRACE != null).prepare(graph);
        const ir = new IrGenerator().generate(new SemanticAnalyzer().analyzeModules(graph));
        const assembly = new Backend().generate(ir, {optimizationLevel, runtimeMetrics});
        fs.writeFileSync(assemblyPath, assembly);
        fs.writeFileSync(objectPath, new Assembler().assemble(assembly));
        return {ir, assembly, assemblyPath, objectPath, graph, target};
    }

    compile(sourcePath, outputPath, {assemblyPath = `${outputPath}.s`, objectPath = `${outputPath}.o`, sourceRoot, linker = 'auto', optimizationLevel = 1, runtimeMetrics = false, target: targetName} = {}) {
        const target = resolveTarget(targetName);
        const {Backend, Assembler} = targetTools(target);
        const emitted = this.emitObject(sourcePath, objectPath, {assemblyPath, sourceRoot, optimizationLevel, runtimeMetrics, target: target.name});
        if (!['auto', 'native', 'system'].includes(linker)) throw new Error(`Unsupported linker '${linker}'`);
        const {ir} = emitted;
        const internalThreadLibraries = target.name === 'aarch64-linux' && ir.externals.some(item => item.runtimeSymbol === 'valen_Operations_threadStart')
            ? new Set(['pthread', 'c']) : new Set();
        const foreignLibraries = ir.foreignLibraries.filter(library => !internalThreadLibraries.has(library) ||
            ir.externals.some(item => item.foreignLibrary === library));
        if (linker === 'native' || linker === 'auto' && foreignLibraries.length === 0) {
            if (foreignLibraries.length) throw new Error('Native linker cannot resolve foreign libraries; use --linker system');
            const moduleIds = [...new Set(ir.functions.map(fn => fn.moduleId).filter(Boolean))];
            const entryModule = ir.functions.find(fn => fn.name === ir.entry)?.moduleId;
            const objects = moduleIds.length > 1 ? moduleIds.map(moduleId => {
                const assembly = new Backend().generate(structuredClone(ir), {
                    optimizationLevel, runtimeMetrics, moduleId, includeRuntime: moduleId === entryModule
                });
                return new Assembler().assembleObject(assembly);
            }) : [new Assembler().assembleObject(emitted.assembly)];
            for (const module of emitted.graph.modules.values()) {
                if (module.compiledArtifact) objects.push(ElfObject.parse(fs.readFileSync(module.compiledArtifact.objectPath)));
            }
            fs.writeFileSync(outputPath, new ElfLinker().linkObjects(objects));
            fs.chmodSync(outputPath, 0o755);
            return {...emitted, outputPath, linker: 'native'};
        }
        const compiledObjects = [...emitted.graph.modules.values()].filter(module => module.compiledArtifact)
            .map(module => module.compiledArtifact.objectPath);
        const libraries = foreignLibraries.map(library => `-l${library}`);
        const result = spawnSync('cc', ['-nostdlib', '-no-pie', objectPath, ...compiledObjects, '-o', outputPath, ...libraries], {encoding: 'utf8'});
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr || `cc exited with status ${result.status}`);
        return {...emitted, outputPath, linker};
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const args = process.argv.slice(2);
    if (args[0] === '--validate-library') {
        if (!args[1] || args.length !== 2) throw new Error('Usage: --validate-library <artifact.vmeta>');
        const metadata = LibraryMetadata.parse(fs.readFileSync(args[1], 'utf8'));
        const objectPath = args[1].endsWith('.vmeta') ? args[1].slice(0, -6) : null;
        if (!objectPath || !fs.existsSync(objectPath)) throw new Error('Compiled library object is missing');
        const actualObject = LibraryMetadata.create({...metadata, object: fs.readFileSync(objectPath)}).objectFingerprint;
        if (actualObject !== metadata.objectFingerprint) throw new Error('Compiled library object fingerprint does not match metadata');
        process.stdout.write(`${metadata.name} ${metadata.version}\n`);
        process.exit(0);
    }
    const levelFlag = args.find(argument => /^-O/.test(argument));
    if (levelFlag && !['-O0', '-O1'].includes(levelFlag)) throw new Error(`Unsupported optimization level '${levelFlag}'`);
    const optimizationLevel = levelFlag === '-O0' ? 0 : 1;
    const runtimeMetrics = args.includes('--runtime-metrics');
    const targetIndex = args.indexOf('--target');
    if (targetIndex >= 0 && !args[targetIndex + 1]) throw new Error('--target requires a target triple');
    const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
    const sourceRootIndex = args.indexOf('--source-root');
    if (sourceRootIndex >= 0 && !args[sourceRootIndex + 1]) throw new Error('--source-root requires a directory');
    const sourceRoot = sourceRootIndex >= 0 ? args[sourceRootIndex + 1] : undefined;
    const linkerIndex = args.indexOf('--linker');
    if (linkerIndex >= 0 && !args[linkerIndex + 1]) throw new Error('--linker requires auto, native, or system');
    const linker = linkerIndex >= 0 ? args[linkerIndex + 1] : 'auto';
    const versionIndex = args.indexOf('--library-version');
    if (versionIndex >= 0 && !args[versionIndex + 1]) throw new Error('--library-version requires a semantic version');
    const libraryVersion = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
    const positional = args.filter((argument, index) => argument !== levelFlag && argument !== '--runtime-metrics' &&
        (targetIndex < 0 || index !== targetIndex && index !== targetIndex + 1) &&
        (sourceRootIndex < 0 || index !== sourceRootIndex && index !== sourceRootIndex + 1) &&
        (linkerIndex < 0 || index !== linkerIndex && index !== linkerIndex + 1) &&
        (versionIndex < 0 || index !== versionIndex && index !== versionIndex + 1));
    const emitLibrary = positional[0] === '--emit-library';
    const emitObject = positional[0] === '--emit-object';
    const sourcePath = positional[emitObject || emitLibrary ? 1 : 0];
    const outputPath = positional[emitObject || emitLibrary ? 2 : 1] ?? (emitObject || emitLibrary ? 'a.o' : 'a.out');
    if (!sourcePath) throw new Error('Usage: node compiler.js [-O0|-O1] <source-file> [output]');
    if (emitLibrary) {
        if (!libraryVersion) throw new Error('--emit-library requires --library-version <major.minor.patch>');
        new Compiler().emitLibrary(sourcePath, outputPath, libraryVersion, {optimizationLevel, sourceRoot, target});
    } else if (emitObject) new Compiler().emitObject(sourcePath, outputPath, {optimizationLevel, runtimeMetrics, sourceRoot, target});
    else new Compiler().compile(sourcePath, outputPath, {optimizationLevel, runtimeMetrics, sourceRoot, linker, target});
}
