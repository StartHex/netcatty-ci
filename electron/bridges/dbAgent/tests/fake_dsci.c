/*
 * Test double for the DSCI data-access library.
 *
 * Mirrors the parts the on-host agent relies on: the public DSCI_* calls,
 * the statement shapes DSCI accepts, the database list in
 * $DSCI_PATH/cfg/db.cfg, and - unless FAKE_PLAIN is defined - the
 * _DSCI_GetSqlDb helper whose record starts with the native connection.
 *
 * Links against the fake libsi_dci.so and libddci.so, like the real library.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define NATIVE_BYTES 16384
#define T_IMDB 1
#define T_MYSQL 4
#define T_DMDB 5

extern void *si_dci_init(void *);
extern void *si_dci_real_connect(void *, const char *, const char *, const char *, const char *, int);
extern int si_dci_query(void *, const char *);
extern int si_dci_num_fields(void *);
extern long si_dci_num_rows(void *);
extern char **si_dci_fetch_row(void *);
extern int si_dci_ecode(void *);
extern char *si_dci_error(void *);
extern int si_dci_end_trans(void *, unsigned short);
extern void si_dci_quit(void *);

extern int ddci_init(char *, void *);
extern void *ddci_real_connect(void *, const char *, const char *, const char *, const char *, int);
extern int ddci_query(void *, const char *);
extern int ddci_num_fields(void *);
extern long ddci_num_rows(void *);
extern char **ddci_fetch_row(void *);
extern int ddci_ecode(void *);
extern char *ddci_error(void *);
extern int ddci_end_trans(void *, unsigned short);
extern void ddci_quit(void *);

typedef struct {
    void *dbp; /* native connection: first member, as in the real record */
    char name[8];
    char user[32], pass[32], server[256];
    long connTime;
    char logMode[8];
    char type;
    char cFlag;
    char uFlag;
} DBREC;

typedef struct {
    char error[256];
    long ret_rows;
    int field_count;
    int eno;
    DBREC *dbInfo;
    short dbNum;
    short defaultDB;
    short current;
} DSC;

static int is_dmdb(DBREC *db) { return db->type == T_DMDB; }

static int db_type(char *errStr, const char *text)
{
    if (!strcasecmp(text, "imdb")) return T_IMDB;
    if (!strcasecmp(text, "dmdb")) return T_DMDB;
    if (!strcasecmp(text, "mysql")) return T_MYSQL;
    if (!strcasecmp(text, "oracle")) {
        sprintf(errStr, "DSCI -- library not support %s, please check environment variable and re-compile.", text);
        return 0;
    }
    sprintf(errStr, "invalid type[%s]", text);
    return 0;
}

static int connect_db(DSC *p, DBREC *db)
{
    if (db->cFlag)
        return 0;
    db->dbp = calloc(1, NATIVE_BYTES);
    if (is_dmdb(db)) {
        char err[256];
        ddci_init(err, db->dbp);
        if (!ddci_real_connect(db->dbp, NULL, db->user, db->pass, db->server, 0)) {
            snprintf(p->error, sizeof(p->error), "%s", ddci_error(db->dbp));
            p->eno = ddci_ecode(db->dbp);
            return -1;
        }
    } else {
        si_dci_init(db->dbp);
        if (!si_dci_real_connect(db->dbp, NULL, db->user, db->pass, db->server, 0)) {
            snprintf(p->error, sizeof(p->error), "%s", si_dci_error(db->dbp));
            p->eno = si_dci_ecode(db->dbp);
            return -1;
        }
    }
    db->cFlag = 1;
    return 0;
}

/* DSCI only understands these statement shapes; everything else has no table. */
static int routable(const char *sql)
{
    while (*sql == ' ')
        sql++;
    if (!strncasecmp(sql, "select ", 7))
        return strcasestr(sql, " from ") != NULL;
    return !strncasecmp(sql, "update ", 7) || !strncasecmp(sql, "insert ", 7) ||
           !strncasecmp(sql, "delete ", 7) || !strncasecmp(sql, "truncate ", 9) ||
           !strncasecmp(sql, "create ", 7);
}

