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
    UnsafeStatement,
    ReturnStatement,
    ExpressionStatement,
    LocalDeclaration,
    IfStatement,
    WhileStatement,
    ForStatement,
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
            else if (this.check('TEST')) libraries.push(this.parseTest());
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
            const visibility = this.parseVisibility();
            if (this.isObjectDeclarationStart()) {
                members.push(this.parseObject(visibility));
            } else if (this.check('MEMBER')) {
                this.error(this.peek(), 'Libraries cannot declare instance members');
            } else if (this.check('NATIVE') || this.check('UNSAFE')) {
                const isUnsafe = this.match('UNSAFE');
                if (isUnsafe && !this.check('NATIVE')) this.error(this.peek(), "Expected 'native' after 'unsafe'");
                const method = this.parseMethod(true, visibility);
                method.isUnsafe = isUnsafe;
                members.push(method);
            } else {
                members.push(this.parseMethod(false, visibility));
            }
            this.skipSeparators();
        }

        this.consume('RIGHT_BRACE', `Expected '}}' after library ${name.value}`);
        const end = this.consume('RIGHT_BRACE', `Expected '}}' after library ${name.value}`);
        return new LibraryDeclaration(name.value, members, this.span(start, end));
    }

    parseTest() {
        const start = this.consume('TEST', "Expected 'test'");
        const name = this.consume('IDENTIFIER', 'Expected a test suite name');
        this.consume('LEFT_BRACE', `Expected '{{' after test suite ${name.value}`);
        this.consume('LEFT_BRACE', `Expected '{{' after test suite ${name.value}`);
        const members = [];
        this.skipSeparators();
        while (!(this.check('RIGHT_BRACE') && this.peek(1).type === 'RIGHT_BRACE') && !this.check('EOF')) {
            members.push(this.parseMethod(false));
            this.skipSeparators();
        }
        this.consume('RIGHT_BRACE', `Expected '}}' after test suite ${name.value}`);
        const end = this.consume('RIGHT_BRACE', `Expected '}}' after test suite ${name.value}`);
        const declaration = new LibraryDeclaration(name.value, members, this.span(start, end));
        declaration.isTest = true;
        return declaration;
    }

    parseObject(visibility = 'public') {
        const start = this.consume('IDENTIFIER', 'Expected an object name');
        const typeParameters = [];
        if (this.match('LESS')) {
            do typeParameters.push(this.consume('IDENTIFIER', 'Expected a type parameter name').value);
            while (this.match('COMMA'));
            this.consume('GREATER', "Expected '>' after type parameters");
        }
        const inheritedType = this.match('INHERITS') ? this.parseTypeReference() : null;
        const implementedTypes = [];
        if (this.match('IMPLEMENTS')) {
            do implementedTypes.push(this.parseTypeReference());
            while (this.match('COMMA'));
        }
        this.consume('LEFT_BRACE', `Expected '{{' after object name ${start.value}`);
        this.consume('LEFT_BRACE', `Expected '{{' after object name ${start.value}`);
        const members = [];

        this.skipSeparators();
        while (!(this.check('RIGHT_BRACE') && this.peek(1).type === 'RIGHT_BRACE') && !this.check('EOF')) {
            const memberVisibility = this.parseVisibility();
            if (this.isObjectDeclarationStart()) {
                members.push(this.parseObject(memberVisibility));
            } else if (this.check('MEMBER')) {
                members.push(this.parseField(memberVisibility));
            } else if (this.check('NATIVE') || this.check('UNSAFE')) {
                this.error(this.peek(), 'Native methods can only be declared in libraries');
            } else {
                members.push(this.parseMethod(false, memberVisibility));
            }
            this.skipSeparators();
        }

        this.consume('RIGHT_BRACE', `Expected '}}' after object ${start.value}`);
        const end = this.consume('RIGHT_BRACE', `Expected '}}' after object ${start.value}`);
        const declaration = new ObjectDeclaration(start.value, typeParameters, inheritedType, implementedTypes, members, this.span(start, end));
        declaration.visibility = visibility;
        return declaration;
    }

    parseVisibility() {
        if (this.match('PRIVATE')) return 'private';
        if (this.match('PUBLIC')) return 'public';
        return 'public';
    }

    isObjectDeclarationStart() {
        if (!this.check('IDENTIFIER')) return false;
        return this.peek(1).type === 'LEFT_BRACE' ||
            this.peek(1).type === 'INHERITS' ||
            this.peek(1).type === 'IMPLEMENTS';
    }

    parseField(visibility = 'public') {
        const start = this.consume('MEMBER', "Expected 'member'");
        const reference = this.match('REF');
        const weak = !reference && this.match('WEAK');
        const name = this.consume('IDENTIFIER', 'Expected a field name');
        this.consume('COLON', `Expected ':' after field name ${name.value}`);
        const fieldType = this.parseTypeReference();
        const initializer = this.match('EQUAL') ? this.parseExpression() : null;

        if (!this.atSeparator() && !(this.check('RIGHT_BRACE') && this.peek(1).type === 'RIGHT_BRACE')) {
            this.error(this.peek(), `Expected a newline or ';' after field ${name.value}`);
        }
        const end = initializer ?? fieldType;
        const field = new FieldDeclaration(name.value, fieldType, initializer, this.span(start, end));
        field.visibility = visibility;
        field.reference = reference;
        field.weakReference = weak;
        return field;
    }

    parseMethod(isNative = false, visibility = 'public') {
        const start = isNative
            ? this.consume('NATIVE', "Expected 'native'")
            : this.peek();
        const name = this.consume('IDENTIFIER', 'Expected a method name');
        this.consume('LEFT_PAREN', `Expected '(' after method name ${name.value}`);
        const parameters = [];

        if (!this.check('RIGHT_PAREN')) {
            do {
                const owning = this.match('OWN');
                const start = owning ? this.previous() : this.peek();
                const name = this.consume('IDENTIFIER', 'Expected a parameter name');
                this.consume('COLON', `Expected ':' after parameter ${name.value}`);
                const parameterType = this.parseTypeReference();
                const defaultValue = this.match('EQUAL') ? this.parseExpression() : null;
                parameters.push(new ParameterDeclaration(name.value, parameterType, defaultValue, this.span(start, defaultValue ?? parameterType), owning));
            } while (this.match('COMMA'));
        }

        this.consume('RIGHT_PAREN', 'Expected closing parenthesis after parameters');
        this.consume('ARROW', `Expected '->' after parameters for ${name.value}`);
        const returnReference = this.match('REF');
        const returnType = this.parseTypeReference();
        if (isNative) {
            if (!this.atSeparator() && !(this.check('RIGHT_BRACE') && this.peek(1).type === 'RIGHT_BRACE')) {
                this.error(this.peek(), `Native method '${name.value}' cannot have a body`);
            }
            const method = new MethodDeclaration(name.value, parameters, returnType, null, true, this.span(start, returnType));
            method.visibility = visibility;
            method.returnReference = returnReference;
            return method;
        }
        const body = this.parseBlock();
        const method = new MethodDeclaration(name.value, parameters, returnType, body, false, this.span(start, body));
        method.visibility = visibility;
        method.returnReference = returnReference;
        return method;
    }

    parseTypeReference() {
        let ownership = 'owned';
        if (this.match('REF')) ownership = 'ref';
        else if (this.match('WEAK')) ownership = 'weak';
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
        return new TypeReference(qualifiedName, typeArguments, optional, this.span(name, end), ownership);
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
        if (this.match('FOR')) return this.parseFor(this.previous());
        if (this.match('BREAK')) return new BreakStatement(this.span(this.previous(), this.previous()));
        if (this.match('CONTINUE')) return new ContinueStatement(this.span(this.previous(), this.previous()));
        if (this.match('LOCAL')) return this.parseLocal(this.previous());
        if (this.match('UNSAFE')) {
            const start = this.previous();
            const body = this.parseBlock();
            return new UnsafeStatement(body, this.span(start, body));
        }
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

    parseFor(start) {
        const name = this.consume('IDENTIFIER', "Expected an iteration variable after 'for'");
        this.consume('IN', `Expected 'in' after iteration variable ${name.value}`);
        const iterable = this.parseExpression();
        const body = this.parseBlock();
        return new ForStatement(name.value, iterable, body, this.span(start, body));
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
        if (this.match('BANG') || this.match('MINUS') || this.match('COPY') || this.match('DELETE')) {
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
    IS: 3,
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
