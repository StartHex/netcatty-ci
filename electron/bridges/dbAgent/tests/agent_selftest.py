# -*- coding: utf-8 -*-
"""Runs the on-host agent against the test-double libraries.

    python agent_selftest.py            builds the doubles, then tests
    python agent_selftest.py <dir>      uses doubles already built in <dir>

Works on Python 2.7 and Python 3, like the agent itself. Exits non-zero on
the first failed expectation.
"""
from __future__ import print_function

import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(os.path.dirname(HERE), "agent", "netcatty_dbagent.py")

NS = {"__name__": "netcatty_dbagent_selftest"}
with open(AGENT) as source:
    exec(compile(source.read(), AGENT, "exec"), NS)

encode_frame = NS["encode_frame"]
FrameReader = NS["FrameReader"]
REQ_MARK = NS["REQ_MARK"]
RES_MARK = NS["RES_MARK"]

CHECKS = [0]


def expect(condition, message):
    CHECKS[0] += 1
    if not condition:
        raise AssertionError(message)


def expect_equal(actual, expected, message):
    expect(actual == expected, "%s: expected %r, got %r" % (message, expected, actual))


class Client(object):
    def __init__(self, env):
        full = dict(os.environ)
        for name in ("DSCI_PATH", "DCI_HOME", "DDCI_HOME", "DMDB_HOME", "LD_LIBRARY_PATH", "NLS_LANG",
                     "LC_ALL", "LC_CTYPE"):
            full.pop(name, None)
        full["LANG"] = "en_US.UTF-8"
        full.update(env)
        self.proc = subprocess.Popen([sys.executable, "-u", AGENT], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, env=full)
        self.frames = FrameReader(RES_MARK)
        self.next_id = 0
        self.noise = []
        self.ready = self.read_frame()
        expect_equal(self.ready[1], "READY", "first frame")

    def read_frame(self):
        while True:
            line = self.proc.stdout.readline()
            if not line:
                return None
            frame = self.frames.feed_line(line)
            if frame is None:
                if RES_MARK not in line:
                    self.noise.append(line)
                continue
            return frame

    def send(self, method, params):
        self.next_id += 1
        for line in encode_frame(REQ_MARK, self.next_id, method, params):
            self.proc.stdin.write(line)
        self.proc.stdin.flush()
        return self.next_id

    def collect(self, frame_id):
        out = {"columns": None, "rows": [], "ok": None, "error": None, "result": None}
        while True:
            frame = self.read_frame()
            if frame is None:
                out["ok"] = False
                out["error"] = {"message": "agent exited", "code": "agent-exit"}
                return out
            if frame[0] != frame_id:
                continue
            kind, payload = frame[1], frame[2]
            if kind == "COLS":
                out["columns"] = payload["columns"]
            elif kind == "ROWS":
                out["rows"].extend(payload["rows"])
            elif kind == "OK":
                out["ok"] = True
                out["result"] = payload
                return out
            elif kind == "ERR":
                out["ok"] = False
                out["error"] = payload
                return out

    def request(self, method, params=None):
        return self.collect(self.send(method, params or {}))

    def query(self, sql, max_rows=1000):
        return self.request("QUERY", {"sql": sql, "maxRows": max_rows})

    def stats(self):
        reply = self.query("select commits, rollbacks, pending, breaks, connects from fake_stats")
        expect(reply["ok"], "stats query: %r" % (reply["error"],))
        return dict(zip(("commits", "rollbacks", "pending", "breaks", "connects"),
                        [int(value) for value in reply["rows"][0]]))

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        deadline = time.time() + 10
        while self.proc.poll() is None and time.time() < deadline:
            time.sleep(0.05)
        if self.proc.poll() is None:
            self.proc.kill()
            raise AssertionError("agent did not exit when its input closed")


def names(reply):
    return [column["name"] for column in reply["columns"]]


