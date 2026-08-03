node bootstrap/compiler.js  src/valen.ar valen
./valen src/valen.ar -o valen
VALEN_LIBRARY_PATH=./lib ./valen $1 -o $2