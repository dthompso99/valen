# Quickstart

## Requirements

Valen currently targets x86-64 Linux. You need:

- Node.js 20 or newer for the bootstrap compiler
- a C compiler available as `cc`
- the system linker normally installed with the C toolchain

Other architectures and operating systems are **WIP**.

## Build the native compiler

From the repository root:

```sh
node bootstrap/compiler.js src/valen.ar valen
```

This uses the JavaScript generation-0 compiler to build the compiler written in Valen.

Tell the compiler where the standard source libraries live:

```sh
export VALEN_LIBRARY_PATH="$PWD/lib"
```

The former `ARGON_LIBRARY_PATH`, `ARGON_CACHE_PATH`, and `ARGON_CACHE_TRACE` names remain temporary compatibility aliases. New tooling should use the `VALEN_*` names.

For repeat native builds, create a cache directory and opt into compiler caching:

```sh
mkdir -p .valen-cache
export VALEN_CACHE_PATH="$PWD/.valen-cache"
```

Now compile and run an example:

```sh
./valen examples/simple/simple.ar -o simple
./simple
```

The compiler also provides a semantic-check-only mode:

```sh
./valen --check examples/simple/simple.ar
```

To stop at a relocatable ELF object without selecting a linker:

```sh
./valen --emit-object examples/simple/simple.ar -o simple.o
```

## Create a program

Save this as `hello.ar`:

```valen
import System from 'libSystem.ar'

entry {{
    __() -> i32 {
        System.write("Hello from Valen!\n")
        return 0
    }
}}
```

Compile and run it:

```sh
./valen hello.ar -o hello
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
docker build -f docker/Dockerfile.bootstrap -t valen:test .
```

It builds the native compiler in successive stages and runs representative programs. Packaging a general-purpose compiler image is **WIP**.

The self-contained native output can also run in an otherwise empty container:

```sh
docker build --target scratch-runtime -f docker/Dockerfile.bootstrap -t valen:scratch .
docker run --rm valen:scratch
```

That final image is built `FROM scratch` and contains only the compiled smoke-test executable. It proves the self-contained ELF path does not require a shell, libc, a dynamic loader, or runtime files. A future libc-linked output mode can remain a separate compiler option.
