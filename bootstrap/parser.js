import fs from 'fs';
import {fileURLToPath} from 'url';
import {Tokenizer} from './tokenizer.js';
import {
    ProgramNode,
    ImportDeclaration,
    LibraryDeclaration,
    ObjectDeclaration,
    FieldDeclaration,
    MethodDeclaration,
    ParameterDeclaration,
    TypeReference,
    BlockStatement,
    ReturnStatement,
    ExpressionStatement,
    LocalDeclaration,
    IfStatement,
    WhileStatement,
    BreakStatement,
    ContinueStatement,
    IdentifierExpression,
    IntegerLiteral,
    BooleanLiteral,
    NullLiteral,
    UnwrapExpression,
    PropagateExpression,
    StringLiteral,
    UnaryExpression,
    BinaryExpression,
    AssignmentExpression,
    IndexExpression,
    ConversionExpression,
    CallExpression,
    MemberExpression,
    NewExpression
} from './ast.js';

export class Parser {
    parse(source, sourceName = '<source>') {
        this.tokens = new Tokenizer(source, sourceName).parse();
        this.current = 0;

        const imports = [];
        const objects = [];
        const libraries = [];
        this.skipSeparators();
        while (!this.check('EOF')) {
            if (this.check('IMPORT')) imports.push(this.parseImport());
            else if (this.check('LIBRARY')) libraries.push(this.parseLibrary());
            else objects.push(this.parseObject());
            this.skipSeparators();
        }
        return new ProgramNode(imports, objects, libraries, this.span(this.tokens[0], this.peek()));
    }

    parseFile(filePath) {
        return this.parse(fs.readFileSync(filePath, 'utf8'), filePath);
    }

    parseImport() {
        const start = this.consume('IMPORT', "Expected 'import'");
        const name = this.consume('IDENTIFIER', 'Expected a library name');
        this.consume('FROM', `Expected 'from' after imported name ${name.value}`);
        const path = this.consume('STRING_LITERAL', `Expected a path for imported library ${name.value}`);
        if (!this.atSeparator() && !this.check('EOF')) {
            this.error(this.peek(), `Expected a newline or ';' after import ${name.value}`);
        }
        return new ImportDeclaration(name.value, this.decodeString(path), this.span(start, path));
    }

    parseLibrary() {
        const start = this.consume('LIBRARY', "Expected 'library'");
        const name = this.consume('IDENTIFIER', 'Expected a library name');
        this.consume('LEFT_BRACE', `Expected '{{' after library name ${name.value}`);
        this.consume('LEFT_BRACE', `Expected '{{' after library name ${name.value}`);
        const members = [];

        this.skipSeparators();
        while (!(this.check('RIGHT_BRACE') && this.peek(1).type === 'RIGHT_BRACE') && !this.check('EOF')) {
            if (
                this.check('IDENTIFIER') &&
                this.peek(1).type === 'LEFT_BRACE' &&
                this.peek(2).type === 'LEFT_BRACE'
            ) {
                members.push(this.parseObject());
            } else if (this.check('MEMBER')) {
                this.error(this.peek(), 'Libraries cannot declare instance members');
            } else if (this.check('NATIVE')) {
                members.push(this.parseMethod(true));
            } else {
                members.push(this.parseMethod());
            }
            this.skipSeparators();
        }

        this.consume('RIGHT_BRACE', `Expected '}}' after library ${name.value}`);
        const end = this.consume('RIGHT_BRACE', `Expected '}}' after library ${name.value}`);
        return new LibraryDeclaration(name.value, members, this.span(start, end));
    }

    parseObject() {
        const start = this.consume('IDENTIFIER', 'Expected an object name');
        this.consume('LEFT_BRACE', `Expected '{{' after object name ${start.value}`);
        this.consume('LEFT_BRACE', `Expected '{{' after object name ${start.value}`);
        const members = [];

        this.skipSeparators();
        while (!(this.check('RIGHT_BRACE') && this.peek(1).type === 'RIGHT_BRACE') && !this.check('EOF')) {
            if (
                this.check('IDENTIFIER') &&
                this.peek(1).type === 'LEFT_BRACE' &&
                this.peek(2).type === 'LEFT_BRACE'
            ) {
                members.push(this.parseObject());
            } else if (this.check('MEMBER')) {
                members.push(this.parseField());
            } else if (this.check('NATIVE')) {
                this.error(this.peek(), 'Native methods can only be declared in libraries');
            } else {
                members.push(this.parseMethod());
            }
            this.skipSeparators();
        }

        this.consume('RIGHT_BRACE', `Expected '}}' after object ${start.value}`);
        const end = this.consume('RIGHT_BRACE', `Expected '}}' after object ${start.value}`);
        return new ObjectDeclaration(start.value, members, this.span(start, end));
    }

