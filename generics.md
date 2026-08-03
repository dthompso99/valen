# Generic objects

Argon generic objects declare one or more type parameters after the object name:

```argon
Pair<Left, Right> {{
    member left:Left
    member right:Right
}}
```

A generic object must always be specialized with the exact number of arguments:

```argon
local pair:Pair<string, i64>
local box = new Box<Engine>(engine)
```

Concrete specializations are invariant. `Box<Dog>` and `Box<Animal>` are distinct types even when `Dog` inherits `Animal`.

The compiler monomorphizes each used specialization. Every concrete type receives its own substituted field and method signatures, object layout, runtime descriptor, garbage-collector trace functions, and mangled native symbols. Repeated uses of the same canonical specialization reuse it.

Type parameters may be used in fields, constructors, method parameters and returns, local annotations, arrays, optionals, and nested generic arguments. Open generic values and generic native declarations are not supported. Generic constraints and generic methods are separate language features.
