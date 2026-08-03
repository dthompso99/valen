# SQLite-backed native service

This example deliberately uses an explicit foreign C boundary. Build the adapter first:

```sh
scripts/build-sqlite-adapter.sh
```

The script prefers `pkg-config sqlite3`. On systems such as the current Fedora development host where only `libsqlite3.so.0` is installed, it can build against that stable versioned runtime without the development header. If neither form is available, install one of:

```sh
sudo dnf install sqlite-devel       # Fedora/RHEL
apk add sqlite-dev                  # Alpine
sudo apt-get install libsqlite3-dev # Debian/Ubuntu
```

Compile and run:

```sh
export VALEN_LIBRARY_PATH="$PWD/lib"
export LIBRARY_PATH="$PWD/build/native"
export LD_LIBRARY_PATH="$PWD/build/native"
export VALEN_DATABASE_PATH=/tmp/valen-service.sqlite

./valen examples/sqlite-native/server.ar -o sqlite-service
./sqlite-service
```

The adapter is a shared library and depends on the platform SQLite and C runtimes. The ordinary HTTP example remains self-contained. A deployment may instead compile this same adapter with a vendored SQLite amalgamation; teaching the Valen driver to select static foreign artifacts is **WIP**. No compiler or language rule assumes that SQLite is always present.
