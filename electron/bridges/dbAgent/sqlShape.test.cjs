const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveSelectColumns, parseDescribeOutput, quoteLiteral, splitTopLevel } = require("./sqlShape.cjs");

test("deriveSelectColumns labels the items of a select list", () => {
  assert.deepEqual(deriveSelectColumns("select id, name from t"), { names: ["id", "name"] });
  assert.deepEqual(
    deriveSelectColumns("SELECT a.id, b.name AS who, count(*) cnt, nvl(x, 'a,b') FROM a, b WHERE a.id = b.id"),
    { names: ["id", "who", "cnt", "nvl(x, 'a,b')"] },
  );
  assert.deepEqual(deriveSelectColumns("select distinct user_name from dba_tables;"), { names: ["user_name"] });
  assert.deepEqual(
    deriveSelectColumns("-- note\n/* more */ select '@', 1, round(m/1048576.0,3) from dba_mems where flag='T'"),
    { names: ["'@'", "1", "round(m/1048576.0,3)"] },
  );
  assert.deepEqual(
    deriveSelectColumns("select (select max(id) from t2) top, price * 2 total from t"),
    { names: ["top", "total"] },
  );
});

test("deriveSelectColumns names the table behind a plain star", () => {
  assert.deepEqual(deriveSelectColumns("select * from app.t_small where id = 1"), { starTable: "app.t_small" });
  assert.deepEqual(deriveSelectColumns("select * from T_BIG"), { starTable: "T_BIG" });
  assert.deepEqual(deriveSelectColumns("select * from t x where x.id = 1"), { starTable: "t" });
  assert.equal(deriveSelectColumns("select * from a, b"), null);
  assert.equal(deriveSelectColumns("select * from a x, b y"), null);
  assert.equal(deriveSelectColumns("select * from a left join b on a.id = b.id"), null);
  assert.equal(deriveSelectColumns("select * from a x join b y on x.id = y.id"), null);
  assert.equal(deriveSelectColumns("select a.*, b.id from a, b"), null);
});

test("deriveSelectColumns gives up on what is not a select with a from", () => {
  assert.equal(deriveSelectColumns("update t set a = 1"), null);
  assert.equal(deriveSelectColumns("select sysdate"), null);
  assert.equal(deriveSelectColumns(""), null);
});

test("parseDescribeOutput reads the DDL an in-memory database prints", () => {
  const columns = parseDescribeOutput([
    "CREATE TABLE APP.T_SMALL",
    "(",
    "ID INT NOT NULL,",
    "NAME VARCHAR(32),",
    "AMOUNT NUMBER(12,2) DEFAULT 0 NOT NULL,",
    "NOTE VARCHAR(64),",
    "PRIMARY KEY(ID, NAME)",
    ");",
  ]);
  assert.deepEqual(columns, [
    { name: "ID", type: "INT", nullable: false, primaryKey: true },
    { name: "NAME", type: "VARCHAR(32)", nullable: true, primaryKey: true },
    { name: "AMOUNT", type: "NUMBER(12,2)", nullable: false, primaryKey: false },
    { name: "NOTE", type: "VARCHAR(64)", nullable: true, primaryKey: false },
  ]);
});

test("parseDescribeOutput copes with one line and with noise around the DDL", () => {
  assert.deepEqual(
    parseDescribeOutput(["iMSQL> create table t (a int primary key, b varchar(8) not null);", "1 rows selected"]),
    [
      { name: "a", type: "int", nullable: true, primaryKey: true },
      { name: "b", type: "varchar(8)", nullable: false, primaryKey: false },
    ],
  );
  assert.deepEqual(parseDescribeOutput(["table not exists"]), []);
  assert.deepEqual(parseDescribeOutput([]), []);
});

test("quoteLiteral and splitTopLevel keep quotes and parentheses intact", () => {
  assert.equal(quoteLiteral("O'Brien"), "'O''Brien'");
  assert.deepEqual(splitTopLevel("a, f(b, c), 'd,e'", ","), ["a", " f(b, c)", " 'd,e'"]);
});
