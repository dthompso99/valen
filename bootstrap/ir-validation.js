const terminators = new Set(['return', 'jump', 'branch']);
const integerTypes = new Set(['bool', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'i64']);
const supportedOperations = new Set([
    'allocate', 'array_append', 'array_length', 'array_load', 'array_new', 'array_store', 'binary', 'branch',
    'builder_append_byte', 'builder_append_bytes', 'builder_append_string', 'builder_build', 'builder_length', 'builder_new', 'bytes_to_string', 'call',
    'checked_cast', 'constant', 'float_constant', 'contract_call', 'convert', 'declare_local', 'destroy_array', 'destroy_object',
    'integer_to_string', 'jump', 'load_field', 'load_local', 'optional_box', 'return', 'store_field', 'store_local', 'string_concat',
    'string_constant', 'string_equal', 'string_length', 'string_load', 'string_slice', 'string_to_bytes', 'structural_copy',
    'structural_equal', 'structural_hash', 'test_expect', 'test_failures', 'type_test', 'unary', 'unwrap', 'virtual_call'
]);

export class IrValidationError extends Error {
    constructor(diagnostics) {
        super(`Invalid IR:\n${diagnostics.map(item => `- ${item}`).join('\n')}`);
        this.name = 'IrValidationError';
        this.diagnostics = diagnostics;
    }
}

export class IrCanonicalizer {
    run(program, {optimize = true} = {}) {
        for (const fn of program.functions) this.canonicalizeFunction(fn, optimize);
        return program;
    }

    canonicalizeFunction(fn, optimize = true) {
        for (const block of fn.blocks) {
            const terminal = block.instructions.findIndex(instruction => terminators.has(instruction.op));
            if (terminal >= 0) block.instructions.length = terminal + 1;
            if (terminal < 0 && fn.returnType === 'void') block.instructions.push({op: 'return'});
        }
        if (optimize) {
            this.foldConstants(fn);
            this.removeUnreachable(fn);
            this.removeDeadValues(fn);
        }
    }

    foldConstants(fn) {
        const constants = new Map();
        for (const block of fn.blocks) {
            for (let index = 0; index < block.instructions.length; index++) {
                let instruction = block.instructions[index];
                const folded = this.foldInstruction(instruction, constants);
                if (folded !== null) {
                    instruction = {op: 'constant', result: instruction.result, type: instruction.type, value: folded.toString()};
                    block.instructions[index] = instruction;
                }
                if (instruction.op === 'constant' && instruction.result && integerTypes.has(instruction.type)) {
                    constants.set(instruction.result, {value: BigInt(instruction.value), type: instruction.type});
                }
                if (instruction.op === 'branch') {
                    const condition = instruction.condition?.kind === 'temporary' ? constants.get(instruction.condition.name) : null;
                    if (condition) block.instructions[index] = {op: 'jump', target: condition.value !== 0n ? instruction.thenTarget : instruction.elseTarget};
                }
            }
        }
    }

    foldInstruction(instruction, constants) {
        if (!instruction.result || !integerTypes.has(instruction.type)) return null;
        const constant = value => value?.kind === 'temporary' ? constants.get(value.name) : null;
        if (instruction.op === 'unary') {
            const operand = constant(instruction.operand);
            if (!operand) return null;
            if (instruction.operator === '-') return this.normalizeInteger(-operand.value, instruction.type);
            if (instruction.operator === '!') return operand.value === 0n ? 1n : 0n;
            return null;
        }
        if (instruction.op === 'convert') {
            const value = constant(instruction.value);
            return value && integerTypes.has(value.type) ? this.normalizeInteger(value.value, instruction.type) : null;
        }
        if (instruction.op !== 'binary') return null;
        const left = constant(instruction.left);
        const right = constant(instruction.right);
        if (!left || !right) return null;
        const a = left.value;
        const b = right.value;
        let value;
        switch (instruction.operator) {
            case '+': value = a + b; break;
            case '-': value = a - b; break;
            case '*': value = a * b; break;
            case '/':
                if (b === 0n || instruction.type === 'i64' && a === -(1n << 63n) && b === -1n) return null;
                value = a / b;
                break;
            case '&': value = a & b; break;
            case '|': value = a | b; break;
            case '^': value = a ^ b; break;
            case '<<': value = a << (b & 63n); break;
            case '>>': value = instruction.left.type?.startsWith('u')
                ? this.normalizeInteger(a, instruction.left.type) >> (b & 63n)
                : a >> (b & 63n); break;
            case '==': case '===': return a === b ? 1n : 0n;
            case '!=': case '!==': return a !== b ? 1n : 0n;
            case '<': return a < b ? 1n : 0n;
            case '<=': return a <= b ? 1n : 0n;
            case '>': return a > b ? 1n : 0n;
            case '>=': return a >= b ? 1n : 0n;
            default: return null;
        }
        return this.normalizeInteger(value, instruction.type);
    }

