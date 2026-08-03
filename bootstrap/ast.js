export class AstNode {
    constructor(kind, span) {
        this.kind = kind;
        this.span = span;
    }
}

export class ProgramNode extends AstNode {
    constructor(imports, objects, libraries, span) {
        super('Program', span);
        this.imports = imports;
        this.objects = objects;
        this.libraries = libraries;
    }
}

export class LibraryDeclaration extends AstNode {
    constructor(name, members, span) {
        super('LibraryDeclaration', span);
        this.name = name;
        this.members = members;
        this.visibility = 'public';
    }
}

export class ImportDeclaration extends AstNode {
    constructor(name, path, span) {
        super('ImportDeclaration', span);
        this.name = name;
        this.path = path;
    }
}

export class ObjectDeclaration extends AstNode {
    constructor(name, inheritedType, implementedTypes, members, span) {
        super('ObjectDeclaration', span);
        this.name = name;
        this.inheritedType = inheritedType;
        this.implementedTypes = implementedTypes;
        this.members = members;
        this.visibility = 'public';
    }
}

export class MethodDeclaration extends AstNode {
    constructor(name, parameters, returnType, body, isNative, span) {
        super('MethodDeclaration', span);
        this.name = name;
        this.parameters = parameters;
        this.returnType = returnType;
        this.body = body;
        this.isNative = isNative;
        this.isUnsafe = false;
        this.visibility = 'public';
        this.returnReference = false;
    }
}

export class FieldDeclaration extends AstNode {
    constructor(name, fieldType, initializer, span) {
        super('FieldDeclaration', span);
        this.name = name;
        this.fieldType = fieldType;
        this.initializer = initializer;
        this.visibility = 'public';
        this.reference = false;
        this.weakReference = false;
    }
}

export class ParameterDeclaration extends AstNode {
    constructor(name, parameterType, defaultValue, span, owning = false) {
        super('ParameterDeclaration', span);
        this.name = name;
        this.parameterType = parameterType;
        this.defaultValue = defaultValue;
        this.owning = owning;
    }
}

export class TypeReference extends AstNode {
    constructor(name, typeArguments, optional, span, ownership = 'owned') {
        super('TypeReference', span);
        this.name = name;
        this.typeArguments = typeArguments;
        this.optional = optional;
        this.ownership = ownership;
    }
}

export class BlockStatement extends AstNode {
    constructor(statements, span) {
        super('BlockStatement', span);
        this.statements = statements;
    }
}

export class UnsafeStatement extends AstNode {
    constructor(body, span) {
        super('UnsafeStatement', span);
        this.body = body;
    }
}

export class ReturnStatement extends AstNode {
    constructor(expression, span) {
        super('ReturnStatement', span);
        this.expression = expression;
    }
}

export class ExpressionStatement extends AstNode {
    constructor(expression, span) {
        super('ExpressionStatement', span);
        this.expression = expression;
    }
}

export class LocalDeclaration extends AstNode {
    constructor(name, variableType, initializer, span) {
        super('LocalDeclaration', span);
        this.name = name;
        this.variableType = variableType;
        this.initializer = initializer;
    }
}

export class IfStatement extends AstNode {
    constructor(condition, consequent, alternate, span) {
        super('IfStatement', span);
        this.condition = condition;
        this.consequent = consequent;
        this.alternate = alternate;
    }
}

export class WhileStatement extends AstNode {
    constructor(condition, body, span) {
        super('WhileStatement', span);
        this.condition = condition;
        this.body = body;
    }
}

export class BreakStatement extends AstNode {
    constructor(span) {
        super('BreakStatement', span);
    }
}

export class ContinueStatement extends AstNode {
    constructor(span) {
        super('ContinueStatement', span);
    }
}

export class IdentifierExpression extends AstNode {
    constructor(name, span) {
        super('IdentifierExpression', span);
        this.name = name;
    }
}

export class IntegerLiteral extends AstNode {
    constructor(value, lexeme, span) {
        super('IntegerLiteral', span);
        this.value = value;
        this.lexeme = lexeme;
    }
}

export class BooleanLiteral extends AstNode {
    constructor(value, span) {
        super('BooleanLiteral', span);
        this.value = value;
    }
}

export class NullLiteral extends AstNode {
    constructor(span) {
        super('NullLiteral', span);
    }
}

export class UnwrapExpression extends AstNode {
    constructor(expression, span) {
        super('UnwrapExpression', span);
        this.expression = expression;
    }
}

export class PropagateExpression extends AstNode {
    constructor(expression, span) {
        super('PropagateExpression', span);
        this.expression = expression;
    }
}

export class StringLiteral extends AstNode {
    constructor(value, lexeme, span) {
        super('StringLiteral', span);
        this.value = value;
        this.lexeme = lexeme;
    }
}

export class UnaryExpression extends AstNode {
    constructor(operator, operand, span) {
        super('UnaryExpression', span);
        this.operator = operator;
        this.operand = operand;
    }
}

export class BinaryExpression extends AstNode {
    constructor(left, operator, right, span) {
        super('BinaryExpression', span);
        this.left = left;
        this.operator = operator;
        this.right = right;
    }
}

export class AssignmentExpression extends AstNode {
    constructor(target, value, span) {
        super('AssignmentExpression', span);
        this.target = target;
        this.value = value;
    }
}

export class IndexExpression extends AstNode {
    constructor(object, index, span) {
        super('IndexExpression', span);
        this.object = object;
        this.index = index;
    }
}

export class ConversionExpression extends AstNode {
    constructor(expression, targetType, span) {
        super('ConversionExpression', span);
        this.expression = expression;
        this.targetType = targetType;
    }
}

export class CallExpression extends AstNode {
    constructor(callee, args, span) {
        super('CallExpression', span);
        this.callee = callee;
        this.arguments = args;
    }
}

export class MemberExpression extends AstNode {
    constructor(object, member, span) {
        super('MemberExpression', span);
        this.object = object;
        this.member = member;
    }
}

export class NewExpression extends AstNode {
    constructor(callee, typeArguments, args, span) {
        super('NewExpression', span);
        this.callee = callee;
        this.typeArguments = typeArguments;
        this.arguments = args;
    }
}
