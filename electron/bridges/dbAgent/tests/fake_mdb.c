/*
 * Test double for an in-memory database client library.
 *
 * Built several times with a different FAKE_PREFIX to stand in for the
 * client libraries the on-host agent binds to by name (dci_, si_dci_,
 * ddci_). It answers a handful of canned statements so the agent, its wire
 * protocol and the Netcatty side can be exercised without a real database.
 *
 *   -DFAKE_PREFIX=si_dci_          full function set
 *   -DFAKE_PREFIX=ddci_ -DFAKE_DDCI -DFAKE_MINIMAL
 *                                  init takes an error buffer; no column
 *                                  names and no way to stop a result set
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

#ifndef FAKE_PREFIX
#define FAKE_PREFIX si_dci_
#endif
#define CAT2(a, b) a##b
#define CAT(a, b) CAT2(a, b)
#define FN(name) CAT(FAKE_PREFIX, name)

#define MAGIC 0x4e43464b
#define MAX_FIELDS 8
#define CELL_BYTES 512

typedef struct {
    char name[32];
    int type;
    int length;
} FIELD;

typedef struct {
    int magic;
    int connected;
    int show_fields;
    int ecode;
    char error[256];
    char info[64];
    int nfields;
    long total;
    long cursor;
    long affected;
    int table;
    int sleep_done;
    char literal[CELL_BYTES];
    char cells[MAX_FIELDS][CELL_BYTES];
    char *row[MAX_FIELDS];
    FIELD fields[MAX_FIELDS];
} FAKE;

enum { T_NONE, T_ONE, T_SMALL, T_BIG, T_TABLES, T_DESC, T_STATS, T_ECHO, T_LOB, T_EMPTY };

static long g_commits, g_rollbacks, g_pending, g_breaks, g_connects, g_quits;

static void set_field(FAKE *f, int i, const char *name, int type, int length)
{
    memset(&f->fields[i], 0, sizeof(FIELD));
    strncpy(f->fields[i].name, name, sizeof(f->fields[i].name) - 1);
    f->fields[i].type = type;
    f->fields[i].length = length;
}

static int fail(FAKE *f, int code, const char *message)
{
    f->ecode = code;
    snprintf(f->error, sizeof(f->error), "%s", message);
    f->nfields = 0;
    f->total = 0;
    f->cursor = 0;
    f->table = T_NONE;
    return -1;
}

static const char *skip_space(const char *p)
{
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')
        p++;
    return p;
}

static int starts(const char *sql, const char *word)
{
    return strncasecmp(sql, word, strlen(word)) == 0;
}

static int contains(const char *sql, const char *word)
{
    return strcasestr(sql, word) != NULL;
}

static void select_result(FAKE *f, int table, int nfields, long total)
{
    f->table = table;
    f->nfields = nfields;
    f->total = total;
    f->cursor = 0;
    f->affected = total;
    f->ecode = 0;
    f->error[0] = 0;
}

static int run(FAKE *f, const char *raw)
{
    const char *sql = skip_space(raw);

    if (f->magic != MAGIC || !f->connected)
        return fail(f, -1, "MDB-00001: not connected");

    if (starts(sql, "select")) {
        if (contains(sql, "from fake_stats")) {
            set_field(f, 0, "COMMITS", 5, 8);
            set_field(f, 1, "ROLLBACKS", 5, 8);
            set_field(f, 2, "PENDING", 5, 8);
            set_field(f, 3, "BREAKS", 5, 8);
            set_field(f, 4, "CONNECTS", 5, 8);
            select_result(f, T_STATS, 5, 1);
            return 0;
        }
        if (contains(sql, "from dba_tables")) {
            set_field(f, 0, "USER_NAME", 0, 32);
            set_field(f, 1, "TABLE_NAME", 0, 32);
            set_field(f, 2, "TABLE_SPACE", 0, 32);
            select_result(f, T_TABLES, 3, 4);
            return 0;
        }
        if (contains(sql, "t_small")) {
            set_field(f, 0, "ID", 1, 4);
            set_field(f, 1, "NAME", 0, 32);
            set_field(f, 2, "NOTE", 0, 64);
            select_result(f, contains(sql, "1=2") || contains(sql, "1 = 2") ? T_EMPTY : T_SMALL, 3,
                          contains(sql, "1=2") || contains(sql, "1 = 2") ? 0 : 3);
            return 0;
        }
        if (contains(sql, "t_big")) {
            int none = contains(sql, "1=2") || contains(sql, "1 = 2");
            set_field(f, 0, "ID", 5, 8);
            set_field(f, 1, "VAL", 0, 20);
            select_result(f, none ? T_EMPTY : T_BIG, 2, none ? 0 : 1000000);
            return 0;
        }
        if (contains(sql, "t_lob")) {
            set_field(f, 0, "ID", 1, 4);
            set_field(f, 1, "DOC", 7, 0);
            set_field(f, 2, "RAW", 6, 0);
            select_result(f, T_LOB, 3, 1);
            return 0;
        }
        if (contains(sql, "select boom"))
            return fail(f, 2100, "MDB-02100: synthetic failure");
        if (contains(sql, "select sleep")) {
            int seconds = atoi(strcasestr(sql, "sleep") + 5);
            if (seconds > 0)
                sleep((unsigned int)seconds);
            set_field(f, 0, "SLEPT", 1, 4);
            snprintf(f->literal, sizeof(f->literal), "%d", seconds);
            select_result(f, T_ECHO, 1, 1);
            return 0;
        }
        if (contains(sql, "select echo")) {
            const char *open = strchr(sql, '\'');
            const char *close = open ? strrchr(sql, '\'') : NULL;
            size_t len = (open && close && close > open) ? (size_t)(close - open - 1) : 0;
            if (len >= sizeof(f->literal))
                len = sizeof(f->literal) - 1;
            if (open)
                memcpy(f->literal, open + 1, len);
            f->literal[len] = 0;
            set_field(f, 0, "ECHO", 0, (int)len);
            select_result(f, T_ECHO, 1, 1);
            return 0;
        }
        if (contains(sql, "from dual")) {
            set_field(f, 0, "1", 1, 4);
            select_result(f, T_ONE, 1, 1);
            return 0;
        }
        return fail(f, -4000, "MDB-04000: Syntax error, table not found");
    }
    if (starts(sql, "desc ")) {
        if (!contains(sql, "t_small"))
            return fail(f, -3001, "MDB-03001: table not exists");
        set_field(f, 0, "DESC", 0, 128);
        select_result(f, T_DESC, 1, 7);
        return 0;
    }
    if (starts(sql, "insert") || starts(sql, "update") || starts(sql, "delete")) {
        const char *hint = strstr(sql, "/*n=");
        long count = hint ? atol(hint + 4) : 1;
        if (contains(sql, "bad_table"))
            return fail(f, -3001, "MDB-03001: table not exists");
        f->nfields = 0;
        f->table = T_NONE;
        f->affected = count;
        f->ecode = 0;
        g_pending += count;
        return 0;
    }
    if (starts(sql, "create") || starts(sql, "truncate") || starts(sql, "drop") || starts(sql, "alter")) {
        f->nfields = 0;
        f->table = T_NONE;
        f->affected = 0;
        f->ecode = 0;
        return 0;
    }
    return fail(f, -4000, "MDB-04000: Syntax error");
}

static void put_lob(char *cell, int is_clob, const char *data, int len)
{
    memcpy(cell, &len, sizeof(int));
    cell[4] = (char)is_clob;
    memcpy(cell + 5, data, (size_t)len);
}

static char **next_row(FAKE *f)
{
    int i;
    long n;

    if (f->magic != MAGIC || f->nfields <= 0 || f->cursor >= f->total)
        return NULL;
    n = f->cursor++;
    for (i = 0; i < f->nfields; i++)
        f->row[i] = f->cells[i];

    switch (f->table) {
    case T_ONE:
        strcpy(f->cells[0], "1");
        break;
    case T_ECHO:
        strcpy(f->cells[0], f->literal);
        break;
    case T_SMALL:
        snprintf(f->cells[0], CELL_BYTES, "%ld", n + 1);
        if (n == 0) {
            strcpy(f->cells[1], "alice");
            strcpy(f->cells[2], "plain");
        } else if (n == 1) {
            /* "zhang san" in GBK */
            strcpy(f->cells[1], "\xd5\xc5\xc8\xfd");
            f->row[2] = NULL;
        } else {
            strcpy(f->cells[1], "tab\there");
            strcpy(f->cells[2], "line1\nline2");
        }
        break;
    case T_BIG:
        snprintf(f->cells[0], CELL_BYTES, "%ld", n + 1);
        snprintf(f->cells[1], CELL_BYTES, "value-%ld", n + 1);
        break;
    case T_TABLES: {
        static const char *rows[4][3] = {
            {"APP", "T_SMALL", "USERS"},
            {"APP", "T_BIG", "USERS"},
            {"APP", "V_ONE", "VIEW"},
            {"APP", "SEQ_ONE", "SEQ"},
        };
        for (i = 0; i < 3; i++)
            strcpy(f->cells[i], rows[n][i]);
        break;
    }
    case T_DESC: {
        static const char *lines[7] = {
            "CREATE TABLE APP.T_SMALL", "(", "ID INT NOT NULL,", "NAME VARCHAR(32),",
            "NOTE VARCHAR(64),", "PRIMARY KEY(ID)", ");",
        };
        strcpy(f->cells[0], lines[n]);
        break;
    }
    case T_STATS:
        snprintf(f->cells[0], CELL_BYTES, "%ld", g_commits);
        snprintf(f->cells[1], CELL_BYTES, "%ld", g_rollbacks);
        snprintf(f->cells[2], CELL_BYTES, "%ld", g_pending);
        snprintf(f->cells[3], CELL_BYTES, "%ld", g_breaks);
        snprintf(f->cells[4], CELL_BYTES, "%ld", g_connects);
        break;
    case T_LOB:
        strcpy(f->cells[0], "1");
        put_lob(f->cells[1], 1, "clob text", 9);
        put_lob(f->cells[2], 0, "\x00\x01\xfe\xff", 4);
        break;
    default:
        return NULL;
    }
    return f->row;
}