    normalizeInteger(value, type) {
        if (type === 'bool') return value === 0n ? 0n : 1n;
        if (type === 'i64') return BigInt.asIntN(64, value);
        const bits = Number(type.slice(1));
        return type.startsWith('u') ? BigInt.asUintN(bits, value) : BigInt.asIntN(bits, value);
    }

    removeDeadValues(fn) {
        const pure = instruction => ['constant', 'float_constant', 'string_constant', 'load_local', 'unary'].includes(instruction.op) ||
            instruction.op === 'binary' && instruction.operator !== '/' ||
            instruction.op === 'convert' && integerTypes.has(instruction.type) && integerTypes.has(instruction.value?.type);
        let changed = true;
        while (changed) {
            changed = false;
            const uses = new Map();
            for (const block of fn.blocks) for (const instruction of block.instructions) {
                for (const value of new IrValidator().values(instruction)) if (value.kind === 'temporary') uses.set(value.name, (uses.get(value.name) ?? 0) + 1);
            }
            for (const block of fn.blocks) {
                const retained = block.instructions.filter(instruction => {
                    const dead = instruction.result && !uses.has(instruction.result) && pure(instruction);
                    if (dead) changed = true;
                    return !dead;
                });
                block.instructions = retained;
            }
        }
    }

    removeUnreachable(fn) {
        if (!fn.blocks.length) return;
        const byLabel = new Map(fn.blocks.map(block => [block.label, block]));
        const reachable = new Set();
        const pending = [fn.blocks[0].label];
        while (pending.length) {
            const label = pending.pop();
            if (reachable.has(label)) continue;
            const block = byLabel.get(label);
            if (!block) continue;
            reachable.add(label);
            const end = block.instructions.at(-1);
            if (end?.op === 'jump') pending.push(end.target);
            if (end?.op === 'branch') pending.push(end.thenTarget, end.elseTarget);
        }
        fn.blocks = fn.blocks.filter(block => reachable.has(block.label));
    }
}

export class IrValidator {
    validate(program) {
        const errors = [];
        const types = this.unique(program.types, 'type', errors);
        const functions = this.unique([...program.functions, ...program.externals], 'function', errors);
        const entry = functions.get(program.entry);
        if (!program.entry || !entry || !program.functions.includes(entry)) errors.push(`entry '${program.entry ?? '<missing>'}' is not a defined function`);

        for (const type of program.types) {
            if (type.base && !types.has(type.base)) errors.push(`type '${type.name}' has unknown base '${type.base}'`);
            if (type.initializer && !functions.has(type.initializer)) errors.push(`type '${type.name}' has unknown initializer '${type.initializer}'`);
            for (const method of type.virtualMethods ?? []) if (!functions.has(method.target)) errors.push(`type '${type.name}' has unknown virtual target '${method.target}'`);
            for (const contract of type.contracts ?? []) for (const method of contract.methods ?? []) {
                if (!functions.has(method.target)) errors.push(`type '${type.name}' has unknown contract target '${method.target}'`);
            }
        }
        for (const fn of program.functions) this.validateFunction(fn, types, functions, errors);
        if (errors.length) throw new IrValidationError(errors);
        return program;
    }

    unique(items, label, errors) {
        const result = new Map();
        for (const item of items) {
            const name = item?.name ?? item?.label;
            if (!name) errors.push(`${label} has no name`);
            else if (result.has(name)) errors.push(`duplicate ${label} '${name}'`);
            else result.set(name, item);
        }
        return result;
    }

