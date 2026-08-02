import fs from 'fs';
import path from 'path';
import {Parser} from './parser.js';

export class ModuleLoader {
    constructor({sourceRoot} = {}) {
        this.sourceRoot = sourceRoot ? path.resolve(sourceRoot) : null;
        this.modules = new Map();
        this.loading = [];
        this.diagnostics = [];
    }

    load(entryPath) {
        const entry = path.resolve(entryPath);
        if (!this.sourceRoot) this.sourceRoot = path.dirname(entry);
        const entryModule = this.loadModule(entry, null);
        return {entry: entryModule, modules: this.modules, diagnostics: this.diagnostics};
    }

    loadModule(filePath, importDeclaration) {
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
            source = fs.readFileSync(canonicalPath, 'utf8');
        } catch (error) {
            this.report(importDeclaration?.span, `Cannot load '${canonicalPath}': ${error.message}`);
            return null;
        }

        const module = {
            path: canonicalPath,
            id: this.moduleId(canonicalPath),
            program: new Parser().parse(source, canonicalPath),
            imports: new Map()
        };
        this.modules.set(canonicalPath, module);
        this.loading.push(canonicalPath);

        for (const declaration of module.program.imports) {
            const importedPath = this.resolveImport(canonicalPath, declaration.path);
            const imported = this.loadModule(importedPath, declaration);
            if (module.imports.has(declaration.name)) {
                this.report(declaration.span, `Duplicate import '${declaration.name}'`);
            } else if (imported) {
                module.imports.set(declaration.name, {declaration, module: imported});
            }
        }

        this.loading.pop();
        return module;
    }

    resolveImport(importerPath, specifier) {
        if (specifier.startsWith('/')) {
            return path.resolve(this.sourceRoot, `.${specifier}`);
        }
        return path.resolve(path.dirname(importerPath), specifier);
    }

    canonicalize(filePath) {
        const resolved = path.resolve(filePath);
        try {
            return fs.realpathSync(resolved);
        } catch {
            return resolved;
        }
    }

    moduleId(filePath) {
        const relative = path.relative(this.sourceRoot, filePath).split(path.sep).join('/');
        return `/${relative}`;
    }

    report(span, message) {
        this.diagnostics.push({severity: 'error', message, span: span ?? {
            source: '<module-loader>', line: 1, column: 1, start: 0, end: 0
        }});
    }
}
