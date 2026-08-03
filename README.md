# Valen

Valen is a native, object-oriented programming language being built from the ground up. It combines a deliberately small, readable syntax with explicit ownership, contracts, native interoperability, and a self-hosting compiler.

This is no longer only a parser experiment: Valen source can compile to native x86-64 Linux executables, and the compiler written in Valen can compile and run the project’s conformance programs.

```valen
import System from 'libSystem.ar'

Greeter {{
    member name:string

    __(name:string) -> void { self.name = name }

    greet() -> void {
        System.write("Hello, " + self.name + "!\n")
    }
}}

entry {{
    __() -> i32 {
        local greeter = new Greeter("world")
        greeter.greet()
        return 0
    }
}}
```

## What makes it interesting?

- Objects are the basic organizing unit, including the program entry point and contracts.
- `inherits` provides implementation inheritance; `implements` provides compile-time contracts.
- References and ownership exist, but ordinary code does not manipulate raw pointers.
- Native calls, unsafe boundaries, garbage collection, explicit deletion, and weak references coexist.
- Synchronous method calls stay simple; unfinished work is represented by operation objects and optional executors.
- The JavaScript bootstrap compiler builds the compiler written in Valen, which can then compile Valen programs itself.

Valen is usable as a language-development prototype and self-hosting compiler today. It is not yet a production language: portability, packaging, optimization, editor tooling, and parts of the standard library remain **WIP**.

## Start here

- [Documentation index](docs/README.md)
- [Quickstart](docs/quickstart.md)
- [Language guide](docs/language-guide.md)
- [Compiler developer guide](docs/compiler-guide.md)
- [Current status and WIP features](docs/project-status.md)
- [Contributor and agent guide](docs/agent-guide.md)

## Current target

The supported native target is x86-64 Linux. Both generation 0 and the self-hosted compiler encode ELF64 objects directly, then use the system linker for executables. Node.js is required only to build generation 0; programs compiled by the native Valen compiler do not require Node.js.

The [freestanding profile](docs/freestanding.md) defines the language/runtime boundary for future kernel and embedded targets; freestanding code generation remains **WIP**.

See [the roadmap](language_checklist.md) and the project’s Gitea issues for active work.