    parseField() {
        const start = this.consume('MEMBER', "Expected 'member'");
        const name = this.consume('IDENTIFIER', 'Expected a field name');
        this.consume('COLON', `Expected ':' after field name ${name.value}`);
        const fieldType = this.parseTypeReference();
        const initializer = this.match('EQUAL') ? this.parseExpression() : null;

        if (!this.atSeparator() && !(this.check('RIGHT_BRACE') && this.peek(1).type === 'RIGHT_BRACE')) {
            this.error(this.peek(), `Expected a newline or ';' after field ${name.value}`);
        }
        const end = initializer ?? fieldType;
        return new FieldDeclaration(name.value, fieldType, initializer, this.span(start, end));
    }

    parseMethod(isNative = false) {
        const start = isNative
            ? this.consume('NATIVE', "Expected 'native'")
            : this.peek();
        const name = this.consume('IDENTIFIER', 'Expected a method name');
        this.consume('LEFT_PAREN', `Expected '(' after method name ${name.value}`);
        const parameters = [];

        if (!this.check('RIGHT_PAREN')) {
            do {
                const name = this.consume('IDENTIFIER', 'Expected a parameter name');
                this.consume('COLON', `Expected ':' after parameter ${name.value}`);
                const parameterType = this.parseTypeReference();
                parameters.push(new ParameterDeclaration(name.value, parameterType, this.span(name, parameterType)));
            } while (this.match('COMMA'));
        }

        this.consume('RIGHT_PAREN', 'Expected closing parenthesis after parameters');
        this.consume('ARROW', `Expected '->' after parameters for ${name.value}`);
        const returnType = this.parseTypeReference();
        if (isNative) {
            if (!this.atSeparator() && !(this.check('RIGHT_BRACE') && this.peek(1).type === 'RIGHT_BRACE')) {
                this.error(this.peek(), `Native method '${name.value}' cannot have a body`);
            }
            return new MethodDeclaration(name.value, parameters, returnType, null, true, this.span(start, returnType));
        }
        const body = this.parseBlock();
        return new MethodDeclaration(name.value, parameters, returnType, body, false, this.span(start, body));
    }

    parseTypeReference() {
        const name = this.consume('IDENTIFIER', 'Expected a type name');
        let qualifiedName = name.value;
        const typeArguments = [];
        let end = name;
        while (this.match('DOT')) {
            const part = this.consume('IDENTIFIER', "Expected a type name after '.'");
            qualifiedName += `.${part.value}`;
            end = part;
        }
        if (this.match('LESS')) {
            do typeArguments.push(this.parseTypeReference());
            while (this.match('COMMA'));
            end = this.consume('GREATER', "Expected '>' after type arguments");
        }
        const optional = this.match('QUESTION');
        if (optional) end = this.previous();
        return new TypeReference(qualifiedName, typeArguments, optional, this.span(name, end));
    }

    parseBlock() {
        const start = this.consume('LEFT_BRACE', "Expected '{'");
        const statements = [];
        this.skipSeparators();

        while (!this.check('RIGHT_BRACE') && !this.check('EOF')) {
            statements.push(this.parseStatement());
            if (!this.atSeparator() && !this.check('RIGHT_BRACE')) {
                this.error(this.peek(), "Expected a newline, ';', or '}' after statement");
            }
            this.skipSeparators();
        }

        const end = this.consume('RIGHT_BRACE', "Expected '}' after block");
        return new BlockStatement(statements, this.span(start, end));
    }

