# -*- coding: ascii -*-
# Netcatty on-host database agent.
#
# Runs on the machine reached over SSH and executes SQL through the database
# client libraries installed there (DSCI, or the ProMDB / DMDB client), so no
# database port has to be reachable from the desktop. Netcatty talks to it
# over the session's stdin and stdout.
#
# Python 2.7 and Python 3, standard library only. Netcatty sends this file
# through the login shell, so nothing has to be installed on the host.
#
# Wire format, one frame per line in both directions:
#
#   @NCQ@ <id> + <chunk>                 request, more chunks follow
#   @NCQ@ <id> <METHOD> <crc> <chunk>    request, last chunk
#   @NC@ <id> + <chunk>                  response, more chunks follow
#   @NC@ <id> <KIND> <crc> <chunk>       response, last chunk
#
# The chunks of a frame concatenate to base64(zlib(JSON)); <crc> is the CRC-32
# of that base64 text as 8 hex digits. Anything else on the stream (shell
# prompts, text the client libraries print) is not a frame and is ignored.

import base64
import ctypes
import errno
import json
import os
import struct
import sys
import threading
import time
import traceback
import zlib

try:
    import queue as queue_mod
except ImportError:  # Python 2
    import Queue as queue_mod

AGENT_VERSION = 1
REQ_MARK = b"@NCQ@"
RES_MARK = b"@NC@"
CHUNK = 900
ROW_BATCH = 400
ROW_BATCH_BYTES = 48 * 1024
# The native handles are caller-allocated structs whose size this agent does
# not know; a generous zeroed block is always large enough.
NATIVE_HANDLE_BYTES = 4 * 1024 * 1024
MAX_LOB_BYTES = 256 * 1024

PY3 = sys.version_info[0] >= 3


def asc(value):
    if isinstance(value, bytes):
        return value
    return value.encode("ascii")


def text_of(value, encoding="utf-8"):
    """bytes -> text without ever raising."""
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return value.decode(encoding)
        except Exception:
            return value.decode("latin-1")
    return value


def bytes_of(value, encoding="utf-8"):
    if value is None:
        return None
    if isinstance(value, bytes):
        return value
    try:
        return value.encode(encoding)
    except Exception:
        return value.encode("utf-8")


def native_str(value):
    """The interpreter's own str type, for os.environ."""
    return text_of(value) if PY3 else bytes_of(value)


