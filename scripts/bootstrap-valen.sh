echo "Bootstrapping valen compiler..."
node bootstrap/compiler.js  src/valen.ar valen0
echo "Compiling Generation 1 valen compiler..."
./valen0 src/valen.ar -o valen1
echo "Compiling final valen compiler..."
./valen1 src/valen.ar -o valen
echo "Cleaning up temporary files..."
rm valen0 valen1 valen0.o valen0.s valen1.o valen.o