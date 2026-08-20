# Modules, imports, names, and visibility

This section is normative for source module resolution and the implemented visibility model.

## Module identity and roots

**MOD-001 — Canonical identity.** A loaded source module is identified by its canonical path within one owning root. Reaching the same canonical path through different import spellings must not create distinct modules.

**MOD-002 — Owning root.** Every source module belongs to exactly one project source root, library-path entry, or compiler sysroot source root. Relative resolution must remain confined to that owning root.

**MOD-003 — Cycles.** A dependency cycle in the module graph is invalid and must be diagnosed before semantic analysis.

## Import categories

**MOD-010 — Explicit category.** Import spelling selects exactly one resolution category. Implementations must not fall back between categories when resolution fails.

**MOD-011 — Importer-relative imports.** Spellings beginning with `./` or `../` resolve relative to the importing file. The resolved canonical path must remain inside the importer’s owning root.

**MOD-012 — Project-root imports.** A spelling beginning with `/` resolves relative to the configured project source root. The leading slash does not name the host filesystem root.

**MOD-013 — Library imports.** Other spellings resolve against configured library roots in declared order and then applicable sysroot rules. Library spellings must not contain a `..` path segment.

**MOD-014 — Complete spelling.** An import must include its `.ar` suffix and bind the imported module to an explicit local library name.

**MOD-015 — Failed resolution.** A failed import must report the selected category and searched roots. It must not resolve a same-named file from another category.

## Declarations and visibility

**NAM-001 — Scope binding.** A declaration binds its name in the scope defined by its grammar production. Duplicate declarations in the same namespace and scope are invalid unless the production explicitly defines overload resolution.

**NAM-002 — Shadowing.** A nested local scope may shadow a name from an outer scope. Resolution selects the nearest compatible binding.

**NAM-003 — Default visibility.** Object fields and methods are public unless declared `private`.

**NAM-004 — Private members.** A private member is accessible only from its declaring object. Private methods do not participate in virtual dispatch or satisfy a public contract requirement.

**NAM-005 — Library exports.** Private declarations are excluded from a module’s public interface artifact. A compiled library source must declare exactly one public `library` container.
