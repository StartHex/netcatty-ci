import assert from "node:assert/strict";
import test from "node:test";

import { normalizeVaultNotes, sanitizeVaultNote } from "../notes.ts";
import type { VaultNote } from "../models.ts";
import {
  countNotesByArea,
  filterNotesForArea,
  filterNotesForList,
  getNoteArea,
  isNoteOrganizedAway,
  markNotesOrganized,
  moveNotesToArea,
  parseNoteTimeBound,
  unmarkNotesOrganized,
} from "./noteAreas.ts";
import { NOTE_SECRET_MASK, maskNoteSecrets } from "./noteSecretMask.ts";

const note = (id: string, extra: Partial<VaultNote> = {}): VaultNote => ({
  id,
  title: id,
  content: `content of ${id}`,
  createdAt: 1000,
  updatedAt: 1000,
  ...extra,
});

test("notes without an area are daily notes; the fields survive sanitizing", () => {
  assert.equal(getNoteArea(note("a")), "daily");
  assert.equal(getNoteArea(note("a", { area: "organized" })), "organized");

  const legacy = sanitizeVaultNote({ id: "old", title: "Old", content: "x", createdAt: 1, updatedAt: 2 });
  assert.equal("area" in legacy, false, "untouched notes serialize exactly as before");
  assert.equal("organizedAt" in legacy, false);

  const kept = sanitizeVaultNote({
    id: "n", title: "N", content: "", createdAt: 1, updatedAt: 2,
    area: "organized", organizedFrom: ["a", "a", " b "],
  });
  assert.equal(kept.area, "organized");
  assert.deepEqual(kept.organizedFrom, ["a", "b"]);
  const marked = sanitizeVaultNote({ id: "m", title: "M", createdAt: 1, updatedAt: 2, organizedAt: 5, organizedInto: "n" });
  assert.equal(marked.organizedAt, 5);
  assert.equal(marked.organizedInto, "n");
  // Garbage values are dropped instead of stored.
  const dirty = sanitizeVaultNote({ id: "d", title: "D", area: "nope" as never, organizedAt: Number.NaN, organizedFrom: [] });
  assert.equal("area" in dirty, false);
  assert.equal("organizedAt" in dirty, false);
  assert.equal("organizedFrom" in dirty, false);
  assert.equal(normalizeVaultNotes([kept, marked]).find((entry) => entry.id === "n")?.area, "organized");
});

test("moving between areas keeps the folder and the content", () => {
  const notes = [note("a", { group: "work/db" }), note("b"), note("c", { area: "organized" })];
  const moved = moveNotesToArea(notes, ["a", "c", "missing"], "organized", { now: 9 });
  assert.deepEqual(moved.movedIds, ["a"], "c is already there");
  const a = moved.notes.find((entry) => entry.id === "a")!;
  assert.equal(a.area, "organized");
  assert.equal(a.group, "work/db");
  assert.equal(a.content, "content of a");
  assert.equal(a.updatedAt, 9);

  const back = moveNotesToArea(moved.notes, ["a"], "daily", { now: 10 });
  assert.equal("area" in back.notes.find((entry) => entry.id === "a")!, false);
  // Nothing to do returns the same array, so callers can skip a save.
  assert.equal(moveNotesToArea(notes, ["b"], "daily").notes, notes);
  // An explicit folder is applied; an empty string clears it.
  assert.equal(moveNotesToArea(notes, ["b"], "organized", { group: "weekly" }).notes[1].group, "weekly");
  assert.equal(moveNotesToArea(notes, ["a"], "organized", { group: "" }).notes[0].group, undefined);
});

test("organizing keeps the originals in the daily area, marked and linked", () => {
  const notes = [note("d1"), note("d2"), note("d3"), note("sum", { area: "organized" })];
  const result = markNotesOrganized(notes, ["d1", "d2", "sum", "ghost"], "sum", 50);
  assert.deepEqual(result.markedIds, ["d1", "d2"]);
  const d1 = result.notes.find((entry) => entry.id === "d1")!;
  assert.equal(getNoteArea(d1), "daily", "the original never leaves the daily area");
  assert.equal(d1.content, "content of d1", "and keeps its text");
  assert.equal(d1.organizedAt, 50);
  assert.equal(d1.organizedInto, "sum");
  assert.equal(isNoteOrganizedAway(d1), true);
  assert.deepEqual(result.notes.find((entry) => entry.id === "sum")!.organizedFrom, ["d1", "d2"]);
  assert.equal(isNoteOrganizedAway(result.notes.find((entry) => entry.id === "d3")!), false);

  // Hidden by default in the daily view, still there when asked for.
  assert.deepEqual(filterNotesForArea(result.notes, "daily", { hideOrganizedAway: true }).map((entry) => entry.id), ["d3"]);
  assert.deepEqual(filterNotesForArea(result.notes, "daily").map((entry) => entry.id), ["d1", "d2", "d3"]);
  assert.deepEqual(filterNotesForArea(result.notes, "organized").map((entry) => entry.id), ["sum"]);
  assert.deepEqual(countNotesByArea(result.notes), { daily: 3, dailyPending: 1, organized: 1 });

  const undone = unmarkNotesOrganized(result.notes, ["d1"]);
  assert.deepEqual(undone.unmarkedIds, ["d1"]);
  assert.equal(isNoteOrganizedAway(undone.notes.find((entry) => entry.id === "d1")!), false);
  assert.deepEqual(undone.notes.find((entry) => entry.id === "sum")!.organizedFrom, ["d2"]);
  // Moving a marked note by hand makes it a normal note again.
  const promoted = moveNotesToArea(result.notes, ["d2"], "organized", { now: 60 });
  assert.equal("organizedAt" in promoted.notes.find((entry) => entry.id === "d2")!, false);
});

