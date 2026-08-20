const terminators = new Set(['return', 'jump', 'branch']);
const integerTypes = new Set(['bool', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'i64']);
const supportedOperations = new Set([
    'allocate', 'array_append', 'array_capacity', 'array_insert', 'array_length', 'array_load', 'array_new', 'array_remove', 'array_reserve', 'array_shrink', 'array_slice', 'array_store', 'binary', 'branch',
    'builder_append_byte', 'builder_append_bytes', 'builder_append_string', 'builder_build', 'builder_length', 'builder_new', 'bytes_to_string', 'call',
    'checked_cast', 'constant', 'float_constant', 'contract_call', 'convert', 'declare_local', 'destroy_array', 'destroy_object',
    'integer_to_string', 'jump', 'load_field', 'load_local', 'optional_box', 'return', 'store_field', 'store_local', 'string_concat',
    'string_codepoint_at', 'string_codepoint_length', 'string_constant', 'string_equal', 'string_grapheme_at', 'string_grapheme_length', 'string_length', 'string_load', 'string_slice', 'string_to_bytes', 'structural_copy',
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
    run(program, {optimize = true, scalarReplacement = true} = {}) {
        for (const fn of program.functions) this.canonicalizeFunction(fn, optimize, program, scalarReplacement);
        return program;
    }

    canonicalizeFunction(fn, optimize = true, program = null, scalarReplacement = true) {
        for (const block of fn.blocks) {
            const terminal = block.instructions.findIndex(instruction => terminators.has(instruction.op));
            if (terminal >= 0) block.instructions.length = terminal + 1;
            if (terminal < 0 && fn.returnType === 'void') block.instructions.push({op: 'return'});
        }
        if (optimize) {
            this.foldConstants(fn);
            this.simplifyControlFlow(fn);
            this.removeUnreachable(fn);
            this.splitCriticalEdges(fn);
            this.propagateLocalValues(fn);
            if (program) {
                this.devirtualizeExactCalls(fn, program);
                this.inlineLeafCalls(fn, program);
                this.propagateLocalValues(fn);
            }
            if (program && scalarReplacement) this.replaceLocalObjects(fn, program);
            this.removeDeadValues(fn);
        }
    }

    predecessors(fn) {
        const result = new Map(fn.blocks.map(block => [block.label, []]));
        for (const block of fn.blocks) {
            const end = block.instructions.at(-1);
            if (end?.op === 'jump' && result.has(end.target)) result.get(end.target).push(block.label);
            if (end?.op === 'branch') {
                if (result.has(end.thenTarget)) result.get(end.thenTarget).push(block.label);
                if (result.has(end.elseTarget)) result.get(end.elseTarget).push(block.label);
            }
        }
        return result;
    }

    splitCriticalEdges(fn) {
        const predecessors = this.predecessors(fn);
        const labels = new Set(fn.blocks.map(block => block.label));
        const added = [];
        let sequence = 0;
        const fresh = () => { let label; do label = `critical_edge_${sequence++}`; while (labels.has(label)); labels.add(label); return label; };
        for (const block of [...fn.blocks]) {
            const end = block.instructions.at(-1);
            if (end?.op !== 'branch') continue;
            for (const key of ['thenTarget', 'elseTarget']) {
                const target = end[key];
                if ((predecessors.get(target)?.length ?? 0) < 2) continue;
                const label = fresh();
                end[key] = label;
                added.push({label, instructions: [{op: 'jump', target}]});
            }
        }
        fn.blocks.push(...added);
    }

    devirtualizeExactCalls(fn, program) {
        const allocations = new Map();
        const declarations = new Map();
        const invalidLocals = new Set();
        for (const block of fn.blocks) for (const instruction of block.instructions) {
            if (instruction.op === 'allocate' && instruction.result) allocations.set(instruction.result, instruction.type ?? instruction.objectType);
            if (instruction.op === 'declare_local') {
                if (declarations.has(instruction.name)) invalidLocals.add(instruction.name);
                else declarations.set(instruction.name, instruction.value);
            }
            if (instruction.op === 'store_local') invalidLocals.add(instruction.name);
        }
        const exactLocals = new Map();
        const exactTemporaries = new Map(allocations);
        let changed = true;
        while (changed) {
            changed = false;
            for (const [name, value] of declarations) if (!invalidLocals.has(name) && !exactLocals.has(name) && value?.kind === 'temporary' && exactTemporaries.has(value.name)) {
                exactLocals.set(name, exactTemporaries.get(value.name)); changed = true;
            }
            for (const block of fn.blocks) for (const instruction of block.instructions) if (instruction.op === 'load_local' && instruction.result && exactLocals.has(instruction.name) && !exactTemporaries.has(instruction.result)) {
                exactTemporaries.set(instruction.result, exactLocals.get(instruction.name)); changed = true;
            }
        }
        const types = new Map(program.types.map(type => [type.name, type]));
        for (const block of fn.blocks) for (const instruction of block.instructions) {
            if (!['virtual_call', 'contract_call'].includes(instruction.op) || !instruction.arguments?.length) continue;
            const receiver = instruction.arguments[0];
            const type = receiver?.kind === 'temporary' ? types.get(exactTemporaries.get(receiver.name)) : null;
            let target = null;
            if (instruction.op === 'virtual_call') target = type?.virtualMethods?.[instruction.slot]?.target;
            else target = type?.contracts?.find(contract => contract.name === (instruction.contractType ?? instruction.ownerType))?.methods?.[instruction.slot]?.target;
            if (!target) continue;
            instruction.op = 'call';
            instruction.target = target;
            instruction.ownerType = null;
            instruction.contractType = null;
            instruction.slot = -1;
        }
    }

    inlineLeafCalls(fn, program) {
        const primitive = type => ['bool', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64'].includes(type);
        const functions = new Map(program.functions.map(item => [item.name, item]));
        const used = new Set(fn.blocks.flatMap(block => block.instructions).map(item => item.result).filter(Boolean));
        let sequence = 0;
        const fresh = () => { let name; do name = `%inline${sequence++}`; while (used.has(name)); used.add(name); return name; };
        for (const block of fn.blocks) {
            const aliases = new Map();
            const resolve = value => {
                const visited = new Set();
                while (value?.kind === 'temporary' && aliases.has(value.name) && !visited.has(value.name)) { visited.add(value.name); value = aliases.get(value.name); }
                return value;
            };
            const replace = value => {
                if (!value || typeof value !== 'object') return value;
                if (value.kind) return resolve(value);
                if (Array.isArray(value)) return value.map(replace);
                for (const [key, child] of Object.entries(value)) if (key !== 'result') value[key] = replace(child);
                return value;
            };
            const retained = [];
            for (const instruction of block.instructions) {
                for (const [key, value] of Object.entries(instruction)) if (key !== 'result') instruction[key] = replace(value);
                const callee = instruction.op === 'call' ? functions.get(instruction.target) : null;
                const body = callee?.blocks?.length === 1 ? callee.blocks[0].instructions : [];
                const allowed = new Set(['constant', 'float_constant', 'binary', 'unary', 'convert', 'return']);
                if (!callee || callee === fn || callee.moduleId !== fn.moduleId || !instruction.result || !primitive(instruction.type) || body.length > 6 ||
                    body.length === 0 || body.at(-1).op !== 'return' || body.some(item => !allowed.has(item.op)) ||
                    callee.parameters.length !== instruction.arguments.length) { retained.push(instruction); continue; }
                const values = new Map(callee.parameters.map((parameter, index) => [parameter.name, instruction.arguments[index]]));
                const remap = value => {
                    if (!value || typeof value !== 'object') return value;
                    if (value.kind === 'parameter') return values.get(value.name) ?? value;
                    if (value.kind === 'temporary') return values.get(value.name) ?? value;
                    if (Array.isArray(value)) return value.map(remap);
                    for (const [key, child] of Object.entries(value)) if (key !== 'result') value[key] = remap(child);
                    return value;
                };
                for (const item of body.slice(0, -1)) {
                    const clone = structuredClone(item);
                    for (const [key, value] of Object.entries(clone)) if (key !== 'result') clone[key] = remap(value);
                    if (clone.result) { const name = fresh(); values.set(clone.result, {kind: 'temporary', name, type: clone.type}); clone.result = name; }
                    retained.push(clone);
                }
                const returned = remap(structuredClone(body.at(-1).value));
                if (returned?.kind === 'temporary') {
                    const producer = retained.findLast(item => item.result === returned.name);
                    if (producer) { producer.result = instruction.result; values.set(returned.name, {kind: 'temporary', name: instruction.result, type: instruction.type}); }
                    else aliases.set(instruction.result, returned);
                } else aliases.set(instruction.result, returned);
            }
            block.instructions = retained;
        }
    }

    replaceLocalObjects(fn, program) {
        const primitive = type => ['bool', 'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64', 'f32', 'f64'].includes(type);
        const types = new Map(program.types.map(type => [type.name, type]));
        const functions = new Map(program.functions.map(item => [item.name, item]));
        const same = (value, name, kind = 'temporary') => value?.kind === kind && value.name === name;
        for (const block of fn.blocks) {
            let changed = true;
            while (changed) {
                changed = false;
                const instructions = block.instructions;
                for (let allocationIndex = 0; allocationIndex < instructions.length; allocationIndex++) {
                    const allocation = instructions[allocationIndex];
                    if (allocation.op !== 'allocate' || !allocation.result) continue;
                    const type = types.get(allocation.type ?? allocation.objectType);
                    const constructor = type ? functions.get(type.initializer ?? `${type.name}.__`) : null;
                    if (!type || type.base || !constructor || type.virtualMethods?.length || type.contracts?.some(contract => !contract.isSelf) ||
                        type.fields.some(field => field.ownership !== 'value' || !primitive(field.type))) continue;
                    const constructorInstructions = constructor.blocks.flatMap(item => item.instructions);
                    if (constructor.blocks.length !== 1 || constructorInstructions.some(item => item.op !== 'store_field' && item.op !== 'return')) continue;
                    const fields = new Map();
                    let validConstructor = true;
                    for (const item of constructorInstructions) if (item.op === 'store_field') {
                        const parameterIndex = constructor.parameters.findIndex(parameter => parameter.name === item.value?.name);
                        if (!same(item.object, constructor.parameters[0]?.name, 'parameter') || item.value?.kind !== 'parameter' || parameterIndex < 1) validConstructor = false;
                        else fields.set(item.field, parameterIndex);
                    }
                    if (!validConstructor || fields.size !== type.fields.length) continue;

                    const remove = new Set([allocationIndex]);
                    const objectTemporaries = new Set([allocation.result]);
                    const objectLocals = new Set();
                    const aliases = new Map();
                    let call = null;
                    let escaped = false;
                    for (let index = 0; index < instructions.length && !escaped; index++) {
                        if (index === allocationIndex) continue;
                        const item = instructions[index];
                        if (item.op === 'call' && item.target === constructor.name && same(item.arguments?.[0], allocation.result)) {
                            if (call) escaped = true;
                            else { call = item; remove.add(index); }
                            continue;
                        }
                        if (item.op === 'declare_local' && same(item.value, allocation.result)) { objectLocals.add(item.name); remove.add(index); continue; }
                        if (item.op === 'load_local' && objectLocals.has(item.name)) { objectTemporaries.add(item.result); remove.add(index); continue; }
                        if (item.op === 'load_field' && objectTemporaries.has(item.object?.name) && fields.has(item.field)) {
                            aliases.set(item.result, fields.get(item.field)); remove.add(index); continue;
                        }
                        if (item.op === 'destroy_object' && (item.value?.kind === 'local' && objectLocals.has(item.value.name) ||
                            item.value?.kind === 'temporary' && objectTemporaries.has(item.value.name))) { remove.add(index); continue; }
                        const usesObject = new IrValidator().values(item).some(value =>
                            value.kind === 'temporary' && objectTemporaries.has(value.name) || value.kind === 'local' && objectLocals.has(value.name));
                        if (usesObject || (['store_local', 'load_local'].includes(item.op) && objectLocals.has(item.name))) escaped = true;
                    }
                    for (const otherBlock of fn.blocks) if (otherBlock !== block) for (const item of otherBlock.instructions) {
                        const usesObject = new IrValidator().values(item).some(value =>
                            value.kind === 'temporary' && objectTemporaries.has(value.name) || value.kind === 'local' && objectLocals.has(value.name));
                        if (usesObject || (['store_local', 'load_local'].includes(item.op) && objectLocals.has(item.name))) escaped = true;
                    }
                    if (escaped || !call || aliases.size === 0) continue;
                    const replacements = new Map([...aliases].map(([result, parameterIndex]) => [result, call.arguments[parameterIndex]]));
                    const replace = value => {
                        if (!value || typeof value !== 'object') return value;
                        if (value.kind === 'temporary' && replacements.has(value.name)) return replacements.get(value.name);
                        if (value.kind) return value;
                        if (Array.isArray(value)) return value.map(replace);
                        for (const [key, child] of Object.entries(value)) if (key !== 'result') value[key] = replace(child);
                        return value;
                    };
                    for (const item of instructions) for (const [key, value] of Object.entries(item)) if (key !== 'result') item[key] = replace(value);
                    block.instructions = instructions.filter((_, index) => !remove.has(index));
                    changed = true;
                    break;
                }
            }
        }
    }

    propagateLocalValues(fn) {
        const useBlocks = new Map();
        for (const block of fn.blocks) for (const item of block.instructions) {
            for (const value of new IrValidator().values(item)) if (value.kind === 'temporary') {
                const locations = useBlocks.get(value.name) ?? new Set();
                locations.add(block);
                useBlocks.set(value.name, locations);
            }
        }
        for (const block of fn.blocks) {
            const locals = new Map();
            const aliases = new Map();
            const resolve = value => {
                const visited = new Set();
                while (value?.kind === 'temporary' && aliases.has(value.name) && !visited.has(value.name)) {
                    visited.add(value.name);
                    value = aliases.get(value.name);
                }
                return value;
            };
            const retained = [];
            for (const instruction of block.instructions) {
                const replace = value => {
                    if (!value || typeof value !== 'object') return value;
                    if (value.kind) return resolve(value);
                    if (Array.isArray(value)) return value.map(replace);
                    for (const [key, item] of Object.entries(value)) if (key !== 'result') value[key] = replace(item);
                    return value;
                };
                for (const [key, value] of Object.entries(instruction)) if (key !== 'result') instruction[key] = replace(value);
                const localUses = instruction.result ? useBlocks.get(instruction.result) : null;
                if (instruction.op === 'load_local' && instruction.result && localUses?.size === 1 && localUses.has(block) && locals.has(instruction.name) && integerTypes.has(instruction.type)) {
                    aliases.set(instruction.result, locals.get(instruction.name));
                    continue;
                }
                if (instruction.op === 'declare_local' || instruction.op === 'store_local') {
                    if (instruction.value && integerTypes.has(instruction.value.type)) locals.set(instruction.name, instruction.value);
                    else locals.delete(instruction.name);
                }
                retained.push(instruction);
            }
            block.instructions = retained;
        }
    }

    simplifyControlFlow(fn) {
        const byLabel = new Map(fn.blocks.map(block => [block.label, block]));
        const resolve = start => {
            let label = start;
            const visited = new Set();
            while (!visited.has(label)) {
                visited.add(label);
                const block = byLabel.get(label);
                if (block?.instructions.length !== 1 || block.instructions[0].op !== 'jump') break;
                label = block.instructions[0].target;
            }
            return label;
        };
        for (const block of fn.blocks) {
            const end = block.instructions.at(-1);
            if (end?.op === 'jump') end.target = resolve(end.target);
            if (end?.op === 'branch') {
                end.thenTarget = resolve(end.thenTarget);
                end.elseTarget = resolve(end.elseTarget);
                if (end.thenTarget === end.elseTarget) block.instructions[block.instructions.length - 1] = {op: 'jump', target: end.thenTarget};
            }
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
    validate(program, {requireEntry = true} = {}) {
        const errors = [];
        const types = this.unique(program.types, 'type', errors);
        const functions = this.unique([...program.functions, ...program.externals], 'function', errors);
        const entry = functions.get(program.entry);
        if (requireEntry && (!program.entry || !entry || !program.functions.includes(entry))) errors.push(`entry '${program.entry ?? '<missing>'}' is not a defined function`);

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

export function prepareIr(program, {optimize = true, requireEntry = true, scalarReplacement = true} = {}) {
    new IrCanonicalizer().run(program, {optimize, scalarReplacement});
    return new IrValidator().validate(program, {requireEntry});
}
