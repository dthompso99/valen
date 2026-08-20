# Valen core specification

This directory defines normative behavior for the implemented Valen language and its compatibility boundaries. It is deliberately narrower than the language guide: a guide teaches common use, while this specification states the rules a conforming implementation must follow.

Valen does not yet promise stable source or binary compatibility. Rules in this directory are nevertheless authoritative for the current compatibility epochs. Proposed and **WIP** behavior is non-normative until incorporated here.

## Normative language

The words **must**, **must not**, **required**, **shall**, and **shall not** state requirements. **Should** states a recommendation whose exceptions need justification. **May** states permitted behavior. Examples and explanatory notes are non-normative unless a rule explicitly incorporates them.

When project documents disagree, authority descends in this order:

1. A versioned rule in this specification.
2. Compatibility-epoch and target-capability documents referenced by that rule.
3. Conformance fixtures mapped to the rule.
4. User and compiler guides.
5. Project-status and planning text.

An implementation bug does not silently redefine a rule. Either the implementation is corrected or the rule is deliberately revised under the compatibility policy.

## Current sections

- [Lexical structure and source files](lexical-structure.md)
- [Modules, imports, names, and visibility](modules-and-names.md)
- [Compatibility policy](compatibility.md)
- [Conformance map](conformance.md)

The following areas remain **WIP and non-normative here**: the complete type and promotion system; object/contract dispatch; ownership and lifetime boundaries; evaluation order; collections, optionals, enums, matching, and generics; unsafe/FFI behavior; and target capability failures. Existing guides describe their implemented behavior until dedicated normative sections land.

## Rule identifiers

Each requirement has a stable identifier such as `LEX-001`. Text may be clarified without changing an identifier if accepted programs retain the same observable behavior. A semantic change must add or supersede a rule and follow the compatibility policy. Identifiers are never reused for unrelated behavior.