def env_for(root, dsci=None, mdb=True, ddci=True):
    paths = []
    env = {}
    if mdb:
        env["DCI_HOME"] = os.path.join(root, "mdb")
        paths.append(os.path.join(root, "mdb", "dci", "lib"))
    if ddci:
        paths.append(os.path.join(root, "ddci", "lib"))
    if dsci:
        env["DSCI_PATH"] = os.path.join(root, dsci)
        paths.append(os.path.join(root, dsci, "lib"))
    env["LD_LIBRARY_PATH"] = os.pathsep.join(paths)
    return env


def test_native_client(root):
    client = Client(env_for(root))
    opened = client.request("OPEN", {"mode": "direct", "dbType": "imdb", "server": "127.0.0.1:3847",
                                     "user": "app", "password": "secret"})
    expect(opened["ok"], "open: %r" % (opened["error"],))
    expect_equal(opened["result"]["backend"], "dci", "backend without DSCI")
    expect_equal(opened["result"]["family"], "mdb", "family")
    expect(opened["result"]["columnNames"], "column names offered")
    expect(opened["result"]["anyStatement"], "any statement offered")

    small = client.query("select * from t_small;\n")
    expect(small["ok"], "select: %r" % (small["error"],))
    expect_equal(names(small), ["ID", "NAME", "NOTE"], "column names")
    expect_equal([column["type"] for column in small["columns"]], ["INT", "CHAR(32)", "CHAR(64)"], "types")
    expect_equal(small["rows"][0], ["1", "alice", "plain"], "plain row")
    expect_equal(small["rows"][1], ["2", u"张三", None], "GBK text and NULL")
    expect_equal(small["rows"][2], ["3", "tab\there", "line1\nline2"], "control characters survive")
    expect_equal(small["result"]["truncated"], False, "not truncated")

    empty = client.query("select * from t_small where 1=2")
    expect_equal((names(empty), empty["rows"]), (["ID", "NAME", "NOTE"], []), "empty result keeps columns")

    before = client.stats()
    big = client.query("select * from t_big", max_rows=25)
    expect(big["ok"], "big select: %r" % (big["error"],))
    expect_equal(len(big["rows"]), 25, "row cap")
    expect_equal(big["rows"][24], ["25", "value-25"], "last kept row")
    expect_equal(big["result"]["truncated"], True, "truncated flag")
    after = client.stats()
    expect_equal(after["breaks"], before["breaks"] + 1, "the rest of the result set was stopped, not read")
    expect_equal(after["connects"], before["connects"], "no reconnect needed")

    many = client.query("select * from t_big", max_rows=2000)
    expect_equal(len(many["rows"]), 2000, "rows across several batches")
    expect_equal(many["rows"][1999][0], "2000", "batch order")

    inserted = client.query("insert into t_small values (9, 'x', 'y') /*n=3*/")
    expect(inserted["ok"], "insert: %r" % (inserted["error"],))
    expect_equal((inserted["result"]["select"], inserted["result"]["affected"]), (False, 3), "affected rows")
    stats = client.stats()
    expect_equal((stats["commits"], stats["pending"]), (after["commits"] + 1, 0), "statement committed itself")

    expect(client.request("BEGIN")["ok"], "begin")
    client.query("update t_small set name = 'z'")
    expect_equal(client.stats()["pending"], 1, "inside a transaction nothing is committed")
    expect_equal(client.query("rollback")["result"]["command"], "ROLLBACK", "typed rollback")
    stats = client.stats()
    expect_equal((stats["rollbacks"], stats["pending"]), (1, 0), "rolled back")
    client.query("begin")
    client.query("delete from t_small")
    expect(client.query(" Commit ; ")["ok"], "typed commit")
    expect_equal(client.stats()["pending"], 0, "committed")

    failed = client.query("select boom from dual")
    expect_equal(failed["ok"], False, "error reported")
    expect_equal((failed["error"]["code"], failed["error"]["native"]), ("db-error", 2100), "native error code")
    expect("synthetic failure" in failed["error"]["message"], "native error text")
    expect(client.query("select 1 from dual")["ok"], "usable after an error")

    lob = client.query("select * from t_lob")
    expect_equal(lob["rows"][0], ["1", "clob text", "0x0001FEFF"], "CLOB as text, BLOB as hex")

    desc = client.query("desc app.t_small")
    expect_equal(desc["rows"][0], ["CREATE TABLE APP.T_SMALL"], "desc runs natively")

    echo = client.query(u"select echo '中文' from dual")
    expect_equal(echo["rows"][0], [u"中文"], "non-ASCII SQL round trip")

    expect_equal(client.request("PING")["ok"], True, "ping")
    client.close()


