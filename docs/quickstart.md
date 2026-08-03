# Quickstart

## Requirements

Argon currently targets x86-64 Linux. You need:

- Node.js 20 or newer for the bootstrap compiler
- a C compiler available as `cc`
- the system assembler and linker normally installed with the C toolchain

Other architectures and operating systems are **WIP**.

## Build the native compiler

From the repository root:

```sh
node bootstrap/compiler.js src/argon.ar argon
```

This uses the JavaScript generation-0 compiler to build the compiler written in Argon.

Tell the compiler where the standard source libraries live:

```sh
export ARGON_LIBRARY_PATH="$PWD/lib"
```

For repeat native builds, create a cache directory and opt into compiler caching:

```sh
mkdir -p .argon-cache
export ARGON_CACHE_PATH="$PWD/.argon-cache"
```

Now compile and run an example:

```sh
./argon examples/simple/simple.ar -o simple
./simple
```

The compiler also provides a semantic-check-only mode:

```sh
./argon --check examples/simple/simple.ar
```

## Create a program

Save this as `hello.ar`:

```argon
import System from 'libSystem.ar'

entry {{
    __() -> i32 {
        System.write("Hello from Argon!\n")
        return 0
    }
}}
```

Compile and run it:

```sh
./argon hello.ar -o hello
./hello
```

`entry.__` is the process entry point. It may return an integer process status; `0` means success. Constructors named `__` on all other objects return `void`.

## Run the compiler tests

```sh
node bootstrap/test/pipeline.test.js
node bootstrap/test/generation1.test.js
```

The first command tests the JavaScript bootstrap pipeline. The second builds the native compiler and asks it to compile and execute the conformance fixtures.

## Docker bootstrap proof

The repository also contains a multi-stage bootstrap build:

```sh
docker build -f docker/Dockerfile.bootstrap -t argon:test .
```

It builds the native compiler in successive stages and runs representative programs. Packaging a general-purpose compiler image is **WIP**.
