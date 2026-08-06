import path from 'node:path';

const definitions = new Map([
    ['x86_64-linux', Object.freeze({name: 'x86_64-linux', architecture: 'x86_64', operatingSystem: 'linux', elfMachine: 62,
        abi: 'valen-native-1'})],
    ['aarch64-linux', Object.freeze({name: 'aarch64-linux', architecture: 'aarch64', operatingSystem: 'linux', elfMachine: 183,
        abi: 'valen-native-1'})]
]);

const aliases = new Map([
    ['amd64-linux', 'x86_64-linux'], ['x64-linux', 'x86_64-linux'],
    ['arm64-linux', 'aarch64-linux']
]);

export const supportedTargets = Object.freeze([...definitions.keys()]);

export function hostTarget() {
    const architecture = new Map([['x64', 'x86_64'], ['arm64', 'aarch64']]).get(process.arch) ?? process.arch;
    const operatingSystem = process.platform === 'linux' ? 'linux' : process.platform;
    return `${architecture}-${operatingSystem}`;
}

export function resolveTarget(value = process.env.VALEN_TARGET ?? hostTarget()) {
    if (value && typeof value === 'object' && definitions.get(value.name) === value) return value;
    const name = aliases.get(value) ?? value;
    const target = definitions.get(name);
    if (!target) throw new Error(`Unsupported target '${value}'; supported targets: ${supportedTargets.join(', ')}`);
    return target;
}

export function defaultSysroot(root, target) {
    return path.resolve(root, `../lib/valen/current/${resolveTarget(target).name}`);
}
