# Lexical structure and source files

This section is normative for the current source-language epoch.

## Source units

**LEX-001 — Source encoding.** A Valen source unit must be UTF-8 text. An implementation must preserve byte-accurate source offsets and one-based line and column positions for diagnostics.

**LEX-002 — File convention.** Importable source files must use the `.ar` suffix. The suffix is part of the import spelling and must not be inferred.

## Whitespace, comments, and separators

**LEX-010 — Horizontal whitespace.** Outside literals, spaces, tabs, carriage returns, and other non-newline whitespace separate tokens but have no semantic value.

**LEX-011 — Line comments.** `//` begins a comment outside a literal. The comment continues to, but does not consume, the next newline or the end of the source unit.

**LEX-012 — Statement termination.** A newline or `;` terminates a declaration or statement where the grammar requires a separator. Multiple separators are permitted. A newline is not a universal terminator inside a syntactically incomplete construct; productions explicitly accepting newlines control those positions.

**LEX-013 — End of input.** End of input may terminate the final construct only where that construct is otherwise complete. It must not repair an unclosed delimiter or literal.

## Identifiers and tokens

**LEX-020 — Identifiers.** An identifier begins with an ASCII letter or `_` and continues with ASCII letters, decimal digits, or `_`. A spelling reserved as a keyword is tokenized as that keyword rather than an identifier.

**LEX-021 — Longest symbol.** When multiple symbolic tokens share a prefix, tokenization must select the longest token beginning at the current offset.

**LEX-022 — Numeric tokens.** Decimal integer literals contain one or more decimal digits. A floating literal contains a decimal fraction, an exponent, or both. A decimal point begins a fraction only when followed by a decimal digit. An exponent marker must be followed by decimal digits, optionally after `+` or `-`.

## String literals and interpolation

**LEX-030 — Delimiters.** String literals may use matching single or double quotes. A backslash escapes the following byte from delimiter recognition. An unclosed literal is invalid.

**LEX-031 — Interpolation recognition.** `${` begins interpolation only inside a double-quoted literal. The matching `}` is selected by balanced brace depth while respecting nested single- and double-quoted literals and backslash escapes.

**LEX-032 — Interpolation validity.** An interpolation expression must be non-empty, syntactically complete, and consume its entire interpolation body. An unclosed interpolation is invalid.

## Diagnostics

**LEX-040 — Lexical rejection.** An unrecognized source byte, unclosed literal, or unclosed interpolation must be rejected with a diagnostic anchored at the offending byte or opening literal. A compiler must not continue by inventing a token.
