const word = /^[A-Za-z0-9_]/;
const operators = new Set(['===', '!==', '==', '!=', '<=', '>=', '<<', '>>', '&&', '||', '&', '|', '^', '+', '-', '*', '/', '=', '<', '>', '->']);
const noSpaceBefore = new Set([')', ']', ',', '.', ':', ';', '?']);
const noSpaceAfter = new Set(['(', '[', '.', '?']);
const conditionKeywords = new Set(['if', 'while', 'for', 'match']);

function scan(source) {
    const tokens = [];
    let offset = 0;
    const add = (value, kind = 'token') => tokens.push({value, kind});
    while (offset < source.length) {
        const character = source[offset];
        if (character === '\r' && source[offset + 1] === '\n') { add('\n', 'newline'); offset += 2; continue; }
        if (character === '\n' || character === '\r') { add('\n', 'newline'); offset++; continue; }
        if (/\s/.test(character)) { offset++; continue; }
        if (character === '/' && source[offset + 1] === '/') {
            const start = offset;
            while (offset < source.length && source[offset] !== '\n' && source[offset] !== '\r') offset++;
            add(source.slice(start, offset).trimEnd(), 'comment');
            continue;
        }
        if (character === '"' || character === "'") {
            const start = offset, quote = character;
            offset++;
            while (offset < source.length) {
                if (source[offset] === '\\') offset += Math.min(2, source.length - offset);
                else if (source[offset++] === quote) break;
            }
            add(source.slice(start, offset), 'string');
            continue;
        }
        if (/[A-Za-z_]/.test(character)) {
            const start = offset++;
            while (offset < source.length && /[A-Za-z0-9_]/.test(source[offset])) offset++;
            add(source.slice(start, offset), 'word');
            continue;
        }
        if (/\d/.test(character)) {
            const start = offset++;
            while (offset < source.length && /[A-Za-z0-9_.]/.test(source[offset])) offset++;
            add(source.slice(start, offset), 'word');
            continue;
        }
        const three = source.slice(offset, offset + 3), two = source.slice(offset, offset + 2);
        if (three === '===' || three === '!==') { add(three); offset += 3; continue; }
        if (['->', '==', '!=', '<=', '>=', '<<', '>>', '&&', '||'].includes(two)) { add(two); offset += 2; continue; }
        if (two === '{{' || two === '}}') { add(two, 'brace'); offset += 2; continue; }
        add(character, character === '{' || character === '}' ? 'brace' : 'token');
        offset++;
    }
    return tokens;
}

function needsSpace(previous, current) {
    if (!previous) return false;
    if (current.kind === 'comment') return true;
    if (noSpaceBefore.has(current.value) || noSpaceAfter.has(previous.value)) return false;
    if (previous.value === ',' || previous.value === ';') return true;
    if (current.value === '(') return conditionKeywords.has(previous.value);
    if (current.value === '{' || current.value === '{{') return previous.value !== '{' && previous.value !== '{{';
    if (current.value === '}' || current.value === '}}') return previous.value !== '{' && previous.value !== '{{';
    if (previous.value === '{' || previous.value === '{{') return current.value !== '}' && current.value !== '}}';
    if (previous.value === '}' || previous.value === '}}') return true;
    if (operators.has(previous.value) || operators.has(current.value)) {
        if ((current.value === '!' || current.value === '-' || current.value === '+') &&
            (!previous || operators.has(previous.value) || ['(', '[', ',', ':'].includes(previous.value))) return false;
        if (previous.value === '!') return false;
        return true;
    }
    return word.test(previous.value.at(-1) ?? '') && word.test(current.value[0] ?? '');
}

export function formatValen(source, {indent = '    '} = {}) {
    const lines = [[]];
    for (const token of scan(source)) {
        if (token.kind === 'newline') lines.push([]);
        else lines.at(-1).push(token);
    }

    const output = [];
    let depth = 0, blank = false;
    for (const line of lines) {
        if (line.length === 0) {
            if (output.length && !blank) output.push('');
            blank = true;
            continue;
        }
        blank = false;
        const first = line[0].value;
        const lineDepth = Math.max(0, depth - (first === '}' || first === '}}' ? 1 : 0));
        let rendered = '', previous = null;
        for (const token of line) {
            if (needsSpace(previous, token)) rendered += ' ';
            rendered += token.value;
            previous = token;
            if (token.kind === 'comment') break;
        }
        output.push(indent.repeat(lineDepth) + rendered.trimEnd());
        for (const token of line) {
            if (token.kind !== 'brace') continue;
            if (token.value === '{' || token.value === '{{') depth++;
            else depth = Math.max(0, depth - 1);
        }
    }
    while (output.at(-1) === '') output.pop();
    return `${output.join('\n')}\n`;
}