    parseStatement() {
        if (this.match('RETURN')) {
            const start = this.previous();
            const expression = this.atSeparator() || this.check('RIGHT_BRACE') ? null : this.parseExpression();
            return new ReturnStatement(expression, this.span(start, expression ?? start));
        }
        if (this.match('IF')) return this.parseIf(this.previous());
        if (this.match('WHILE')) return this.parseWhile(this.previous());
        if (this.match('BREAK')) return new BreakStatement(this.span(this.previous(), this.previous()));
        if (this.match('CONTINUE')) return new ContinueStatement(this.span(this.previous(), this.previous()));
        if (this.match('LOCAL')) return this.parseLocal(this.previous());
        if (this.check('LEFT_BRACE')) return this.parseBlock();

        const expression = this.parseExpression();
        return new ExpressionStatement(expression, expression.span);
    }

    parseIf(start) {
        const condition = this.parseExpression();
        const consequent = this.parseBlock();
        let alternate = null;
        const separatorStart = this.current;
        this.skipNewlines();
        if (this.match('ELSE')) alternate = this.parseBlock();
        else this.current = separatorStart;
        return new IfStatement(condition, consequent, alternate, this.span(start, alternate ?? consequent));
    }

    parseWhile(start) {
        const condition = this.parseExpression();
        const body = this.parseBlock();
        return new WhileStatement(condition, body, this.span(start, body));
    }

    parseLocal(start) {
        const name = this.consume('IDENTIFIER', "Expected a local name after 'local'");
        const variableType = this.match('COLON') ? this.parseTypeReference() : null;
        let initializer = null;
        if (this.match('EQUAL')) initializer = this.parseExpression();
        if (!variableType && !initializer) {
            this.error(this.peek(), `Local ${name.value} requires a type or initializer`);
        }
        return new LocalDeclaration(
            name.value,
            variableType,
            initializer,
            this.span(start, initializer ?? variableType)
        );
    }

    parseExpression() {
        return this.parseAssignment();
    }

    parseAssignment() {
        const target = this.parseBinary(1);
        if (!this.match('EQUAL')) return target;

        if (!['IdentifierExpression', 'MemberExpression', 'IndexExpression'].includes(target.kind)) {
            this.error(this.previous(), 'Invalid assignment target');
        }
        const value = this.parseAssignment();
        return new AssignmentExpression(target, value, this.span(target, value));
    }

    parseBinary(minimumPrecedence) {
        let left = this.parseUnary();
        while (true) {
            const precedence = binaryPrecedence[this.peek().type] ?? 0;
            if (precedence < minimumPrecedence) break;
            const operator = this.tokens[this.current++];
            const right = this.parseBinary(precedence + 1);
            left = new BinaryExpression(left, operator.value, right, this.span(left, right));
        }
        return left;
    }

    parseUnary() {
        if (this.match('BANG') || this.match('MINUS')) {
            const operator = this.previous();
            const operand = this.parseUnary();
            return new UnaryExpression(operator.value, operand, this.span(operator, operand));
        }
        if (this.match('NEW')) return this.parseNew(this.previous());
        let expression = this.parsePostfix();
        while (this.match('AS')) {
            const targetType = this.parseTypeReference();
            expression = new ConversionExpression(expression, targetType, this.span(expression, targetType));
        }
        return expression;
    }

    parseNew(start) {
        let callee = this.parsePrimary();
        while (this.match('DOT')) {
            const member = this.consume('IDENTIFIER', "Expected a member name after '.'");
            callee = new MemberExpression(callee, member.value, this.span(callee, member));
        }
        const typeArguments = [];
        if (this.match('LESS')) {
            do typeArguments.push(this.parseTypeReference());
            while (this.match('COMMA'));
            this.consume('GREATER', "Expected '>' after constructed type arguments");
        }
        this.consume('LEFT_PAREN', "Expected '(' after constructed type");
        const {args, end} = this.parseArguments();
        return new NewExpression(callee, typeArguments, args, this.span(start, end));
    }