def test_native_wrong_password(root):
    client = Client(env_for(root))
    opened = client.request("OPEN", {"mode": "direct", "dbType": "imdb", "server": "db", "user": "app",
                                     "password": "nope"})
    expect_equal(opened["ok"], False, "bad login refused")
    expect_equal((opened["error"]["code"], opened["error"]["native"]), ("connect-failed", -1017), "codes")
    expect("invalid username/password" in opened["error"]["message"], "reason")
    closed = client.query("select 1 from dual")
    expect_equal(closed["error"]["code"], "not-connected", "no session after a failed open")
    client.close()


def test_native_dmdb_without_dsci(root):
    client = Client(env_for(root))
    opened = client.request("OPEN", {"mode": "direct", "dbType": "dmdb", "server": "cluster", "user": "app",
                                     "password": "secret"})
    expect(opened["ok"], "open: %r" % (opened["error"],))
    expect_equal(opened["result"]["backend"], "ddci", "DMDB client used directly")
    expect_equal(opened["result"]["columnNames"], False, "this client has no column names")
    small = client.query("select * from t_small")
    expect_equal(names(small), [None, None, None], "unnamed columns")
    expect_equal(small["rows"][0], ["1", "alice", "plain"], "rows")
    before = client.stats()
    big = client.query("select * from t_big", max_rows=5)
    expect_equal((len(big["rows"]), big["result"]["truncated"]), (5, True), "row cap")
    after = client.query("select 1 from dual")
    expect(after["ok"], "usable after dropping the result set")
    # A new connection replaced the old one, so the counters restarted.
    expect_equal(client.stats()["connects"], before["connects"] + 1, "reconnected to drop the result set")
    client.close()


def test_dsci_config(root):
    client = Client(env_for(root, dsci="dsci"))
    opened = client.request("OPEN", {"mode": "config"})
    expect(opened["ok"], "open: %r" % (opened["error"],))
    result = opened["result"]
    expect_equal((result["backend"], result["dbNo"], result["dbType"]), ("dsci+ddci", 2, "dmdb"),
                 "default database, native handle borrowed")
    expect_equal(result["target"], "DB02 (dmdb)", "target label")
    expect_equal(result["dbs"], [{"no": 1, "name": "DB01", "type": "imdb"},
                                 {"no": 2, "name": "DB02", "type": "dmdb"},
                                 {"no": 3, "name": "DB03", "type": "mysql"}], "database list")
    expect_equal(result["clientVersion"], "DSCI 2.0.0.1", "version")
    expect(client.query("desc t_small")["ok"], "statements DSCI itself cannot route still run")
    multi = client.query("select *\n  from t_small\n where 1 = 1")
    expect(multi["ok"], "multi-line SQL: %r" % (multi["error"],))
    client.query("insert into t_small values (1, 'a', 'b')")
    stats = client.stats()
    expect_equal((stats["commits"], stats["pending"]), (1, 0), "commit reaches the native connection")
    client.close()

    client = Client(env_for(root, dsci="dsci"))
    opened = client.request("OPEN", {"mode": "config", "dbNo": 1})
    expect_equal(opened["result"]["backend"], "dsci+si_dci", "first database")
    expect_equal(opened["result"]["columnNames"], True, "names from the native connection")
    expect_equal(names(client.query("select * from t_small")), ["ID", "NAME", "NOTE"], "column names")
    big = client.query("select * from t_big", max_rows=3)
    expect_equal((len(big["rows"]), big["result"]["truncated"]), (3, True), "row cap")
    client.close()

    client = Client(env_for(root, dsci="dsci"))
    opened = client.request("OPEN", {"mode": "config", "dbNo": 3})
    expect_equal((opened["result"]["backend"], opened["result"]["family"]), ("dsci", "mysql"),
                 "no native handle for other database types")
    expect_equal(opened["result"]["anyStatement"], False, "DSCI statement shapes only")
    multi = client.query("select *\n\tfrom t_small\n")
    expect(multi["ok"], "DSCI gets the statement on one line: %r" % (multi["error"],))
    expect_equal(names(multi), [None, None, None], "DSCI has no column names")
    refused = client.query("desc t_small")
    expect_equal(refused["ok"], False, "DSCI cannot route desc")
    expect_equal(refused["error"]["native"], -99904, "DSCI error code")
    expect(u"不能根据表名" in refused["error"]["message"], "GBK message decoded")
    expect("DSCI only runs" in refused["error"]["message"], "hint about statement shapes")
    client.close()

    client = Client(env_for(root, dsci="dsci"))
    missing = client.request("OPEN", {"mode": "config", "dbNo": 9})
    expect_equal(missing["error"]["code"], "connect-failed", "unknown database number")
    expect("it lists 3" in missing["error"]["message"], "says how many there are")
    client.close()


