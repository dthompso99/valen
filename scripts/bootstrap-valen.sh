#!/bin/sh

set -eu

cleanup() {
    rm -f valen0 valen1 valen0.o valen0.s valen1.o valen1.s valen.o valen.s
}
trap cleanup EXIT

echo "Bootstrapping Valen compiler..."
node bootstrap/compiler.js src/valen.ar valen0
echo "Compiling Generation 1 valen compiler..."
./valen0 src/valen.ar -o valen1 -O0 --target x86_64-linux
echo "Compiling final valen compiler..."
./valen1 src/valen.ar -o valen -O1 --backend llvm --target x86_64-linux
echo "Cleaning up temporary files..."
