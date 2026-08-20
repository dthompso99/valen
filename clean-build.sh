node bootstrap/compiler.js  src/valen.ar valen --runtime-metrics
./valen src/valen.ar -o valen --runtime-metrics
VALEN_LIBRARY_PATH=./lib ./valen $1 -o $2