def test_dsci_plain(root):
    client = Client(env_for(root, dsci="dsci_plain"))
    opened = client.request("OPEN", {"mode": "config", "dbNo": 1})
    expect(opened["ok"], "open: %r" % (opened["error"],))
    expect_equal(opened["result"]["backend"], "dsci", "no helper, so no native handle")
    client.query("insert into t_small values (1, 'a', 'b')")
    stats = client.stats()
    expect_equal((stats["commits"], stats["pending"]), (1, 0), "commit goes through DSCI")
    failed = client.query("select boom from dual")
    expect_equal(failed["error"]["native"], 2100, "error code")
    expect(any(b"err=[2100]" in line for line in client.noise), "library output on stdout is not a frame")
    before = client.stats()["connects"]
    big = client.query("select * from t_big", max_rows=4)
    expect_equal((len(big["rows"]), big["result"]["truncated"]), (4, True), "row cap")
    expect(client.query("select 1 from dual")["ok"], "usable afterwards")
    expect_equal(client.stats()["connects"], before + 1, "reconnected to drop the result set")
    client.close()


def test_dsci_direct(root):
    client = Client(env_for(root, dsci="dsci"))
    opened = client.request("OPEN", {"mode": "direct", "dbType": "dmdb", "server": "cluster:9500",
                                     "user": "app", "password": "secret"})
    expect(opened["ok"], "open: %r" % (opened["error"],))
    expect_equal((opened["result"]["backend"], opened["result"]["target"]), ("dsci+ddci", "dmdb:cluster:9500"),
                 "direct login through DSCI")
    client.close()

    client = Client(env_for(root, dsci="dsci"))
    refused = client.request("OPEN", {"mode": "direct", "dbType": "dmdb", "server": "unreachable:1",
                                      "user": "app", "password": "secret"})
    expect_equal(refused["error"]["code"], "connect-failed", "connect failure")
    expect("cannot connect to server(unreachable:1)" in refused["error"]["message"], "library's reason")
    oracle = client.request("OPEN", {"mode": "direct", "dbType": "oracle", "server": "orcl", "user": "app",
                                     "password": "secret"})
    expect_equal(oracle["ok"], False, "type this DSCI build lacks")
    expect("not support oracle" in oracle["error"]["message"], "library's reason")
    client.close()