def jsonable(value):
    """Byte strings (every Python 2 str) become text so json can encode them."""
    if isinstance(value, bytes):
        return text_of(value)
    if isinstance(value, dict):
        return dict((jsonable(key), jsonable(item)) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return [jsonable(item) for item in value]
    return value


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------

_write_lock = threading.Lock()


def write_all(fd, data):
    while data:
        try:
            done = os.write(fd, data)
        except OSError as err:
            if err.errno == errno.EINTR:
                continue
            if err.errno == errno.EAGAIN:
                time.sleep(0.01)
                continue
            raise
        data = data[done:]


def encode_frame(mark, frame_id, kind, obj):
    raw = json.dumps(jsonable(obj), separators=(",", ":"))
    payload = base64.b64encode(zlib.compress(asc(raw), 6))
    crc = asc("%08x" % (zlib.crc32(payload) & 0xFFFFFFFF))
    head = mark + b" " + asc(str(frame_id)) + b" "
    lines = []
    pos = 0
    while len(payload) - pos > CHUNK:
        lines.append(head + b"+ " + payload[pos:pos + CHUNK] + b"\n")
        pos += CHUNK
    lines.append(head + asc(kind) + b" " + crc + b" " + payload[pos:] + b"\n")
    return lines


def send(frame_id, kind, obj):
    lines = encode_frame(RES_MARK, frame_id, kind, obj)
    _write_lock.acquire()
    try:
        for line in lines:
            write_all(1, line)
    finally:
        _write_lock.release()


class FrameReader(object):
    """Collects the chunks of each frame and yields decoded frames."""

    def __init__(self, mark):
        self.mark = mark + b" "
        self.partial = {}

    def feed_line(self, line):
        """Returns (id, kind, obj), ("error", id, message) or None."""
        at = line.find(self.mark)
        if at < 0:
            return None
        parts = line[at + len(self.mark):].strip().split(b" ")
        try:
            frame_id = int(parts[0])
        except (ValueError, IndexError):
            return None
        if len(parts) == 3 and parts[1] == b"+":
            self.partial.setdefault(frame_id, []).append(parts[2])
            return None
        if len(parts) != 4:
            return None
        chunks = self.partial.pop(frame_id, [])
        chunks.append(parts[3])
        payload = b"".join(chunks)
        crc = asc("%08x" % (zlib.crc32(payload) & 0xFFFFFFFF))
        if crc != parts[2].lower():
            return ("error", frame_id, "frame checksum mismatch")
        try:
            obj = json.loads(zlib.decompress(base64.b64decode(payload)).decode("utf-8"))
        except Exception as err:
            return ("error", frame_id, "frame cannot be decoded: %s" % (err,))
        return (frame_id, text_of(parts[1], "ascii"), obj)


# ---------------------------------------------------------------------------
# Terminal handling
# ---------------------------------------------------------------------------

class TtyGuard(object):
    """Raw mode while the agent owns a terminal, restored on the way out."""

    def __init__(self):
        self.saved = None

    def enter(self):
        try:
            import termios
            if not os.isatty(0):
                return
            self.saved = termios.tcgetattr(0)
            mode = termios.tcgetattr(0)
            mode[0] &= ~(termios.IGNBRK | termios.BRKINT | termios.PARMRK | termios.ISTRIP |
                         termios.INLCR | termios.IGNCR | termios.ICRNL | termios.IXON |
                         termios.IXOFF)
            mode[1] &= ~termios.OPOST
            mode[2] &= ~(termios.CSIZE | termios.PARENB)
            mode[2] |= termios.CS8
            mode[3] &= ~(termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG |
                         termios.IEXTEN)
            mode[6][termios.VMIN] = 1
            mode[6][termios.VTIME] = 0
            termios.tcsetattr(0, termios.TCSANOW, mode)
        except Exception:
            self.saved = None

    def leave(self):
        if self.saved is None:
            return
        try:
            import termios
            termios.tcsetattr(0, termios.TCSANOW, self.saved)
        except Exception:
            pass
        self.saved = None


TTY = TtyGuard()


def hard_exit(code):
    TTY.leave()
    os._exit(code)


# ---------------------------------------------------------------------------
# Errors and text
# ---------------------------------------------------------------------------

class DbError(Exception):
    def __init__(self, message, code="db-error", native=None):
        Exception.__init__(self, message)
        self.text = message
        self.code = code
        self.native = native


class Unsupported(Exception):
    pass


ENCODING_ALIASES = {
    "utf8": "utf-8", "utf-8": "utf-8", "utf8mb4": "utf-8",
    "gbk": "gbk", "gb2312": "gb18030", "gb18030": "gb18030",
    "big5": "big5", "latin1": "latin-1", "latin-1": "latin-1",
}


def locale_encoding():
    for name in ("NLS_LANG", "LC_ALL", "LC_CTYPE", "LANG"):
        value = os.environ.get(name, "").upper()
        if not value:
            continue
        if "GB" in value:
            return "gb18030"
        if "BIG5" in value:
            return "big5"
        if "UTF" in value:
            return "utf-8"
    return "utf-8"


def message_text(data):
    """Text the client libraries produce: UTF-8 or GBK, whichever it is."""
    for name in ("utf-8", "gb18030"):
        try:
            return data.decode(name)
        except Exception:
            pass
    return data.decode("latin-1")


class Codec(object):
    """Text encoding of the database session."""

    def __init__(self, name):
        key = (name or "").strip().lower()
        self.auto = key in ("", "auto")
        self.name = locale_encoding() if self.auto else ENCODING_ALIASES.get(key, key)
        try:
            b"".decode(self.name)
        except Exception:
            self.name = "utf-8"

    def decode(self, data):
        if data is None:
            return None
        if self.auto:
            return message_text(data)
        try:
            return data.decode(self.name, "replace")
        except Exception:
            return data.decode("latin-1")

    def encode(self, value):
        return bytes_of(value, self.name)


def flatten_sql(sql):
    """One line, single spaces outside quotes, no trailing semicolon."""
    out = []
    quote = None
    space = False
    for ch in sql:
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in ("\r", "\n", "\t", " "):
            space = True
            continue
        if space and out:
            out.append(" ")
        space = False
        if ch in ("'", '"'):
            quote = ch
        out.append(ch)
    text = "".join(out).strip()
    while text.endswith(";"):
        text = text[:-1].rstrip()
    return text


def trim_sql(sql):
    text = sql.strip()
    while text.endswith(";"):
        text = text[:-1].rstrip()
    return text


# ---------------------------------------------------------------------------
# Library loading
# ---------------------------------------------------------------------------

def env_path(name, *parts):
    base = os.environ.get(name)
    if not base:
        return None
    return os.path.join(base, *parts)


def library_candidates(soname, extra):
    seen = []
    for item in list(extra or []) + [soname]:
        if item and item not in seen:
            seen.append(item)
    return seen


def load_library(soname, extra=None):
    """Returns (library, None) or (None, reason)."""
    reasons = []
    for candidate in library_candidates(soname, extra):
        if os.sep in candidate and not os.path.exists(candidate):
            continue
        try:
            return ctypes.CDLL(candidate, ctypes.RTLD_GLOBAL), None
        except OSError as err:
            reasons.append("%s: %s" % (candidate, err))
    if not reasons:
        reasons.append("%s: not found" % (soname,))
    return None, "; ".join(reasons)


def has_symbol(lib, name):
    try:
        getattr(lib, name)
        return True
    except AttributeError:
        return False


def loaded_path(fragment):
    """Path of a mapped shared library whose name contains `fragment`."""
    try:
        handle = open("/proc/self/maps")
        try:
            for line in handle:
                path = line.strip().split(" ")[-1]
                if fragment in os.path.basename(path):
                    return path
        finally:
            handle.close()
    except Exception:
        pass
    return None


def elf_exports(path, prefix, limit=400):
    """Names of the dynamic symbols a 64-bit little-endian ELF file defines."""
    names = []
    try:
        handle = open(path, "rb")
        try:
            data = handle.read()
        finally:
            handle.close()
        if data[:4] != b"\x7fELF" or data[4:5] != b"\x02" or data[5:6] != b"\x01":
            return names
        shoff, = struct.unpack_from("<Q", data, 0x28)
        shentsize, shnum = struct.unpack_from("<HH", data, 0x3A)
        sections = []
        for index in range(shnum):
            base = shoff + index * shentsize
            sh_type, = struct.unpack_from("<I", data, base + 4)
            sh_offset, sh_size, sh_link = struct.unpack_from("<QQI", data, base + 0x18)
            sh_entsize, = struct.unpack_from("<Q", data, base + 0x38)
            sections.append((sh_type, sh_offset, sh_size, sh_link, sh_entsize))
        wanted = asc(prefix)
        for sh_type, sh_offset, sh_size, sh_link, sh_entsize in sections:
            if sh_type != 11 or not sh_entsize:  # SHT_DYNSYM
                continue
            str_offset = sections[sh_link][1]
            for index in range(int(sh_size // sh_entsize)):
                base = sh_offset + index * sh_entsize
                st_name, st_info, _other, st_shndx = struct.unpack_from("<IBBH", data, base)
                if st_shndx == 0 or (st_info & 0xF) != 2:  # undefined, or not a function
                    continue
                end = data.find(b"\x00", str_offset + st_name)
                name = data[str_offset + st_name:end]
                if name.startswith(wanted):
                    names.append(text_of(name, "ascii"))
                    if len(names) >= limit:
                        return sorted(names)
    except Exception:
        pass
    return sorted(names)


# ---------------------------------------------------------------------------
# DSCI configuration ($DSCI_PATH/cfg/db.cfg)
# ---------------------------------------------------------------------------

def parse_db_cfg(path):
    """Reads the database sections the way DSCI numbers them."""
    result = {"path": path, "exists": False, "default": None, "dbs": []}
    try:
        handle = open(path, "rb")
    except Exception:
        return result
    try:
        raw = handle.read()
    finally:
        handle.close()
    result["exists"] = True
    section = None
    current = None
    for raw_line in raw.split(b"\n"):
        line = text_of(raw_line, "latin-1")
        cut = line.find("#")
        if cut >= 0:
            line = line[:cut]
        line = line.replace("\t", " ").replace("\r", "").strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip()
            current = None
            if section.upper().startswith("DB") and len(section) == 4:
                current = {"index": len(result["dbs"]), "name": section, "type": "", "server": ""}
                result["dbs"].append(current)
            continue
        if "=" not in line or section is None:
            continue
        key, value = line.split("=", 1)
        key = key.strip().lower()
        value = value.strip()
        if section.upper() == "SYS" and key == "default_db":
            result["default"] = value
        elif current is not None and key == "type" and not current["type"]:
            current["type"] = value.lower()
        elif current is not None and key == "server" and not current["server"]:
            current["server"] = value
    return result


# ---------------------------------------------------------------------------
# Native in-memory database client (ProMDB / iMDB / DMDB)
# ---------------------------------------------------------------------------

FIELD_TYPES = {0: "CHAR", 1: "INT", 2: "DATE", 3: "FLOAT", 4: "DOUBLE", 5: "LONG",
               6: "BLOB", 7: "CLOB", 8: "SHORT"}
LOB_TYPES = (6, 7)

VP = ctypes.c_void_p
CP = ctypes.c_char_p


def plausible_name(name):
    if not name or len(name) > 64:
        return False
    for ch in name:
        code = ord(ch)
        if code < 0x21 or code > 0x7E:
            return False
    return True


class NativeMdb(object):
    """Calls one flavour of the client library: dci_, si_dci_ or ddci_."""

    REQUIRED = ("query", "fetch_row", "num_fields", "num_rows", "error", "ecode", "end_trans")

    def __init__(self, lib, prefix, handle=None):
        self.lib = lib
        self.prefix = prefix
        self.flavour = prefix.rstrip("_")
        self.borrowed = handle is not None
        self.block = None
        self.handle = handle
        self.fields = []
        self.lob_columns = ()
        self.connected = self.borrowed
        self.calls = {}

    @classmethod
    def usable(cls, lib, prefix):
        for name in cls.REQUIRED:
            if not has_symbol(lib, prefix + name):
                return False
        return True

    def has(self, name):
        return has_symbol(self.lib, self.prefix + name)

    def fn(self, name, restype, argtypes):
        cached = self.calls.get(name)
        if cached is None:
            cached = getattr(self.lib, self.prefix + name)
            cached.restype = restype
            cached.argtypes = argtypes
            self.calls[name] = cached
        return cached

    def last_error(self):
        message = ""
        code = None
        try:
            raw = self.fn("error", VP, [VP])(self.handle)
            if raw:
                message = message_text(ctypes.string_at(raw))
        except Exception:
            pass
        try:
            code = int(self.fn("ecode", ctypes.c_int, [VP])(self.handle))
        except Exception:
            pass
        return DbError(message or "database error", "db-error", code)

    def connect(self, user, password, server, timeout_ms):
        self.block = ctypes.create_string_buffer(NATIVE_HANDLE_BYTES)
        self.handle = ctypes.addressof(self.block)
        if self.flavour == "ddci":
            err = ctypes.create_string_buffer(2048)
            if self.fn("init", ctypes.c_int, [CP, VP])(err, self.handle) != 0:
                raise DbError(message_text(err.value) or "ddci_init failed", "connect-failed")
        else:
            if not self.fn("init", VP, [VP])(self.handle):
                raise DbError("%sinit failed" % (self.prefix,), "connect-failed")
        if timeout_ms and self.has("set_timeout"):
            self.fn("set_timeout", None, [VP, ctypes.c_int])(self.handle, int(timeout_ms))
        self.enable_field_names()
        done = self.fn("real_connect", VP, [VP, CP, CP, CP, CP, ctypes.c_int])(
            self.handle, None, bytes_of(user or ""), bytes_of(password or ""), bytes_of(server or ""), 0)
        if not done:
            failure = self.last_error()
            failure.code = "connect-failed"
            raise failure
        self.connected = True

    def enable_field_names(self):
        if self.has("set_show_field_flag"):
            try:
                self.fn("set_show_field_flag", None, [VP, ctypes.c_int])(self.handle, 1)
            except Exception:
                pass

    def set_read_timeout(self, timeout_ms):
        if self.has("set_readtimeout"):
            try:
                self.fn("set_readtimeout", None, [VP, ctypes.c_int])(self.handle, int(timeout_ms))
            except Exception:
                pass

    def execute(self, sql):
        self.fields = []
        self.lob_columns = ()
        if self.fn("query", ctypes.c_int, [VP, CP])(self.handle, sql) != 0:
            raise self.last_error()

    def num_fields(self):
        return int(self.fn("num_fields", ctypes.c_int, [VP])(self.handle))

    def num_rows(self):
        return int(self.fn("num_rows", ctypes.c_long, [VP])(self.handle))

    def columns(self, count):
        self.fields = []
        lobs = []
        named = self.has("fetch_field_direct")
        for index in range(count):
            name = None
            kind = None
            if named:
                try:
                    raw = self.fn("fetch_field_direct", VP, [VP, ctypes.c_int])(self.handle, index)
                    if raw:
                        # name[32], then two ints: type and length.
                        text = text_of(ctypes.string_at(raw, 32).split(b"\x00")[0], "latin-1")
                        code, length = struct.unpack("ii", ctypes.string_at(raw + 32, 8))
                        if plausible_name(text):
                            name = text
                            if code in FIELD_TYPES:
                                kind = FIELD_TYPES[code]
                                if code in LOB_TYPES:
                                    lobs.append(index)
                                elif code == 0 and 0 < length < 100000:
                                    kind = "CHAR(%d)" % (length,)
                except Exception:
                    name = None
            self.fields.append({"name": name, "type": kind})
        if [item for item in self.fields if item["name"] is None]:
            # Names from a layout that does not match are worse than none.
            lobs = []
            for item in self.fields:
                item["name"] = None
                item["type"] = None
        self.lob_columns = tuple(lobs)
        return self.fields

    def fetch(self, count):
        row = self.fn("fetch_row", VP, [VP])(self.handle)
        if not row:
            return None
        cells = (VP * count).from_address(row)
        values = []
        for index in range(count):
            address = cells[index]
            if not address:
                values.append(None)
            elif index in self.lob_columns:
                values.append(self.read_lob(address))
            else:
                values.append(ctypes.string_at(address))
        return values

    def read_lob(self, address):
        try:
            size = int(self.fn("lob_size", ctypes.c_int, [VP])(address))
            start = self.fn("lob_getp", VP, [VP])(address)
            if not start or size < 0:
                return None
            data = ctypes.string_at(start, min(size, MAX_LOB_BYTES))
            is_clob = int(self.fn("lob_isclob", ctypes.c_int, [VP])(address))
            if is_clob:
                return data
            text = asc("0x") + base64.b16encode(data)
            if size > MAX_LOB_BYTES:
                text += asc("...(%d bytes)" % (size,))
            return text
        except Exception:
            return ctypes.string_at(address)

    def abandon(self):
        """Stops an unfinished result set without reading the rest of it."""
        if not self.has("break_fetch"):
            raise Unsupported("break_fetch")
        # 0: tell the server to stop and read its acknowledgement.
        self.fn("break_fetch", None, [VP, ctypes.c_int])(self.handle, 0)

    def end_trans(self, flag):
        if self.fn("end_trans", ctypes.c_int, [VP, ctypes.c_ushort])(self.handle, flag) != 0:
            raise self.last_error()

    def version(self):
        if not self.has("ver"):
            return ""
        try:
            number = ctypes.create_string_buffer(128)
            date = ctypes.create_string_buffer(128)
            self.fn("ver", None, [CP, CP])(number, date)
            return text_of(number.value, "latin-1")
        except Exception:
            return ""

    def close(self):
        if self.borrowed or not self.connected:
            return
        self.connected = False
        try:
            self.fn("quit", None, [VP])(self.handle)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

MDB_TYPES = ("imdb", "dmdb", "promdb", "mdb")


def family_of(db_type):
    kind = (db_type or "").lower()
    if kind in MDB_TYPES:
        return "mdb"
    if kind in ("mysql", "oracle", "opengauss", "altibase", "timesten"):
        return kind
    return kind or "unknown"


class NativeSession(object):
    """Connected straight through the in-memory database client library."""

    def __init__(self, native, db_type, target):
        self.native = native
        self.db_type = db_type
        self.target = target
        self.reconnect_args = None

    def describe(self):
        return {
            "backend": self.native.flavour,
            "family": "mdb",
            "dbType": self.db_type,
            "target": self.target,
            "clientVersion": self.native.version(),
            "columnNames": self.native.has("fetch_field_direct"),
            "anyStatement": True,
        }

    def prepare(self, sql):
        return trim_sql(sql)

    def execute(self, sql, timeout_ms):
        if timeout_ms:
            self.native.set_read_timeout(timeout_ms)
        self.native.execute(sql)

    def num_fields(self):
        return self.native.num_fields()

    def num_rows(self):
        return self.native.num_rows()

    def columns(self, count):
        return self.native.columns(count)

    def fetch(self, count):
        return self.native.fetch(count)

    def abandon(self, in_transaction):
        try:
            self.native.abandon()
            return
        except Unsupported:
            pass
        if in_transaction or self.reconnect_args is None:
            drain(self)
            return
        self.native.close()
        self.native.connect(*self.reconnect_args)

    def end_trans(self, flag):
        self.native.end_trans(flag)

    def close(self):
        self.native.close()


def drain(session):
    count = session.num_fields()
    while session.fetch(count) is not None:
        pass


class DsciSession(object):
    """Connected through DSCI: its configuration, logins and database types."""

    def __init__(self, lib):
        self.lib = lib
        self.handle = VP(None)
        self.db_no = 1
        self.db_type = ""
        self.target = ""
        self.native = None
        self.reopen = None
        self.dbs = []
        lib.DSCI_init.restype = ctypes.c_int
        lib.DSCI_init.argtypes = [CP, ctypes.POINTER(VP)]
        lib.DSCI_init_direct.restype = ctypes.c_int
        lib.DSCI_init_direct.argtypes = [CP, ctypes.POINTER(VP), CP]
        lib.DSCI_query_f.restype = ctypes.c_int
        lib.DSCI_query_f.argtypes = [ctypes.POINTER(VP), CP, ctypes.c_int]
        lib.DSCI_fetch_row.restype = VP
        lib.DSCI_fetch_row.argtypes = [ctypes.POINTER(VP)]
        lib.DSCI_num_fields.restype = ctypes.c_int
        lib.DSCI_num_fields.argtypes = [ctypes.POINTER(VP)]
        lib.DSCI_num_rows.restype = ctypes.c_long
        lib.DSCI_num_rows.argtypes = [ctypes.POINTER(VP)]
        lib.DSCI_end_trans.restype = ctypes.c_int
        lib.DSCI_end_trans.argtypes = [ctypes.POINTER(VP), ctypes.c_int]
        lib.DSCI_error.restype = VP
        lib.DSCI_error.argtypes = [ctypes.POINTER(VP)]
        lib.DSCI_ecode.restype = ctypes.c_int
        lib.DSCI_ecode.argtypes = [ctypes.POINTER(VP)]
        lib.DSCI_quit.restype = None
        lib.DSCI_quit.argtypes = [ctypes.POINTER(VP)]

    def ref(self):
        return ctypes.byref(self.handle)

    def last_error(self, code="db-error"):
        message = ""
        native = None
        try:
            raw = self.lib.DSCI_error(self.ref())
            if raw:
                message = message_text(ctypes.string_at(raw))
            native = int(self.lib.DSCI_ecode(self.ref()))
        except Exception:
            pass
        return DbError(message or "database error", code, native)

    def open_config(self, db_no):
        path = env_path("DSCI_PATH", "cfg", "db.cfg")
        if not path:
            raise DbError("DSCI_PATH is not set in this login environment", "connect-failed")
        cfg = parse_db_cfg(path)
        if not cfg["exists"]:
            raise DbError("%s does not exist" % (path,), "connect-failed")
        self.dbs = cfg["dbs"]
        index = None
        if db_no and db_no > 0:
            index = db_no - 1
        else:
            for item in cfg["dbs"]:
                if cfg["default"] and item["name"].upper() == cfg["default"].upper():
                    index = item["index"]
        if index is None or index < 0 or index >= len(cfg["dbs"]):
            raise DbError("database number %s is not in %s (it lists %d)" % (db_no, path, len(cfg["dbs"])),
                          "connect-failed")
        entry = cfg["dbs"][index]
        self.db_no = index + 1
        self.db_type = entry["type"]
        self.target = "%s (%s)" % (entry["name"], entry["type"])
        self.reopen = lambda: self.init_config()
        self.init_config()

    def init_config(self):
        err = ctypes.create_string_buffer(4096)
        self.handle = VP(None)
        if self.lib.DSCI_init(err, self.ref()) != 0:
            raise DbError(message_text(err.value) or "DSCI_init failed", "connect-failed")
        self.connect_now()

    def open_direct(self, user, password, db_type, server):
        self.db_no = 1
        self.db_type = (db_type or "").lower()
        self.target = "%s:%s" % (self.db_type, server)
        login = bytes_of("%s/%s@%s:%s" % (user or "", password or "", self.db_type, server or ""))
        self.reopen = lambda: self.init_direct(login)
        self.init_direct(login)

    def init_direct(self, login):
        err = ctypes.create_string_buffer(4096)
        self.handle = VP(None)
        if self.lib.DSCI_init_direct(err, self.ref(), login) != 0:
            raise DbError(message_text(err.value) or "DSCI_init_direct failed", "connect-failed")
        self.connect_now()

    def connect_now(self):
        """Connects the chosen database and borrows its native handle."""
        self.native = None
        resolve = getattr(self.lib, "_DSCI_GetSqlDb", None) if has_symbol(self.lib, "_DSCI_GetSqlDb") else None
        if resolve is None:
            # Without it the connection is made by the first statement.
            self.plain_probe()
            return
        resolve.restype = ctypes.c_int
        resolve.argtypes = [ctypes.POINTER(VP), VP, CP, CP, ctypes.c_int]
        record = VP(None)
        kind = ctypes.create_string_buffer(8)
        if resolve(ctypes.byref(record), self.handle, b"select 1 from dual", kind, self.db_no) != 0:
            raise self.last_error("connect-failed")
        if family_of(self.db_type) != "mdb" or not record.value:
            return
        # The record starts with the pointer to the native connection.
        pointer = VP.from_address(record.value).value
        if not pointer:
            return
        soname, prefix = ("libddci.so", "ddci_") if self.db_type == "dmdb" else ("libsi_dci.so", "si_dci_")
        lib, _reason = load_library(soname)
        if lib is None or not NativeMdb.usable(lib, prefix):
            return
        self.native = NativeMdb(lib, prefix, pointer)
        self.native.enable_field_names()

    def plain_probe(self):
        if self.lib.DSCI_query_f(self.ref(), b"select 1 from dual", self.db_no) != 0:
            raise self.last_error("connect-failed")
        count = int(self.lib.DSCI_num_fields(self.ref()))
        while count > 0 and self.plain_fetch(count) is not None:
            pass

    def describe(self):
        info = {
            "backend": "dsci+" + self.native.flavour if self.native else "dsci",
            "family": family_of(self.db_type),
            "dbType": self.db_type,
            "target": self.target,
            "dbNo": self.db_no,
            "dbs": [{"no": item["index"] + 1, "name": item["name"], "type": item["type"]} for item in self.dbs],
            "columnNames": bool(self.native and self.native.has("fetch_field_direct")),
            "anyStatement": bool(self.native),
            "clientVersion": self.version(),
        }
        return info

    def version(self):
        if not has_symbol(self.lib, "DSCI_ver"):
            return ""
        try:
            number = ctypes.create_string_buffer(128)
            date = ctypes.create_string_buffer(128)
            self.lib.DSCI_ver.restype = None
            self.lib.DSCI_ver.argtypes = [CP, CP]
            self.lib.DSCI_ver(number, date)
            return "DSCI " + text_of(number.value, "latin-1")
        except Exception:
            return ""

    def prepare(self, sql):
        if self.native:
            return trim_sql(sql)
        # DSCI finds the database by scanning for " from " on one line.
        return flatten_sql(sql)

    def execute(self, sql, timeout_ms):
        if self.native:
            if timeout_ms:
                self.native.set_read_timeout(timeout_ms)
            self.native.execute(sql)
            return
        if self.lib.DSCI_query_f(self.ref(), sql, self.db_no) != 0:
            failure = self.last_error()
            if failure.native == -99905 or failure.native == -99904:
                failure.text += (" (DSCI only runs select / insert / update / delete / truncate table /"
                                 " create table, and a select needs a from clause)")
            raise failure

    def num_fields(self):
        if self.native:
            return self.native.num_fields()
        return int(self.lib.DSCI_num_fields(self.ref()))

    def num_rows(self):
        if self.native:
            return self.native.num_rows()
        return int(self.lib.DSCI_num_rows(self.ref()))

    def columns(self, count):
        if self.native:
            return self.native.columns(count)
        return [{"name": None, "type": None} for _index in range(count)]

    def plain_fetch(self, count):
        row = self.lib.DSCI_fetch_row(self.ref())
        if not row:
            return None
        cells = (VP * count).from_address(row)
        return [ctypes.string_at(cells[index]) if cells[index] else None for index in range(count)]

    def fetch(self, count):
        if self.native:
            return self.native.fetch(count)
        return self.plain_fetch(count)

    def abandon(self, in_transaction):
        if self.native:
            try:
                self.native.abandon()
                return
            except Unsupported:
                pass
        if in_transaction:
            drain(self)
            return
        # Closing the connection is the only way left to drop the result set.
        self.close()
        self.reopen()

    def end_trans(self, flag):
        if self.native:
            self.native.end_trans(flag)
            return
        if self.lib.DSCI_end_trans(self.ref(), flag) != 0:
            raise self.last_error()

    def close(self):
        if self.handle.value:
            try:
                self.lib.DSCI_quit(self.ref())
            except Exception:
                pass
        self.handle = VP(None)
        self.native = None


def dsci_candidates():
    return [env_path("DSCI_PATH", "lib", "libdsci.so")]


def mdb_candidates(soname):
    return [env_path("DCI_HOME", "dci", "lib", soname), env_path("DDCI_HOME", "lib", soname),
            env_path("DMDB_HOME", "lib", soname)]


def open_session(params):
    mode = params.get("mode") or "config"
    backend = params.get("backend") or "auto"
    db_type = (params.get("dbType") or "").lower()
    timeout_ms = int(params.get("connectTimeoutMs") or 15000)
    reasons = []

    if mode == "config" or backend in ("auto", "dsci"):
        lib, reason = load_library("libdsci.so", dsci_candidates())
        if lib is None:
            reasons.append("DSCI: " + reason)
            if mode == "config" or backend == "dsci":
                raise DbError("Cannot load libdsci.so. " + reason, "library-missing")
        else:
            session = DsciSession(lib)
            if mode == "config":
                session.open_config(int(params.get("dbNo") or 0))
                return session
            try:
                session.open_direct(params.get("user"), params.get("password"), db_type, params.get("server"))
                return session
            except DbError as err:
                # A DSCI build without this database type: try its own client.
                if "not support" not in err.text or family_of(db_type) != "mdb":
                    raise
                reasons.append("DSCI: " + err.text)

    if family_of(db_type) != "mdb":
        raise DbError("Database type %r needs DSCI on this host. %s" % (db_type, " ".join(reasons)),
                      "library-missing")
    order = [("libddci.so", "ddci_")] if db_type == "dmdb" else [("libdci.so", "dci_"), ("libsi_dci.so", "si_dci_")]
    for soname, prefix in order:
        lib, reason = load_library(soname, mdb_candidates(soname))
        if lib is None:
            reasons.append(reason)
            continue
        if not NativeMdb.usable(lib, prefix):
            reasons.append("%s lacks the expected %s functions" % (soname, prefix))
            continue
        native = NativeMdb(lib, prefix)
        args = (params.get("user"), params.get("password"), params.get("server"), timeout_ms)
        native.connect(*args)
        session = NativeSession(native, db_type, "%s:%s" % (db_type, params.get("server")))
        session.reconnect_args = args
        return session
    raise DbError("No database client library could be loaded. " + " ".join(reasons), "library-missing")


# ---------------------------------------------------------------------------
# Request handling
# ---------------------------------------------------------------------------

class Agent(object):
    def __init__(self):
        self.session = None
        self.codec = Codec("auto")
        self.in_transaction = False
        self.phase = "idle"
        self.active_id = 0
        self.cancel_requested = False

    # -- lifecycle ---------------------------------------------------------

    def op_hello(self, _frame_id, _params):
        return self.identity()

    def identity(self):
        return {
            "agent": AGENT_VERSION,
            "python": "%d.%d.%d" % tuple(sys.version_info[:3]),
            "platform": sys.platform,
            "pid": os.getpid(),
            "tty": bool(TTY.saved is not None),
            "locale": locale_encoding(),
        }

    def op_open(self, _frame_id, params):
        self.close_session()
        for name, value in (params.get("env") or {}).items():
            os.environ[native_str(name)] = native_str(value)
        self.codec = Codec(params.get("encoding"))
        self.in_transaction = False
        self.session = open_session(params)
        info = self.session.describe()
        info["encoding"] = self.codec.name
        return info

    def close_session(self):
        if self.session is not None:
            try:
                self.session.close()
            except Exception:
                pass
        self.session = None

    def op_close(self, frame_id, _params):
        self.close_session()
        send(frame_id, "OK", {})
        hard_exit(0)

    def op_ping(self, _frame_id, _params):
        return {"at": int(time.time())}

    def require(self):
        if self.session is None:
            raise DbError("The database connection is not open", "not-connected")
        return self.session

    # -- transactions ------------------------------------------------------

    def op_begin(self, _frame_id, _params):
        self.require()
        self.in_transaction = True
        return {"command": "BEGIN"}

    def op_commit(self, _frame_id, _params):
        self.require().end_trans(0)
        self.in_transaction = False
        return {"command": "COMMIT"}

    def op_rollback(self, _frame_id, _params):
        self.require().end_trans(1)
        self.in_transaction = False
        return {"command": "ROLLBACK"}

    # -- statements --------------------------------------------------------

    def op_query(self, frame_id, params):
        session = self.require()
        text = params.get("sql") or ""
        keyword = flatten_sql(text).lower()
        if keyword in ("commit", "commit work"):
            return self.op_commit(frame_id, params)
        if keyword in ("rollback", "rollback work"):
            return self.op_rollback(frame_id, params)
        if keyword in ("begin", "begin transaction", "begin work", "start transaction"):
            return self.op_begin(frame_id, params)

        max_rows = int(params.get("maxRows") or 1000)
        timeout_ms = int(params.get("timeoutMs") or 0)
        sql = self.codec.encode(session.prepare(text))
        started = time.time()
        self.cancel_requested = False
        self.active_id = frame_id
        self.phase = "exec"
        try:
            try:
                session.execute(sql, timeout_ms)
            except DbError:
                self.settle(session, False)
                raise
            self.phase = "fetch"
            count = session.num_fields()
            if count <= 0:
                affected = session.num_rows()
                self.settle(session, True)
                return {"select": False, "affected": affected, "ms": int((time.time() - started) * 1000)}
            columns = session.columns(count)
            send(frame_id, "COLS", {"columns": columns})
            rows, truncated = self.stream_rows(frame_id, session, count, max_rows)
            return {"select": True, "rows": rows, "truncated": truncated,
                    "ms": int((time.time() - started) * 1000)}
        finally:
            self.phase = "idle"
            self.active_id = 0

    def settle(self, session, ok):
        """Outside a transaction every statement commits or rolls back itself."""
        if self.in_transaction:
            return
        try:
            session.end_trans(0 if ok else 1)
        except DbError:
            if ok:
                raise

    def stream_rows(self, frame_id, session, count, max_rows):
        batch = []
        size = 0
        total = 0
        truncated = False
        decode = self.codec.decode
        while True:
            if self.cancel_requested:
                session.abandon(self.in_transaction)
                raise DbError("Query cancelled", "query-cancelled")
            row = session.fetch(count)
            if row is None:
                break
            if total >= max_rows:
                truncated = True
                session.abandon(self.in_transaction)
                break
            cells = []
            for value in row:
                if value is None:
                    cells.append(None)
                else:
                    size += len(value)
                    cells.append(decode(value))
            batch.append(cells)
            total += 1
            if len(batch) >= ROW_BATCH or size >= ROW_BATCH_BYTES:
                send(frame_id, "ROWS", {"rows": batch})
                batch = []
                size = 0
        if batch:
            send(frame_id, "ROWS", {"rows": batch})
        return total, truncated

    # -- diagnostics -------------------------------------------------------

    def op_diag(self, _frame_id, _params):
        info = self.identity()
        env = {}
        for name in ("DSCI_PATH", "DCI_HOME", "DDCI_HOME", "DMDB_HOME", "LD_LIBRARY_PATH", "LANG",
                     "LC_ALL", "NLS_LANG", "ORACLE_HOME", "HOME", "SHELL", "USER"):
            if name in os.environ:
                env[name] = os.environ[name]
        info["env"] = env
        libs = []
        for soname, extra, prefix in (("libdsci.so", dsci_candidates(), "DSCI_"),
                                      ("libsi_dci.so", mdb_candidates("libsi_dci.so"), "si_dci_"),
                                      ("libdci.so", mdb_candidates("libdci.so"), "dci_"),
                                      ("libddci.so", mdb_candidates("libddci.so"), "ddci_")):
            lib, reason = load_library(soname, extra)
            item = {"name": soname, "ok": lib is not None}
            if lib is None:
                item["error"] = reason
            else:
                path = loaded_path(soname)
                item["path"] = path
                if path:
                    item["functions"] = elf_exports(path, prefix)
                    if soname == "libdsci.so":
                        item["functions"] += elf_exports(path, "_DSCI_Get")
            libs.append(item)
        info["libraries"] = libs
        path = env_path("DSCI_PATH", "cfg", "db.cfg")
        if path:
            cfg = parse_db_cfg(path)
            info["dsciConfig"] = {
                "path": path,
                "exists": cfg["exists"],
                "default": cfg["default"],
                "dbs": [{"no": item["index"] + 1, "name": item["name"], "type": item["type"],
                         "server": item["server"]} for item in cfg["dbs"]],
            }
        return info

    # -- dispatch ----------------------------------------------------------

    def handle(self, frame_id, method, params):
        handler = getattr(self, "op_" + method.lower(), None)
        try:
            if handler is None:
                raise DbError("Unknown request %s" % (method,), "bad-request")
            result = handler(frame_id, params)
            send(frame_id, "OK", result or {})
        except DbError as err:
            send(frame_id, "ERR", {"message": err.text, "code": err.code, "native": err.native})
        except Exception as err:
            detail = traceback.format_exc().strip().split("\n")[-6:]
            send(frame_id, "ERR", {"message": "agent error: %s" % (err,), "code": "agent-error",
                                   "trace": detail})


class Reader(threading.Thread):
    """Reads requests. Runs beside the worker so a cancel or a closed session
    is noticed while the worker is blocked inside a client library call."""

    def __init__(self, agent, requests):
        threading.Thread.__init__(self)
        self.daemon = True
        self.agent = agent
        self.requests = requests
        self.frames = FrameReader(REQ_MARK)

    def run(self):
        pending = b""
        while True:
            try:
                data = os.read(0, 65536)
            except OSError as err:
                if err.errno == errno.EINTR:
                    continue
                data = b""
            if not data:
                # The session is gone; nobody is left to read a result.
                hard_exit(0)
            pending += data
            while True:
                cut = pending.find(b"\n")
                if cut < 0:
                    break
                line = pending[:cut]
                pending = pending[cut + 1:]
                self.on_line(line)
            if len(pending) > 4 * 1024 * 1024:
                pending = b""

    def on_line(self, line):
        frame = self.frames.feed_line(line)
        if frame is None:
            return
        if frame[0] == "error":
            send(frame[1], "ERR", {"message": frame[2], "code": "bad-frame"})
            return
        frame_id, method, params = frame
        if method == "CANCEL":
            self.cancel(frame_id)
            return
        self.requests.put((frame_id, method, params))

    def cancel(self, frame_id):
        agent = self.agent
        if agent.phase == "exec":
            # The worker is inside a blocking library call that cannot be
            # interrupted. Ending the process closes the database connection,
            # which is what stops the statement on the server.
            send(agent.active_id, "ERR", {"message": "Query cancelled", "code": "query-cancelled"})
            send(frame_id, "OK", {"cancelled": True, "exited": True})
            hard_exit(0)
        if agent.phase == "fetch":
            agent.cancel_requested = True
            send(frame_id, "OK", {"cancelled": True})
            return
        send(frame_id, "OK", {"cancelled": False})


def main():
    TTY.enter()
    agent = Agent()
    requests = queue_mod.Queue()
    send(0, "READY", agent.identity())
    Reader(agent, requests).start()
    while True:
        frame_id, method, params = requests.get()
        agent.handle(frame_id, method, params)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        hard_exit(130)
    except Exception:
        try:
            send(0, "ERR", {"message": "agent crashed: %s" % (traceback.format_exc()[-800:],),
                            "code": "agent-error"})
        finally:
            hard_exit(1)