    parsePostfix() {
        let expression = this.parsePrimary();
        while (true) {
            if (this.match('LEFT_PAREN')) {
                const {args, end} = this.parseArguments();
                expression = new CallExpression(expression, args, this.span(expression, end));
            } else if (this.match('DOT')) {
                const member = this.consume('IDENTIFIER', "Expected a member name after '.'");
                expression = new MemberExpression(expression, member.value, this.span(expression, member));
            } else if (this.match('LEFT_BRACKET')) {
                const index = this.parseExpression();
                const end = this.consume('RIGHT_BRACKET', "Expected ']' after index");
                expression = new IndexExpression(expression, index, this.span(expression, end));
            } else if (this.match('BANG')) {
                expression = new UnwrapExpression(expression, this.span(expression, this.previous()));
            } else if (this.match('QUESTION')) {
                expression = new PropagateExpression(expression, this.span(expression, this.previous()));
            } else break;
        }
        return expression;
    }

    parseArguments() {
        const args = [];
        this.skipNewlines();
        if (!this.check('RIGHT_PAREN')) {
            do {
                this.skipNewlines();
                args.push(this.parseExpression());
                this.skipNewlines();
            } while (this.match('COMMA'));
        }
        return {args, end: this.consume('RIGHT_PAREN', "Expected ')' after arguments")};
    }

    parsePrimary() {
        if (this.match('NULL')) {
            const token = this.previous();
            return new NullLiteral(this.span(token, token));
        }
        if (this.match('TRUE') || this.match('FALSE')) {
            const token = this.previous();
            return new BooleanLiteral(token.type === 'TRUE', this.span(token, token));
        }
        if (this.match('INTEGER_LITERAL')) {
            const token = this.previous();
            return new IntegerLiteral(Number(token.value), token.value, this.span(token, token));
        }
        if (this.match('STRING_LITERAL')) {
            const token = this.previous();
            return new StringLiteral(this.decodeString(token), token.value, this.span(token, token));
        }
        if (this.match('IDENTIFIER')) {
            const token = this.previous();
            return new IdentifierExpression(token.value, this.span(token, token));
        }
        if (this.match('LEFT_PAREN')) {
            const expression = this.parseExpression();
            this.consume('RIGHT_PAREN', "Expected ')' after expression");
            return expression;
        }
        this.error(this.peek(), 'Expected an expression');
    }

    decodeString(token) {
        const quote = token.value[0];
        const body = token.value.slice(1, -1);
        let value = '';
        for (let i = 0; i < body.length; i++) {
            if (body[i] !== '\\') {
                value += body[i];
                continue;
            }
            const escaped = body[++i];
            const escapes = {n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'"};
            if (escaped === undefined) this.error(token, 'Invalid string literal');
            value += escapes[escaped] ?? escaped;
        }
        if (token.value.at(-1) !== quote) this.error(token, 'Invalid string literal');
        return value;
    }

    match(type) {
        if (!this.check(type)) return false;
        this.current++;
        return true;
    }

    consume(type, message) {
        if (this.check(type)) return this.tokens[this.current++];
        this.error(this.peek(), message);
    }

    check(type) {
        return this.peek().type === type;
    }

    atSeparator() {
        return this.check('NEWLINE') || this.check('SEMICOLON');
    }

    skipSeparators() {
        while (this.match('NEWLINE') || this.match('SEMICOLON')) {}
    }

    skipNewlines() {
        while (this.match('NEWLINE')) {}
    }

    peek(distance = 0) {
        return this.tokens[Math.min(this.current + distance, this.tokens.length - 1)];
    }

    previous() {
        return this.tokens[this.current - 1];
    }

    span(start, end) {
        const first = start.span ?? start;
        const last = end.span ?? end;
        return {
            source: first.source,
            start: first.start,
            end: last.end,
            line: first.line,
            column: first.column
        };
    }

    error(token, message) {
        throw new SyntaxError(`${token.source}:${token.line}:${token.column}: ${message}`);
    }
}

const binaryPrecedence = {
    OR: 1,
    AND: 2,
    EQUAL_EQUAL: 3,
    BANG_EQUAL: 3,
    EQUAL_EQUAL_EQUAL: 3,
    BANG_EQUAL_EQUAL: 3,
    LESS: 4,
    LESS_EQUAL: 4,
    GREATER: 4,
    GREATER_EQUAL: 4,
    PLUS: 5,
    MINUS: 5,
    STAR: 6,
    SLASH: 6
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const filePath = process.argv[2];
    if (!filePath) throw new Error('Usage: node parser.js <source-file>');
    console.log(JSON.stringify(new Parser().parseFile(filePath), null, 2));
}