def test_missing_libraries(root):
    client = Client({"LD_LIBRARY_PATH": ""})
    config = client.request("OPEN", {"mode": "config"})
    expect_equal(config["error"]["code"], "library-missing", "no DSCI")
    expect("libdsci.so" in config["error"]["message"], "names the library")
    direct = client.request("OPEN", {"mode": "direct", "dbType": "imdb", "server": "x", "user": "a",
                                     "password": "b"})
    expect_equal(direct["error"]["code"], "library-missing", "no client library")
    client.close()


def test_diagnostics(root):
    client = Client(env_for(root, dsci="dsci"))
    diag = client.request("DIAG")["result"]
    libs = dict((item["name"], item) for item in diag["libraries"])
    expect(libs["libdsci.so"]["ok"] and libs["libddci.so"]["ok"], "libraries load")
    expect("_DSCI_GetSqlDb" in libs["libdsci.so"]["functions"], "lists the helper")
    expect("ddci_query" in libs["libddci.so"]["functions"], "lists what the DMDB client exports")
    expect("ddci_fetch_field_direct" not in libs["libddci.so"]["functions"], "and what it lacks")
    expect_equal(diag["dsciConfig"]["default"], "DB02", "default database")
    expect_equal(diag["dsciConfig"]["dbs"][1]["server"], "dmdb-cluster", "comment stripped from the server")
    expect_equal(diag["env"]["DSCI_PATH"], os.path.join(root, "dsci"), "environment")
    client.close()


def test_cancel_and_frames(root):
    client = Client(env_for(root))
    client.request("OPEN", {"mode": "direct", "dbType": "imdb", "server": "db", "user": "app",
                            "password": "secret"})
    started = time.time()
    running = client.send("QUERY", {"sql": "select sleep 30 from dual", "maxRows": 10})
    time.sleep(0.5)
    client.send("CANCEL", {})
    reply = client.collect(running)
    expect_equal(reply["error"]["code"], "query-cancelled", "cancel during a blocking call")
    expect(time.time() - started < 10, "did not wait for the statement")
    deadline = time.time() + 5
    while client.proc.poll() is None and time.time() < deadline:
        time.sleep(0.05)
    expect(client.proc.poll() is not None, "the agent ends itself to stop the statement")

    client = Client(env_for(root))
    client.proc.stdin.write(REQ_MARK + b" 7 PING 00000000 AAAA\n")
    client.proc.stdin.flush()
    reply = client.collect(7)
    expect_equal(reply["error"]["code"], "bad-frame", "checksum mismatch is reported")
    client.proc.stdin.write(b"some shell noise\n$ \n")
    expect(client.request("PING")["ok"], "noise between frames is ignored")
    long_text = "x" * 6000
    echo = client.request("OPEN", {"mode": "direct", "dbType": "imdb", "server": "db", "user": "app",
                                   "password": "secret", "env": {"NETCATTY_SELFTEST": long_text}})
    expect(echo["ok"], "a request spanning several lines")
    expect_equal(client.request("DIAG")["ok"], True, "diag")
    unknown = client.request("NOPE")
    expect_equal(unknown["error"]["code"], "bad-request", "unknown request")
    client.close()


TESTS = [test_native_client, test_native_wrong_password, test_native_dmdb_without_dsci, test_dsci_config,
         test_dsci_plain, test_dsci_direct, test_missing_libraries, test_diagnostics, test_cancel_and_frames]


def main():
    built = None
    if len(sys.argv) > 1:
        root = sys.argv[1]
    else:
        built = tempfile.mkdtemp(prefix="ncfakes.")
        root = built
        subprocess.check_call(["sh", os.path.join(HERE, "build_fakes.sh"), root], stdout=subprocess.PIPE)
    failed = 0
    try:
        for test in TESTS:
            try:
                test(root)
                print("ok   %s" % (test.__name__,))
            except Exception as err:
                failed += 1
                print("FAIL %s: %s" % (test.__name__, err))
    finally:
        if built:
            shutil.rmtree(built, ignore_errors=True)
    print("python %s: %d checks, %d failed tests" % (sys.version.split()[0], CHECKS[0], failed))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
