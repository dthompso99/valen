import fs from 'node:fs';
import {moduleInterfaceHash} from './module-interface.js';
import {resolveTarget} from './target.js';

export const LIBRARY_METADATA_VERSION = 1;
export const VALEN_COMPILER_INTERFACE = 'valen-interface-1';
export const VALEN_NATIVE_ABI = 'valen-native-1';

const semanticVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const signedHash = value => BigInt.asIntN(64, BigInt(`0x${moduleInterfaceHash(value)}`)).toString();

export class LibraryMetadata {
    static create({name, version, interfaceFingerprint, implementationFingerprint, object, dependencies = [], target}) {
        const selectedTarget = resolveTarget(target);
        if (!semanticVersion.test(version)) throw new Error(`Invalid semantic version '${version}'`);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid library name '${name}'`);
        return {format: LIBRARY_METADATA_VERSION, name, version, compiler: VALEN_COMPILER_INTERFACE,
            target: selectedTarget.name, abi: selectedTarget.abi, interfaceFingerprint, implementationFingerprint,
            objectFingerprint: signedHash(object), dependencies: [...dependencies].sort((a, b) => a.name.localeCompare(b.name))};
    }

    static serialize(metadata) {
        return [`VALEN-LIBRARY-${metadata.format}`, `name=${metadata.name}`, `version=${metadata.version}`,
            `compiler=${metadata.compiler}`, `target=${metadata.target}`, `abi=${metadata.abi}`,
            `interface=${metadata.interfaceFingerprint}`, `implementation=${metadata.implementationFingerprint}`,
            `object=${metadata.objectFingerprint}`,
            ...metadata.dependencies.map(item => `dependency=${item.name}|${item.interfaceFingerprint}`),
            'VALEN-LIBRARY-END', ''].join('\n');
    }

    static parse(source, expected = {}) {
        const selectedTarget = resolveTarget(expected.target);
        const lines = source.split('\n');
        if (lines[0] !== `VALEN-LIBRARY-${LIBRARY_METADATA_VERSION}` || lines.at(-2) !== 'VALEN-LIBRARY-END') {
            throw new Error('Unsupported or malformed Valen library metadata');
        }
        const values = new Map();
        const dependencies = [];
        for (const line of lines.slice(1, -2)) {
            const separator = line.indexOf('=');
            if (separator < 1) throw new Error('Malformed Valen library metadata field');
            const key = line.slice(0, separator), value = line.slice(separator + 1);
            if (key === 'dependency') {
                const split = value.indexOf('|');
                if (split < 1) throw new Error('Malformed Valen library dependency');
                dependencies.push({name: value.slice(0, split), interfaceFingerprint: value.slice(split + 1)});
            } else if (values.has(key)) throw new Error(`Duplicate Valen library metadata field '${key}'`);
            else values.set(key, value);
        }
        for (const key of ['name', 'version', 'compiler', 'target', 'abi', 'interface', 'implementation', 'object']) {
            if (!values.get(key)) throw new Error(`Missing Valen library metadata field '${key}'`);
        }
        if (!semanticVersion.test(values.get('version'))) throw new Error(`Invalid semantic version '${values.get('version')}'`);
        const metadata = {format: LIBRARY_METADATA_VERSION, name: values.get('name'), version: values.get('version'),
            compiler: values.get('compiler'), target: values.get('target'), abi: values.get('abi'),
            interfaceFingerprint: values.get('interface'), implementationFingerprint: values.get('implementation'),
            objectFingerprint: values.get('object'), dependencies};
        for (const [key, value] of Object.entries({compiler: VALEN_COMPILER_INTERFACE, target: selectedTarget.name,
            abi: selectedTarget.abi, ...expected})) {
            if (value !== undefined && metadata[key] !== value) throw new Error(`Incompatible library ${key}: expected '${value}', found '${metadata[key]}'`);
        }
        return metadata;
    }

    static write(path, metadata) { fs.writeFileSync(path, LibraryMetadata.serialize(metadata)); }
}
