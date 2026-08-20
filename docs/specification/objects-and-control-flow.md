# Objects, contracts, dispatch, and control flow

This section is normative for object construction, nominal relationships, dispatch, casts, expression evaluation, and structured control flow.

## Objects and construction

**OBJ-001 — Nominal objects.** Each object declaration introduces a distinct nominal type. Structural similarity alone does not make two object types assignable.

**OBJ-002 — Allocation and initialization.** `new T(arguments)` allocates a `T`, initializes every field to its type's default value, and then invokes the selected `__` constructor. Constructor overload selection uses the declared parameter signature and trailing defaults.

**OBJ-003 — Inherited layout.** An object with `inherits Parent` contains its parent's fields before its own fields and is a subtype of `Parent`. Inheritance cycles must be rejected.

**OBJ-004 — Parent construction.** `super(arguments)` in a constructor invokes the selected parent constructor on the same object. `super.member(arguments)` invokes the named parent implementation without virtual redispatch.

## Methods, inheritance, and contracts

**OBJ-010 — Method identity.** Methods are distinguished by owner, name, and parameter signature. A call must select exactly one compatible overload after applying required argument typing and trailing defaults.

**OBJ-011 — Virtual override.** A non-private child method with a compatible parent signature overrides that parent slot. A call through a parent-typed reference must dispatch to the concrete object's override.

**OBJ-012 — Private members.** A private field or method is accessible only from its declaring object. Private methods do not occupy or override virtual dispatch slots.

**OBJ-013 — Contract satisfaction.** For every object named by `implements`, the implementing object must provide each required method with a compatible parameter, return, and ownership signature. Missing or incompatible requirements are compile-time errors.

**OBJ-014 — Contract dispatch.** A contract-typed reference preserves the concrete object's identity. Calls through it dispatch through the concrete implementation and preserve register, stack, return, and ownership behavior.

**OBJ-015 — Runtime type tests and casts.** Runtime type tests walk the concrete object's parent and contract relationships. A checked reference cast succeeds only when that relationship exists; failure produces the language's documented absent result rather than fabricating a reference.

## Evaluation and statements

**EVAL-001 — Statement order.** Statements in a block execute in source order until control transfers through `return`, `break`, or `continue`.

**EVAL-002 — Expression order.** Ordinary unary and binary operands evaluate in source order. A call evaluates its arguments from left to right and then evaluates an explicit member receiver before entering the callee. Object allocation and field-default initialization occur before constructor arguments are evaluated.

**EVAL-003 — Short circuit.** `left && right` evaluates `right` only when `left` is true. `left || right` evaluates `right` only when `left` is false.

**EVAL-004 — Assignment.** An assignment evaluates its source value first, then evaluates the destination object and index if present, and finally stores the value subject to type and ownership rules. Each component evaluates once.

**EVAL-010 — Conditional statements.** An `if` condition must be `bool`; exactly the first true branch executes, and an `else` binds to the nearest unmatched `if`. Each branch has its own lexical scope.

**EVAL-011 — Conditional expressions.** An expression-valued conditional requires an `else`, every branch must end in a value, and all branch values must have a common assignable type. Exactly one branch evaluates and its value transfers into the result.

**EVAL-012 — While loops.** A `while` condition is evaluated before each iteration. `continue` begins the next condition evaluation and `break` exits the nearest loop.

**EVAL-013 — For iteration.** `for value in collection` visits array elements in increasing index order and strings in increasing UTF-8 byte order. The iteration binding is local to the loop body.

**EVAL-014 — Return.** `return` evaluates its value once, applies the method's type and ownership boundary, and exits the current method. A reachable path in a non-`void` method must return a value.

**EVAL-015 — Runtime failures.** A documented bounds, conversion, arithmetic, or target-runtime failure terminates through the specified Valen status path. A backend must not continue with undefined host behavior.

**EVAL-020 — Equality operators.** `===` and `!==` compare managed-reference identity. `==` and `!=` compare primitive or enum values directly and managed objects and arrays structurally. Structural equality and hashing must terminate on cyclic graphs and observe the same fields and element order.

**EVAL-021 — Result propagation.** The result-propagation operator is valid only for a value implementing the required result protocol and within a method returning a compatible result type. It unwraps a valid result and immediately returns an invalid result without evaluating later statements.

**EVAL-022 — Test declarations.** A `test` declaration contains named test methods executed in deterministic source order by the native test runner. `expect condition` is valid only inside a test declaration; a false expectation increments the failure count and produces a nonzero final test status.
