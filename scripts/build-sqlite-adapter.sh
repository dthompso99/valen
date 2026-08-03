#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_directory=${1:-"$project_root/build/native"}
source_file="$project_root/native/sqlite/valen_sqlite_adapter.c"
output_file="$output_directory/libvalen_sqlite_adapter.so"
probe_file=$(mktemp "${TMPDIR:-/tmp}/valen-sqlite-probe.XXXXXX")
trap 'rm -f "$probe_file"' 0

mkdir -p "$output_directory"

if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists sqlite3; then
    # pkg-config output is intentionally word-split into compiler arguments.
    sqlite_cflags=$(pkg-config --cflags sqlite3)
    sqlite_libraries=$(pkg-config --libs sqlite3)
    # shellcheck disable=SC2086
    cc -std=c11 -O2 -fPIC -shared $sqlite_cflags "$source_file" -o "$output_file" $sqlite_libraries
elif cc -shared -Wl,--no-as-needed -Wl,-l:libsqlite3.so.0 -x c /dev/null -o "$probe_file" 2>/dev/null; then
    cc -std=c11 -O2 -fPIC -shared "$source_file" -o "$output_file" -Wl,--no-as-needed -Wl,-l:libsqlite3.so.0
else
    echo "valen: SQLite development or runtime library not found" >&2
    echo "Install sqlite-devel on Fedora/RHEL or sqlite-dev on Alpine, then retry." >&2
    exit 1
fi

echo "$output_file"
