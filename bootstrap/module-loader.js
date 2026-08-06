import fs from 'fs';
import path from 'path';
import {Parser} from './parser.js';
import {diagnostic, DiagnosticSeverity} from './diagnostics.js';
import {ModuleInterface} from './module-interface.js';
import {LibraryMetadata} from './library-metadata.js';
import {resolveTarget} from './target.js';

export class ModuleLoader {
    constructor({sourceRoot, libraryPath = process.env.VALEN_LIBRARY_PATH ?? process.env.ARGON_LIBRARY_PATH,
        sysroot = process.env.VALEN_SYSROOT, documents = new Map(), target} = {}) {
        this.target = resolveTarget(target);
        this.sourceRoot = sourceRoot ? path.resolve(sourceRoot) : null;
        this.libraryPaths = (libraryPath ?? '').split(path.delimiter).filter(Boolean).map(entry => path.resolve(entry));
        this.sysroot = sysroot ? path.resolve(sysroot) : null;
        this.modules = new Map();
        this.loading = [];
        this.diagnostics = [];
        this.documents = documents;
    }

    load(entryPath) {
        const entry = path.resolve(entryPath);
        if (!this.sourceRoot) this.sourceRoot = path.dirname(entry);
        const entryModule = this.loadModule(entry, null, this.sourceRoot);
        return {entry: entryModule, modules: this.modules, diagnostics: this.diagnostics};
    }

    loadModule(filePath, importDeclaration, owningRoot) {
        const canonicalPath = this.canonicalize(filePath);
        const existing = this.modules.get(canonicalPath);
        if (existing) {
            if (this.loading.includes(canonicalPath)) {
                this.report(importDeclaration?.span, `Circular import: ${[...this.loading, canonicalPath].join(' -> ')}`);
            }
            return existing;
        }

        let source;
        try {
            source = this.documents.get(canonicalPath) ?? fs.readFileSync(canonicalPath, 'utf8');
        } catch (error) {
            this.report(importDeclaration?.span, `Cannot load '${canonicalPath}': ${error.message}`);
            return null;
        }

        const module = {
            path: canonicalPath,
            id: this.moduleId(canonicalPath),
            source,
            program: new Parser().parse(source, canonicalPath),
            imports: new Map(),
            owningRoot,
            compiledArtifact: null
        };
        this.modules.set(canonicalPath, module);
        this.loading.push(canonicalPath);

        for (const declaration of module.program.imports) {
            const resolved = this.resolveImport(module, declaration.path, declaration.span);
            const imported = resolved ? this.loadModule(resolved.path, declaration, resolved.root) : null;
            if (module.imports.has(declaration.name)) {
                this.report(declaration.span, `Duplicate import '${declaration.name}'`);
            } else if (imported) {
                module.imports.set(declaration.name, {declaration, module: imported});
            }
        }

        this.loading.pop();
        this.attachCompiledArtifact(module);
        return module;
    }