test("list filters: area, folder subtree, dates, organized state, limit", () => {
  const notes = [
    note("old", { updatedAt: 100, createdAt: 100 }),
    note("today1", { updatedAt: 500, createdAt: 450, group: "work" }),
    note("today2", { updatedAt: 600, createdAt: 550, group: "work/db" }),
    note("done", { updatedAt: 700, createdAt: 500, organizedAt: 800 }),
    note("sum", { updatedAt: 900, createdAt: 900, area: "organized", group: "workshop" }),
  ];
  const ids = (filter: Parameters<typeof filterNotesForList>[1]) => filterNotesForList(notes, filter).notes.map((entry) => entry.id);
  assert.deepEqual(ids({}), ["sum", "done", "today2", "today1", "old"], "newest first");
  assert.deepEqual(ids({ area: "daily" }), ["done", "today2", "today1", "old"]);
  assert.deepEqual(ids({ area: "daily", organized: false }), ["today2", "today1", "old"]);
  assert.deepEqual(ids({ organized: true }), ["done"]);
  assert.deepEqual(ids({ group: "work" }), ["today2", "today1"], "subfolders included, 'workshop' is not");
  assert.deepEqual(ids({ updatedAfter: 500, updatedBefore: 700 }), ["today2", "today1"]);
  assert.deepEqual(ids({ createdAfter: 500, createdBefore: 600 }), ["done", "today2"]);
  const limited = filterNotesForList(notes, { limit: 2 });
  assert.deepEqual(limited.notes.map((entry) => entry.id), ["sum", "done"]);
  assert.equal(limited.total, 5);
  assert.equal(limited.truncated, true);
});

test("time bounds accept epoch milliseconds and ISO dates", () => {
  assert.equal(parseNoteTimeBound(1731283200000), 1731283200000);
  assert.equal(parseNoteTimeBound("1731283200000"), 1731283200000);
  assert.equal(parseNoteTimeBound("2026-11-11"), new Date(2026, 10, 11).getTime(), "a bare date is local midnight");
  assert.equal(parseNoteTimeBound("2026-11-11T08:00:00Z"), Date.UTC(2026, 10, 11, 8));
  for (const bad of ["", "yesterday", null, undefined, {}, -5]) assert.equal(parseNoteTimeBound(bad), null);
});

test("secret masking hides labelled credentials and keeps the rest readable", () => {
  const masked = (text: string) => maskNoteSecrets(text).text;
  assert.equal(masked("root 密码：Uf7,Ly2<c8"), `root 密码：${NOTE_SECRET_MASK}`, "punctuation inside a password is masked too");
  assert.equal(masked("账号：root，密码：abc123，端口：22"), `账号：root，密码：${NOTE_SECRET_MASK}，端口：22`);
  assert.equal(masked("password: hunter2 for db01"), `password: ${NOTE_SECRET_MASK} for db01`);
  assert.equal(masked("**Password**: `s3cr3t`"), `**Password**: \`${NOTE_SECRET_MASK}\``);
  assert.equal(masked("API_KEY=abc123def"), `API_KEY=${NOTE_SECRET_MASK}`);
  assert.equal(masked("token = ghp_xxxxxxxxxxxxxxxxxxxx"), `token = ${NOTE_SECRET_MASK}`);
  assert.equal(masked("mysql://app:pa55@10.0.0.8:3306/shop"), `mysql://app:${NOTE_SECRET_MASK}@10.0.0.8:3306/shop`);
  assert.equal(masked("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc"), `Authorization: Bearer ${NOTE_SECRET_MASK}`);
  assert.equal(
    masked("key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\nafter"),
    `key:\n${NOTE_SECRET_MASK}\nafter`,
  );
  assert.equal(masked("mysql -u root -p hunter2 -h db"), `mysql -u root -p ${NOTE_SECRET_MASK} -h db`);
  assert.equal(masked("mysqldump -uroot -pS3cret shop > a.sql"), `mysqldump -uroot -p${NOTE_SECRET_MASK} shop > a.sql`);
  assert.equal(masked("redis-cli -h 10.0.0.9 -a r3dis ping"), `redis-cli -h 10.0.0.9 -a ${NOTE_SECRET_MASK} ping`);

  // Not secrets: prose about passwords, ports, ordinary key/value lines.
  for (const text of [
    "记得周五改密码",
    "ssh -p 2222 root@10.0.0.8",
    "mkdir -p /data/backup && tar -a -cf x.tar.zst .",
    "服务器：10.0.0.8\n端口：22\n账号：root",
    "the keyboard token ring is old",
    "passport office opens at 9",
  ]) {
    assert.deepEqual(maskNoteSecrets(text), { text, maskedCount: 0 }, text);
  }
  assert.equal(maskNoteSecrets("密码: a\npwd=b").maskedCount, 2);
  // Idempotent.
  const once = masked("password: hunter2");
  assert.equal(masked(once), once);
});
