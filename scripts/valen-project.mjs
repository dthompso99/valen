#!/usr/bin/env node
import path from 'node:path';
import {ProjectBuild} from '../bootstrap/project-build.js';
import {ProjectLock} from '../bootstrap/project-manifest.js';

const args = process.argv.slice(2);
if (!['build', 'lock'].includes(args[0])) throw new Error('Usage: valen-project <build|lock> [--locked] [--target <target>] [manifest]');
const locked = args.includes('--locked');
const targetIndex = args.indexOf('--target');
if (targetIndex >= 0 && !args[targetIndex + 1]) throw new Error('--target requires a target triple');
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
const positional = args.slice(1).filter((argument, index) => argument !== '--locked' &&
    (targetIndex < 0 || index + 1 !== targetIndex && index + 1 !== targetIndex + 1));
if (positional.length > 1) throw new Error('Usage: valen-project <build|lock> [--locked] [--target <target>] [manifest]');
const manifestPath = path.resolve(positional[0] ?? 'valen.project.json');
if (args[0] === 'build') {
    const result = ProjectBuild.build(manifestPath, {locked, target});
    process.stdout.write(`built ${result.outputPath}\n`);
} else {
    const result = ProjectLock.update(manifestPath, {locked, target});
    process.stdout.write(`${result.changed && !locked ? 'updated' : 'verified'} ${result.lockPath}\n`);
}