/* ------------------------------------------------------------------ API */

#ifdef FAKE_DDCI
int FN(init)(char *errStr, void *handle)
{
    FAKE *f = (FAKE *)handle;
    (void)errStr;
    memset(f, 0, sizeof(FAKE));
    f->magic = MAGIC;
    return 0;
}
#else
void *FN(init)(void *handle)
{
    FAKE *f = (FAKE *)handle;
    memset(f, 0, sizeof(FAKE));
    f->magic = MAGIC;
    return handle;
}
#endif

void FN(set_timeout)(void *handle, int ms) { (void)handle; (void)ms; }
void FN(set_readtimeout)(void *handle, int ms) { (void)handle; (void)ms; }
int FN(set_auto_commit)(void *handle, int flag) { (void)handle; (void)flag; return 0; }
int FN(set_log_mode)(void *handle, const char *mode) { (void)handle; (void)mode; return 0; }
void FN(set_Buffer_flag)(void *handle) { (void)handle; }

void *FN(real_connect)(void *handle, const char *bak, const char *user, const char *pass,
                       const char *db, int tries)
{
    FAKE *f = (FAKE *)handle;
    (void)bak;
    (void)tries;
    if (f->magic != MAGIC)
        return NULL;
    if (!user || !pass || strcmp(user, "app") != 0 || strcmp(pass, "secret") != 0) {
        f->ecode = -1017;
        snprintf(f->error, sizeof(f->error), "MDB-01017: invalid username/password (%s@%s)",
                 user ? user : "", db ? db : "");
        return NULL;
    }
    if (db && strstr(db, "unreachable")) {
        f->ecode = -99998;
        snprintf(f->error, sizeof(f->error), "MDB-99998: cannot connect to server(%s)", db);
        return NULL;
    }
    f->connected = 1;
    g_connects++;
    return handle;
}

