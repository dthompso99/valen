import {Token} from './token.js';
import {Tokens} from './tokens.js';

const keywords = new Map();
const symbols = new Map();

for (const token of Tokens) {
    if (/^[A-Za-z_]\w*$/.test(token.value)) {
        keywords.set(token.value, token.type);
    } else {
        const matches = symbols.get(token.value[0]);
        if (matches) matches.push(token);
        else symbols.set(token.value[0], [token]);
    }
}
for (const matches of symbols.values()) matches.sort((a, b) => b.value.length - a.value.length);

export class Tokenizer {
    constructor(source, sourceName = '<source>') {
        this.source = source;
        this.sourceName = sourceName;
    }

    parse() {
        const tokens = [];
        let offset = 0;
        let line = 1;
        let column = 1;

        const advance = () => {
            const character = this.source[offset++];
            if (character === '\n') {
                line++;
                column = 1;
            } else column++;
            return character;
        };

        const add = (type, value, start, tokenLine, tokenColumn) => {
            tokens.push(new Token(type, value, this.sourceName, start, offset, tokenLine, tokenColumn));
        };

        while (offset < this.source.length) {
            const character = this.source[offset];

            if (character === '\n') {
                const start = offset;
                const tokenLine = line;
                const tokenColumn = column;
                advance();
                add('NEWLINE', '\n', start, tokenLine, tokenColumn);
                continue;
            }

            if (/\s/.test(character)) {
                advance();
                continue;
            }

            if (character === '/' && this.source[offset + 1] === '/') {
                while (offset < this.source.length && this.source[offset] !== '\n') advance();
                continue;
            }

            const start = offset;
            const tokenLine = line;
            const tokenColumn = column;

            if (character === '"' || character === "'") {
                const quote = character;
                advance();
                while (offset < this.source.length && this.source[offset] !== quote) {
                    if (this.source[offset] === '\\') advance();
                    else if (quote === '"' && this.source[offset] === '$' && this.source[offset + 1] === '{') {
                        advance();
                        advance();
                        let depth = 1;
                        let nestedQuote = null;
                        while (offset < this.source.length && depth > 0) {
                            const nested = this.source[offset];
                            if (nestedQuote !== null) {
                                if (nested === '\\') advance();
                                else if (nested === nestedQuote) nestedQuote = null;
                            } else if (nested === '"' || nested === "'") nestedQuote = nested;
                            else if (nested === '{') depth++;
                            else if (nested === '}') depth--;
                            if (offset < this.source.length) advance();
                        }
                        if (depth > 0) this.fail('Unclosed interpolation expression', tokenLine, tokenColumn);
                        continue;
                    }
                    if (offset < this.source.length) advance();
                }
                if (offset >= this.source.length) this.fail('Unclosed string', tokenLine, tokenColumn);
                advance();
                add('STRING_LITERAL', this.source.slice(start, offset), start, tokenLine, tokenColumn);
                continue;
            }

            if (/[A-Za-z_]/.test(character)) {
                advance();
                while (offset < this.source.length && /\w/.test(this.source[offset])) advance();
                const value = this.source.slice(start, offset);
                add(keywords.get(value) ?? 'IDENTIFIER', value, start, tokenLine, tokenColumn);
                continue;
            }

            if (/\d/.test(character)) {
                advance();
                while (offset < this.source.length && /\d/.test(this.source[offset])) advance();
                let kind = 'INTEGER_LITERAL';
                if (this.source[offset] === '.' && /\d/.test(this.source[offset + 1] ?? '')) {
                    kind = 'FLOAT_LITERAL';
                    advance();
                    while (offset < this.source.length && /\d/.test(this.source[offset])) advance();
                }
                if ((this.source[offset] === 'e' || this.source[offset] === 'E') &&
                    (/\d/.test(this.source[offset + 1] ?? '') ||
                     ((this.source[offset + 1] === '+' || this.source[offset + 1] === '-') && /\d/.test(this.source[offset + 2] ?? '')))) {
                    kind = 'FLOAT_LITERAL';
                    advance();
                    if (this.source[offset] === '+' || this.source[offset] === '-') advance();
                    while (offset < this.source.length && /\d/.test(this.source[offset])) advance();
                }
                add(kind, this.source.slice(start, offset), start, tokenLine, tokenColumn);
                continue;
            }

            const known = symbols.get(character)?.find(token => this.source.startsWith(token.value, offset));
            if (!known) this.fail(`Unexpected character ${JSON.stringify(character)}`, line, column);
            for (let i = 0; i < known.value.length; i++) advance();
            add(known.type, known.value, start, tokenLine, tokenColumn);
        }

        tokens.push(new Token('EOF', '', this.sourceName, offset, offset, line, column));
        return tokens;
    }

    fail(message, line, column) {
        throw new SyntaxError(`${this.sourceName}:${line}:${column}: ${message}`);
    }
}