    validateFunction(fn, types, functions, errors) {
        const prefix = `function '${fn.name}'`;
        if (!fn.returnType) errors.push(`${prefix} has no return type`);
        if (fn.parameters[0]?.name === 'self' && !types.has(fn.owner)) errors.push(`${prefix} has unknown owner type '${fn.owner}'`);
        const blocks = this.unique(fn.blocks, `${prefix} block`, errors);
        if (!fn.blocks.length) errors.push(`${prefix} has no blocks`);
        const definitions = new Set(fn.parameters.map(parameter => `parameter:${parameter.name}`));
        const uses = [];
        const locals = new Set();
        for (const block of fn.blocks) {
            if (!block.instructions.length) errors.push(`${prefix} block '${block.label}' is empty`);
            block.instructions.forEach((instruction, index) => {
                const where = `${prefix} block '${block.label}' instruction ${index} (${instruction.op ?? '<missing>'})`;
                if (!instruction.op) errors.push(`${where} has no opcode`);
                else if (!supportedOperations.has(instruction.op)) errors.push(`${where} uses an unsupported opcode`);
                if (instruction.result) {
                    if (!instruction.type) errors.push(`${where} result '${instruction.result}' has no type`);
                    if (definitions.has(`temporary:${instruction.result}`)) errors.push(`${where} redefines temporary '${instruction.result}'`);
                    definitions.add(`temporary:${instruction.result}`);
                }
                if (instruction.op === 'declare_local') {
                    if (!instruction.name) errors.push(`${where} has no local name`);
                    else if (locals.has(instruction.name)) errors.push(`${where} redeclares local '${instruction.name}'`);
                    else locals.add(instruction.name);
                }
                if (['load_local', 'store_local'].includes(instruction.op) && !locals.has(instruction.name)) errors.push(`${where} references undeclared local '${instruction.name}'`);
                if (instruction.op === 'jump' && !blocks.has(instruction.target)) errors.push(`${where} targets unknown block '${instruction.target}'`);
                if (instruction.op === 'branch') {
                    if (!instruction.condition) errors.push(`${where} has no condition`);
                    if (!blocks.has(instruction.thenTarget)) errors.push(`${where} targets unknown block '${instruction.thenTarget}'`);
                    if (!blocks.has(instruction.elseTarget)) errors.push(`${where} targets unknown block '${instruction.elseTarget}'`);
                }
                if (['call', 'virtual_call', 'contract_call'].includes(instruction.op)) this.validateCall(instruction, functions, where, errors);
                for (const value of this.values(instruction)) {
                    if (!value.type) errors.push(`${where} uses an untyped value`);
                    if (value.kind === 'temporary') uses.push([`temporary:${value.name}`, where]);
                    if (value.kind === 'parameter') uses.push([`parameter:${value.name}`, where]);
                }
            });
            if (!terminators.has(block.instructions.at(-1)?.op)) errors.push(`${prefix} block '${block.label}' has no terminator`);
        }
        for (const [definition, where] of uses) if (!definitions.has(definition)) errors.push(`${where} uses undefined ${definition.replace(':', " '")}'`);
    }

    validateCall(instruction, functions, where, errors) {
        const target = functions.get(instruction.target);
        if (!target) {
            errors.push(`${where} calls unknown function '${instruction.target}'`);
            return;
        }
        const actual = instruction.arguments?.length ?? 0;
        const expected = target.parameters?.length ?? 0;
        if (actual !== expected) errors.push(`${where} passes ${actual} arguments to '${instruction.target}', expected ${expected}`);
        if (instruction.result && instruction.type !== target.returnType) errors.push(`${where} result type '${instruction.type}' does not match '${target.returnType}'`);
        if (!instruction.result && target.returnType !== 'void') errors.push(`${where} discards non-void result from '${instruction.target}'`);
    }

    values(instruction) {
        const values = [];
        const add = value => {
            if (!value || typeof value !== 'object') return;
            if (value.kind) {
                values.push(value);
                return;
            }
            if (Array.isArray(value)) for (const item of value) add(item);
            else for (const [key, item] of Object.entries(value)) if (key !== 'result') add(item);
        };
        for (const [key, value] of Object.entries(instruction)) if (key !== 'result') add(value);
        return values;
    }
}

export function prepareIr(program, {optimize = true} = {}) {
    new IrCanonicalizer().run(program, {optimize});
    return new IrValidator().validate(program);
}