int FN(query)(void *handle, const char *sql) { return run((FAKE *)handle, sql); }
int FN(num_fields)(void *handle) { return ((FAKE *)handle)->nfields; }
long FN(num_rows)(void *handle) { return ((FAKE *)handle)->affected; }
char **FN(fetch_row)(void *handle) { return next_row((FAKE *)handle); }
int FN(ecode)(void *handle) { return ((FAKE *)handle)->ecode; }
char *FN(error)(void *handle) { return ((FAKE *)handle)->error; }

int FN(end_trans)(void *handle, unsigned short flag)
{
    FAKE *f = (FAKE *)handle;
    if (f->magic != MAGIC || !f->connected)
        return -1;
    if (flag == 0)
        g_commits++;
    else if (flag == 1)
        g_rollbacks++;
    if (flag == 0 || flag == 1)
        g_pending = 0;
    return 0;
}

void FN(quit)(void *handle)
{
    FAKE *f = (FAKE *)handle;
    if (f->magic == MAGIC && f->connected) {
        f->connected = 0;
        g_quits++;
    }
}

void FN(ver)(char *version, char *date)
{
    strcpy(version, "9.9.0.1");
    strcpy(date, "Jan 01 2026");
}

#ifndef FAKE_MINIMAL
void FN(set_show_field_flag)(void *handle, int flag) { ((FAKE *)handle)->show_fields = flag; }

FIELD *FN(fetch_field_direct)(void *handle, int index)
{
    FAKE *f = (FAKE *)handle;
    if (!f->show_fields || index < 0 || index >= f->nfields)
        return NULL;
    return &f->fields[index];
}

void FN(break_fetch)(void *handle, int flag)
{
    FAKE *f = (FAKE *)handle;
    if (flag != 0)
        return;
    if (f->cursor < f->total) {
        f->cursor = f->total;
        g_breaks++;
    }
}

int FN(lob_size)(const char *cell)
{
    int len;
    memcpy(&len, cell, sizeof(int));
    return len;
}

char *FN(lob_getp)(char *cell) { return cell + 5; }
int FN(lob_isclob)(const char *cell) { return cell[4]; }
#endif
