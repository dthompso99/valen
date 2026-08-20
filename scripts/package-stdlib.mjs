#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveTarget} from '../bootstrap/target.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
const value = name => {
    const index = arguments_.indexOf(name);
    if (index < 0) return null;
    if (!arguments_[index + 1]) throw new Error(`${name} requires a value`);
    return arguments_[index + 1];
};
const release = value('--release') ?? 'current';
const target = resolveTarget(value('--target') ?? undefined).name;
const version = value('--version') ?? '0.1.0';
const nativeCompiler = value('--compiler');
const output = path.resolve(value('--output') ?? path.join(root, 'dist/lib/valen'));
const sysroot = path.join(output, release, target);
const directories = {
    source: path.join(sysroot, 'source/std'),
    objects: path.join(sysroot, 'objects/std'),
    metadata: path.join(sysroot, 'metadata/std'),
    interfaces: path.join(sysroot, 'interfaces/std')
};
for (const directory of Object.values(directories)) fs.mkdirSync(directory, {recursive: true});

const modules = ['libSystem.ar', 'libNetwork.ar', 'libEventLoop.ar', 'libHttp.ar',
    'libWebSocket.ar', 'libDiagnostics.ar', 'libScopes.ar', 'libStringMap.ar', 'libCollections.ar', 'libJson.ar'];
for (const module of modules) fs.copyFileSync(path.join(root, 'lib', module), path.join(directories.source, module));

const previousSysroot = process.env.VALEN_SYSROOT;
process.env.VALEN_SYSROOT = sysroot;
try {
    const compiler = nativeCompiler === null ? new (await import('../bootstrap/compiler.js')).Compiler() : null;
    for (const module of modules) {
        const stem = module.slice(0, -3);
        const object = path.join(directories.objects, `${stem}.o`);
        if (compiler !== null) compiler.emitLibrary(path.join(directories.source, module), object, version,
            {sourceRoot: path.join(sysroot, 'source'), target});
        else {
            const result = spawnSync(path.resolve(nativeCompiler), ['--source-root', path.join(sysroot, 'source'),
                '--target', target, '--library-version', version, '--emit-library', path.join(directories.source, module), '-o', object],
            {stdio: 'inherit', env: {...process.env, VALEN_SYSROOT: sysroot}});
            if (result.error) throw result.error;
            if (result.status !== 0) throw new Error(`Valen compiler exited with status ${result.status}`);
        }
        fs.renameSync(`${object}.vmeta`, path.join(directories.metadata, `${stem}.o.vmeta`));
        fs.renameSync(`${object}.vmi`, path.join(directories.interfaces, `${stem}.vmi`));
    }
} finally {
    if (previousSysroot === undefined) delete process.env.VALEN_SYSROOT;
    else process.env.VALEN_SYSROOT = previousSysroot;
}
process.stdout.write(`${sysroot}\n`);
