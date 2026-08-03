#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__has_include)
#  if __has_include(<sqlite3.h>)
#    include <sqlite3.h>
#    define VALEN_HAS_SQLITE_HEADER 1
#  endif
#endif

#ifndef VALEN_HAS_SQLITE_HEADER
typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;
typedef int64_t sqlite3_int64;

extern int sqlite3_open_v2(const char *, sqlite3 **, int, const char *);
extern int sqlite3_close(sqlite3 *);
extern int sqlite3_prepare_v2(sqlite3 *, const char *, int, sqlite3_stmt **, const char **);
extern int sqlite3_step(sqlite3_stmt *);
extern int sqlite3_finalize(sqlite3_stmt *);
extern int sqlite3_bind_int64(sqlite3_stmt *, int, sqlite3_int64);
extern sqlite3_int64 sqlite3_column_int64(sqlite3_stmt *, int);
extern const char *sqlite3_errmsg(sqlite3 *);
extern int sqlite3_exec(sqlite3 *, const char *, int (*)(void *, int, char **, char **), void *, char **);

#define SQLITE_OK 0
#define SQLITE_ROW 100
#define SQLITE_DONE 101
#define SQLITE_OPEN_READWRITE 0x00000002
#define SQLITE_OPEN_CREATE 0x00000004
#endif

typedef struct {
    sqlite3 *database;
    int error_code;
    char error_message[256];
} ValenSqliteDatabase;

static void remember_error(ValenSqliteDatabase *database, int code) {
    database->error_code = code;
    const char *message = database->database ? sqlite3_errmsg(database->database) : "SQLite database is unavailable";
    snprintf(database->error_message, sizeof(database->error_message), "%s", message ? message : "Unknown SQLite error");
}

static int execute(ValenSqliteDatabase *database, const char *sql) {
    int code = sqlite3_exec(database->database, sql, NULL, NULL, NULL);
    if (code != SQLITE_OK) remember_error(database, code);
    else database->error_code = SQLITE_OK;
    return code;
}

static void rollback_preserving_error(ValenSqliteDatabase *database, int code) {
    if (database->error_code != code) remember_error(database, code);
    char message[sizeof(database->error_message)];
    memcpy(message, database->error_message, sizeof(message));
    sqlite3_exec(database->database, "ROLLBACK", NULL, NULL, NULL);
    database->error_code = code;
    memcpy(database->error_message, message, sizeof(database->error_message));
}

ValenSqliteDatabase *valen_sqlite_open(void) {
    ValenSqliteDatabase *result = calloc(1, sizeof(*result));
    if (!result) return NULL;
    const char *path = getenv("VALEN_DATABASE_PATH");
    if (!path || !*path) path = "/tmp/valen-service.sqlite";
    int code = sqlite3_open_v2(path, &result->database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL);
    if (code != SQLITE_OK) remember_error(result, code);
    return result;
}

int valen_sqlite_initialize(ValenSqliteDatabase *database) {
    if (!database || database->error_code != SQLITE_OK) return database ? database->error_code : -1;
    int code = execute(database, "BEGIN IMMEDIATE");
    if (code == SQLITE_OK) code = execute(database, "CREATE TABLE IF NOT EXISTS service_state (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)");
    if (code == SQLITE_OK) code = execute(database, "INSERT OR IGNORE INTO service_state (id, value) VALUES (1, 0)");
    if (code == SQLITE_OK) code = execute(database, "COMMIT");
    else rollback_preserving_error(database, code);
    return code;
}

int64_t valen_sqlite_get(ValenSqliteDatabase *database) {
    if (!database || database->error_code != SQLITE_OK) return 0;
    sqlite3_stmt *statement = NULL;
    int code = sqlite3_prepare_v2(database->database, "SELECT value FROM service_state WHERE id = 1", -1, &statement, NULL);
    int64_t value = 0;
    if (code == SQLITE_OK) {
        code = sqlite3_step(statement);
        if (code == SQLITE_ROW) {
            value = sqlite3_column_int64(statement, 0);
            code = SQLITE_OK;
        }
    }
    if (statement) {
        int finalize_code = sqlite3_finalize(statement);
        if (code == SQLITE_OK && finalize_code != SQLITE_OK) code = finalize_code;
    }
    if (code != SQLITE_OK) remember_error(database, code);
    else database->error_code = SQLITE_OK;
    return value;
}

int valen_sqlite_set(ValenSqliteDatabase *database, int64_t value) {
    if (!database || database->error_code != SQLITE_OK) return database ? database->error_code : -1;
    int code = execute(database, "BEGIN IMMEDIATE");
    sqlite3_stmt *statement = NULL;
    if (code == SQLITE_OK) code = sqlite3_prepare_v2(database->database, "UPDATE service_state SET value = ?1 WHERE id = 1", -1, &statement, NULL);
    if (code == SQLITE_OK) code = sqlite3_bind_int64(statement, 1, value);
    if (code == SQLITE_OK) {
        code = sqlite3_step(statement);
        if (code == SQLITE_DONE) code = SQLITE_OK;
    }
    if (statement) {
        int finalize_code = sqlite3_finalize(statement);
        if (code == SQLITE_OK && finalize_code != SQLITE_OK) code = finalize_code;
    }
    if (code == SQLITE_OK) code = execute(database, "COMMIT");
    else rollback_preserving_error(database, code);
    return code;
}

int valen_sqlite_error_code(ValenSqliteDatabase *database) {
    return database ? database->error_code : -1;
}

int64_t valen_sqlite_error_length(ValenSqliteDatabase *database) {
    return database ? (int64_t)strlen(database->error_message) : 0;
}

uint8_t valen_sqlite_error_byte(ValenSqliteDatabase *database, int64_t index) {
    if (!database || index < 0 || index >= (int64_t)strlen(database->error_message)) return 0;
    return (uint8_t)database->error_message[index];
}

int valen_sqlite_close(ValenSqliteDatabase *database) {
    if (!database) return SQLITE_OK;
    int code = database->database ? sqlite3_close(database->database) : SQLITE_OK;
    free(database);
    return code;
}
