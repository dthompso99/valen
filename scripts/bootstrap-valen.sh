#!/bin/sh

set -eu

cleanup() {
    rm -f valen0 valen1 valen0.o valen0.s valen1.o valen1.s valen.o valen.s valen.ll valen.llvm.o valen.runtime.o valen1.ll
}
trap cleanup EXIT

echo "Bootstrapping Valen compiler..."
node bootstrap/compiler.js src/valen.ar valen0
echo "Compiling Generation 1 valen compiler..."
./valen0 src/valen.ar -o valen1 -O0
echo "Compiling final valen compiler..."
case "$(uname -m)" in
    x86_64|amd64) ./valen1 src/valen.ar -o valen -O1 --backend llvm ;;
    aarch64|arm64) ./valen1 src/valen.ar -o valen -O1 ;;
    *) echo "Unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
esac
echo "Cleaning up temporary files..."