static int pick_db(DBREC **out, DSC *p, const char *sql, int dbNo)
{
    int index;
    if (dbNo > p->dbNum) {
        sprintf(p->error, "invalid database number [%d]", dbNo);
        p->eno = -99905;
        return -1;
    }
    if (!routable(sql)) {
        /* "cannot find the database id from the table name", in GBK */
        strcpy(p->error, "\xb2\xbb\xc4\xdc\xb8\xf9\xbe\xdd\xb1\xed\xc3\xfb\xbb\xf1\xc8\xa1\xca\xfd\xbe\xdd\xbf\xe2ID");
        p->eno = -99904;
        return -1;
    }
    index = dbNo > 0 ? dbNo - 1 : p->defaultDB;
    *out = p->dbInfo + index;
    p->current = (short)index;
    return connect_db(p, *out);
}

#ifndef FAKE_PLAIN
int _DSCI_GetSqlDb(DBREC **db, DSC *p, const char *sql, char *sqlType, int dbNo)
{
    if (sqlType)
        *sqlType = 0;
    return pick_db(db, p, sql, dbNo);
}
#endif

static char *trim(char *text)
{
    char *end;
    while (*text == ' ' || *text == '\t')
        text++;
    end = text + strlen(text);
    while (end > text && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r' || end[-1] == '\n'))
        *--end = 0;
    return text;
}

int DSCI_init(char *errStr, void **handle)
{
    char path[512], line[512], defName[16] = "", section[64] = "";
    const char *home = getenv("DSCI_PATH");
    FILE *fp;
    DSC *p;
    DBREC *db = NULL;
    int i;

    *handle = NULL;
    snprintf(path, sizeof(path), "%s/cfg/db.cfg", home ? home : "${DSCI_PATH}");
    if (!(fp = fopen(path, "r"))) {
        sprintf(errStr, "cannot open file %s", path);
        return -1;
    }
    p = calloc(1, sizeof(DSC));
    p->dbInfo = calloc(16, sizeof(DBREC));
    p->defaultDB = -1;
    while (fgets(line, sizeof(line), fp)) {
        char *hash = strchr(line, '#'), *text, *eq;
        if (hash)
            *hash = 0;
        text = trim(line);
        if (!*text)
            continue;
        if (*text == '[') {
            snprintf(section, sizeof(section), "%.*s", (int)(strlen(text) - 2), text + 1);
            db = NULL;
            if (!strncasecmp(section, "DB", 2) && strlen(section) == 4 && p->dbNum < 16) {
                db = p->dbInfo + p->dbNum++;
                strcpy(db->name, section);
                strcpy(db->user, "app");
                strcpy(db->pass, "secret");
            }
            continue;
        }
        if (!(eq = strchr(text, '=')))
            continue;
        *eq = 0;
        if (!strcasecmp(section, "SYS") && !strcasecmp(trim(text), "DEFAULT_DB"))
            snprintf(defName, sizeof(defName), "%s", trim(eq + 1));
        else if (db && !strcasecmp(trim(text), "Server"))
            snprintf(db->server, sizeof(db->server), "%s", trim(eq + 1));
        else if (db && !strcasecmp(trim(text), "Type")) {
            if (!(db->type = (char)db_type(errStr, trim(eq + 1)))) {
                fclose(fp);
                return -1;
            }
        }
    }
    fclose(fp);
    for (i = 0; i < p->dbNum; i++)
        if (!strcasecmp(defName, p->dbInfo[i].name))
            p->defaultDB = (short)i;
    if (p->dbNum == 0 || p->defaultDB < 0) {
        sprintf(errStr, "no default database in %s", path);
        return -1;
    }
    *handle = p;
    return 0;
}

int DSCI_init_direct(char *errStr, void **handle, char *dbStr)
{
    char tmp[512], *p1, *p2, *p3;
    DSC *p;

    *handle = NULL;
    snprintf(tmp, sizeof(tmp), "%s", dbStr);
    if (!(p1 = strchr(tmp, '/')) || !(p2 = strchr(p1 + 1, '@')) || !(p3 = strchr(p2 + 1, ':'))) {
        sprintf(errStr, "invalid dbStr, please use [user/pass@dbtype:dbserver]");
        return -1;
    }
    *p1 = *p2 = *p3 = 0;
    p = calloc(1, sizeof(DSC));
    p->dbInfo = calloc(1, sizeof(DBREC));
    p->dbNum = 1;
    strcpy(p->dbInfo[0].name, "DB01");
    snprintf(p->dbInfo[0].user, sizeof(p->dbInfo[0].user), "%.31s", tmp);
    snprintf(p->dbInfo[0].pass, sizeof(p->dbInfo[0].pass), "%.31s", p1 + 1);
    snprintf(p->dbInfo[0].server, sizeof(p->dbInfo[0].server), "%.255s", p3 + 1);
    if (!(p->dbInfo[0].type = (char)db_type(errStr, p2 + 1)))
        return -1;
    *handle = p;
    if (connect_db(p, p->dbInfo)) {
        strcpy(errStr, p->error);
        return -1;
    }
    return 0;
}

int DSCI_query_f(void **handle, const char *sql, int dbNo)
{
    DSC *p = (DSC *)*handle;
    DBREC *db;
    int failed;

    if (!p || pick_db(&db, p, sql, dbNo))
        return -1;
    if (is_dmdb(db)) {
        failed = ddci_query(db->dbp, sql);
        if (failed) {
            snprintf(p->error, sizeof(p->error), "%s", ddci_error(db->dbp));
            p->eno = ddci_ecode(db->dbp);
        } else {
            p->ret_rows = ddci_num_rows(db->dbp);
            p->field_count = ddci_num_fields(db->dbp);
        }
    } else {
        failed = si_dci_query(db->dbp, sql);
        if (failed) {
            snprintf(p->error, sizeof(p->error), "%s", si_dci_error(db->dbp));
            p->eno = si_dci_ecode(db->dbp);
        } else {
            p->ret_rows = si_dci_num_rows(db->dbp);
            p->field_count = si_dci_num_fields(db->dbp);
        }
    }
    if (failed) {
        /* The real library prints this to stdout, in the middle of the protocol. */
        if (p->eno > 0)
            printf("[%s],[%d],err=[%d]\n", "dsci.c", 144, p->eno);
        return -1;
    }
    if (strncasecmp(sql, "select ", 7))
        db->uFlag = 1;
    return 0;
}

char **DSCI_fetch_row(void **handle)
{
    DSC *p = (DSC *)*handle;
    DBREC *db = p->dbInfo + p->current;
    return is_dmdb(db) ? ddci_fetch_row(db->dbp) : si_dci_fetch_row(db->dbp);
}

int DSCI_num_fields(void **handle) { return ((DSC *)*handle)->field_count; }
long DSCI_num_rows(void **handle) { return ((DSC *)*handle)->ret_rows; }
int DSCI_ecode(void **handle) { return *handle ? ((DSC *)*handle)->eno : -99999; }
char *DSCI_error(void **handle) { return *handle ? ((DSC *)*handle)->error : "null handle"; }

int DSCI_end_trans(void **handle, int flag)
{
    DSC *p = (DSC *)*handle;
    int i;
    if (!p)
        return -1;
    for (i = 0; i < p->dbNum; i++) {
        DBREC *db = p->dbInfo + i;
        if (db->uFlag != 1)
            continue;
        if (is_dmdb(db))
            ddci_end_trans(db->dbp, (unsigned short)flag);
        else
            si_dci_end_trans(db->dbp, (unsigned short)flag);
        db->uFlag = 0;
    }
    return 0;
}

void DSCI_quit(void **handle)
{
    DSC *p = (DSC *)*handle;
    int i;
    if (!p)
        return;
    for (i = 0; i < p->dbNum; i++) {
        DBREC *db = p->dbInfo + i;
        if (!db->cFlag)
            continue;
        if (is_dmdb(db))
            ddci_quit(db->dbp);
        else
            si_dci_quit(db->dbp);
        free(db->dbp);
    }
    free(p->dbInfo);
    free(p);
    *handle = NULL;
}

void DSCI_ver(char *version, char *date)
{
    strcpy(version, "2.0.0.1");
    strcpy(date, "Aug 15 2018");
}