    resolveImport(importer, specifier, span) {
        if (!specifier.endsWith('.ar')) {
            this.report(span, `Import '${specifier}' must include the .ar extension`);
            return null;
        }
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
            const candidate = path.resolve(path.dirname(importer.path), specifier);
            if (!this.contains(importer.owningRoot, candidate)) {
                this.report(span, `Import '${specifier}' escapes its owning root '${importer.owningRoot}'`);
                return null;
            }
            return this.resolveCandidate(candidate, importer.owningRoot, specifier, span, [candidate]);
        }
        if (specifier.startsWith('/')) {
            const candidate = path.resolve(this.sourceRoot, `.${specifier}`);
            if (!this.contains(this.sourceRoot, candidate)) {
                this.report(span, `Project import '${specifier}' escapes source root '${this.sourceRoot}'`);
                return null;
            }
            return this.resolveCandidate(candidate, this.sourceRoot, specifier, span, [candidate]);
        }
        if (specifier.split('/').includes('..')) {
            this.report(span, `Library import '${specifier}' cannot contain '..'`);
            return null;
        }
        if (this.sysroot) {
            const root = path.join(this.sysroot, 'source');
            if (this.contains(root, importer.path)) {
                const candidate = path.resolve(path.dirname(importer.path), specifier);
                if (this.contains(root, candidate) && this.exists(candidate)) return {path: candidate, root};
            }
        }
        if (specifier.startsWith('std/') && this.sysroot) {
            const root = path.join(this.sysroot, 'source');
            const candidate = path.resolve(root, specifier);
            if (!this.contains(root, candidate)) {
                this.report(span, `Standard-library import '${specifier}' escapes sysroot '${root}'`);
                return null;
            }
            if (this.exists(candidate)) return {path: candidate, root};
        }
        const searched = [];
        for (const root of this.libraryPaths) {
            const candidates = [path.resolve(root, specifier)];
            if (specifier.startsWith('std/')) candidates.push(path.resolve(root, specifier.slice(4)));
            for (const candidate of candidates) {
                searched.push(candidate);
                if (this.exists(candidate)) return {path: candidate, root};
            }
        }
        this.report(span, `Cannot resolve library import '${specifier}' from '${importer.path}'; searched: ${searched.join(', ') || '<no VALEN_LIBRARY_PATH entries>'}`);
        return null;
    }

    resolveCandidate(candidate, root, specifier, span, searched) {
        if (this.exists(candidate)) return {path: candidate, root};
        this.report(span, `Cannot resolve import '${specifier}'; searched: ${searched.join(', ')}`);
        return null;
    }

    exists(candidate) {
        const resolved = path.resolve(candidate);
        return this.documents.has(resolved) || fs.existsSync(resolved);
    }

    contains(root, candidate) {
        const relative = path.relative(path.resolve(root), path.resolve(candidate));
        return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }

    canonicalize(filePath) {
        const resolved = path.resolve(filePath);
        if (this.documents.has(resolved)) return resolved;
        try {
            return fs.realpathSync(resolved);
        } catch {
            return resolved;
        }
    }

    moduleId(filePath) {
        if (this.sysroot) {
            const sourceRoot = path.join(this.sysroot, 'source');
            if (this.contains(sourceRoot, filePath)) return `/${path.relative(sourceRoot, filePath).split(path.sep).join('/')}`;
        }
        const relative = path.relative(this.sourceRoot, filePath).split(path.sep).join('/');
        return `/${relative}`;
    }

    attachCompiledArtifact(module) {
        if (!this.sysroot) return;
        const sourceRoot = path.join(this.sysroot, 'source');
        if (!this.contains(sourceRoot, module.path)) return;
        const relative = path.relative(sourceRoot, module.path).replace(/\.ar$/, '');
        const objectPath = path.join(this.sysroot, 'objects', `${relative}.o`);
        const metadataPath = path.join(this.sysroot, 'metadata', `${relative}.o.vmeta`);
        const interfacePath = path.join(this.sysroot, 'interfaces', `${relative}.vmi`);
        if (![objectPath, metadataPath, interfacePath].every(candidate => fs.existsSync(candidate))) return;
        try {
            const libraries = module.program.libraries.filter(item => item.visibility !== 'private');
            if (libraries.length !== 1) throw new Error('compiled module must declare exactly one public library');
            const metadata = LibraryMetadata.parse(fs.readFileSync(metadataPath, 'utf8'), {name: libraries[0].name, target: this.target.name});
            const object = fs.readFileSync(objectPath);
            const actualObject = LibraryMetadata.create({...metadata, object, target: this.target.name}).objectFingerprint;
            if (actualObject !== metadata.objectFingerprint) throw new Error('compiled object fingerprint does not match metadata');
            const expectedInterface = ModuleInterface.create(module);
            const installedInterface = ModuleInterface.parse(fs.readFileSync(interfacePath, 'utf8'));
            if (metadata.interfaceFingerprint !== expectedInterface.interfaceFingerprint ||
                installedInterface.interfaceFingerprint !== expectedInterface.interfaceFingerprint) {
                throw new Error('compiled interface fingerprint does not match source');
            }
            for (const dependency of metadata.dependencies) {
                const imported = module.imports.get(dependency.name)?.module;
                if (!imported || ModuleInterface.create(imported).interfaceFingerprint !== dependency.interfaceFingerprint) {
                    throw new Error(`compiled dependency '${dependency.name}' interface does not match`);
                }
            }
            module.compiledArtifact = {objectPath, metadataPath, interfacePath, metadata};
        } catch (error) {
            this.report(null, `Invalid compiled standard-library artifact for '${module.path}': ${error.message}`);
        }
    }

    report(span, message) {
        this.diagnostics.push(diagnostic(DiagnosticSeverity.error, message, span ?? {
            source: '<module-loader>', line: 1, column: 1, start: 0, end: 0
        }));
    }
}
