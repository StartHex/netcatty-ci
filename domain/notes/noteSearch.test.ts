import assert from "node:assert/strict";
import test from "node:test";

import type { Host, VaultNote } from "../models";
import {
  buildNoteSearchSnippets,
  createNoteSearchIndex,
  createNoteSearchPattern,
  findNoteSearchRanges,
  noteSearchTermsKey,
  noteSearchTextMatchesAll,
  parseNoteSearchTerms,
  scanNoteSearchMatches,
  splitTextByNoteSearchRanges,
} from "./noteSearch";

const note = (overrides: Partial<VaultNote> = {}): VaultNote => ({
  id: overrides.id ?? "note-1",
  title: "Runbook",
  content: "",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

test("parseNoteSearchTerms splits words, keeps quoted phrases and drops duplicates", () => {
  assert.deepEqual(parseNoteSearchTerms(""), []);
  assert.deepEqual(parseNoteSearchTerms("   "), []);
  assert.deepEqual(parseNoteSearchTerms(" nginx  reload "), ["nginx", "reload"]);
  assert.deepEqual(parseNoteSearchTerms('"systemctl restart" nginx'), ["systemctl restart", "nginx"]);
  assert.deepEqual(parseNoteSearchTerms('"unterminated phrase'), ["unterminated phrase"]);
  assert.deepEqual(parseNoteSearchTerms("Redis redis REDIS"), ["Redis"]);
  assert.deepEqual(parseNoteSearchTerms('""  ok'), ["ok"]);
  assert.deepEqual(parseNoteSearchTerms("数据库 备份"), ["数据库", "备份"]);
});

test("createNoteSearchPattern escapes regex syntax and prefers longer terms", () => {
  assert.equal(createNoteSearchPattern([]), null);
  const pattern = createNoteSearchPattern(["a.b", "(x)"]);
  assert.ok(pattern);
  assert.deepEqual(findNoteSearchRanges("a.b axb (x)", pattern), [[0, 3], [8, 11]]);
  const overlapping = createNoteSearchPattern(["post", "postgres"]);
  assert.deepEqual(findNoteSearchRanges("postgres post", overlapping), [[0, 8], [9, 13]]);
});

test("scanNoteSearchMatches is case-insensitive, counts and caps", () => {
  const pattern = createNoteSearchPattern(["db"]);
  const scan = scanNoteSearchMatches("DB db Db dB", pattern, { maxRanges: 2, maxCount: 10 });
  assert.equal(scan.count, 4);
  assert.equal(scan.capped, false);
  assert.deepEqual(scan.ranges, [[0, 2], [3, 5]]);
  const capped = scanNoteSearchMatches("db db db", pattern, { maxCount: 2 });
  assert.equal(capped.count, 2);
  assert.equal(capped.capped, true);
  // The shared pattern must be reusable after a capped scan.
  assert.equal(scanNoteSearchMatches("db", pattern).count, 1);
});

test("splitTextByNoteSearchRanges merges overlapping and unsorted ranges", () => {
  assert.deepEqual(splitTextByNoteSearchRanges("", [[0, 1]]), []);
  assert.deepEqual(splitTextByNoteSearchRanges("hello world", []), [{ text: "hello world", highlighted: false }]);
  assert.deepEqual(splitTextByNoteSearchRanges("hello world", [[6, 11], [0, 2], [1, 4], [20, 30]]), [
    { text: "hell", highlighted: true },
    { text: "o ", highlighted: false },
    { text: "world", highlighted: true },
  ]);
});

test("buildNoteSearchSnippets groups matches per line and reports line numbers", () => {
  const text = "# Deploy\n\n- restart nginx after deploy\n```bash\nsudo systemctl reload nginx\n```";
  const pattern = createNoteSearchPattern(["nginx"]);
  const ranges = findNoteSearchRanges(text, pattern);
  const snippets = buildNoteSearchSnippets(text, ranges);
  assert.equal(snippets.length, 2);
  assert.equal(snippets[0].line, 3);
  assert.equal(snippets[0].occurrence, 0);
  assert.equal(snippets[0].matchCount, 1);
  // The list marker is skipped because the match comes after it.
  assert.equal(snippets[0].text, "restart nginx after deploy");
  assert.deepEqual(snippets[0].highlights, [[8, 13]]);
  assert.equal(snippets[0].leadingEllipsis, false);
  assert.equal(snippets[1].line, 5);
  assert.equal(snippets[1].occurrence, 1);
  assert.equal(snippets[1].text.slice(snippets[1].highlights[0][0], snippets[1].highlights[0][1]), "nginx");
});

test("buildNoteSearchSnippets trims long lines around the first match", () => {
  const prefix = "word ".repeat(30);
  const text = `${prefix}needle tail\r\nnext`;
  const ranges = findNoteSearchRanges(text, createNoteSearchPattern(["needle"]));
  const [snippet] = buildNoteSearchSnippets(text, ranges);
  assert.equal(snippet.leadingEllipsis, true);
  assert.equal(snippet.trailingEllipsis, false);
  assert.ok(snippet.text.endsWith("needle tail"), snippet.text);
  assert.ok(!snippet.text.includes("\r"));
  const [start, end] = snippet.highlights[0];
  assert.equal(snippet.text.slice(start, end), "needle");
  assert.ok(start <= 24, "the hit stays near the start so a narrow tree still shows it");
});

test("buildNoteSearchSnippets keeps several matches on one line in a single snippet", () => {
  const text = "a db and another db\nno hit\nlast db";
  const ranges = findNoteSearchRanges(text, createNoteSearchPattern(["db"]));
  const snippets = buildNoteSearchSnippets(text, ranges, 1);
  assert.equal(snippets.length, 1);
  assert.equal(snippets[0].matchCount, 2);
  assert.equal(snippets[0].highlights.length, 2);
});

test("createNoteSearchIndex matches every term across fields (AND semantics)", () => {
  const hosts = [{ id: "h1", label: "db-prod", hostname: "10.0.0.5" } as Host];
  const notes = [
    note({ id: "a", title: "Postgres failover", content: "Promote the replica, then reload pgbouncer." }),
    note({ id: "b", title: "Nginx", content: "reload nginx after editing the vhost", tags: ["web"] }),
    note({ id: "c", title: "Access", content: "jump host", linkedHostIds: ["h1"], group: "Ops/Prod" }),
  ];
  const search = createNoteSearchIndex(notes, hosts);

  assert.equal(search("").hits.size, 0);
  assert.deepEqual([...search("reload").hits.keys()], ["a", "b"]);
  assert.deepEqual([...search("reload nginx").hits.keys()], ["b"]);
  assert.deepEqual([...search("RELOAD web").hits.keys()], ["b"]);
  assert.deepEqual([...search("db-prod").hits.keys()], ["c"]);
  assert.deepEqual([...search('"then reload"').hits.keys()], ["a"]);
  assert.deepEqual([...search("missing").hits.keys()], []);

  const hit = search("nginx").hits.get("b");
  assert.ok(hit);
  assert.deepEqual(hit.titleRanges, [[0, 5]]);
  assert.equal(hit.bodyMatchCount, 1);
  assert.equal(hit.snippets.length, 1);
  assert.equal(hit.nextOccurrence, 1);
  assert.equal(search("nginx").totalMatches, 2);
});

test("createNoteSearchIndex explains folder, tag and host only matches", () => {
  const hosts = [{ id: "h1", label: "bastion", hostname: "jump.example.com" } as Host];
  const notes = [note({ id: "x", title: "Keys", content: "rotate", tags: ["security"], group: "Infra", linkedHostIds: ["h1"] })];
  const search = createNoteSearchIndex(notes, hosts);
  const hit = search("secur").hits.get("x");
  assert.ok(hit?.meta);
  assert.equal(hit.meta.text, "#security");
  assert.equal(hit.meta.text.slice(hit.meta.highlights[0][0], hit.meta.highlights[0][1]), "secur");
  assert.equal(search("bastion").hits.get("x")?.meta?.text, "bastion jump.example.com");
  assert.equal(search("rotate").hits.get("x")?.meta, undefined);
});

test("createNoteSearchIndex caps body match counts and reports the next unseen occurrence", () => {
  const content = Array.from({ length: 10 }, (_, line) => `line ${line} db`).join("\n");
  const search = createNoteSearchIndex([note({ id: "n", content })]);
  const hit = search("db", { maxBodyMatches: 5, maxSnippets: 2 }).hits.get("n");
  assert.ok(hit);
  assert.equal(hit.bodyMatchCount, 5);
  assert.equal(hit.bodyMatchCountCapped, true);
  assert.equal(hit.snippets.length, 2);
  assert.equal(hit.nextOccurrence, 2);
});

test("noteSearchTextMatchesAll and noteSearchTermsKey", () => {
  assert.equal(noteSearchTextMatchesAll("Ops/Prod", []), true);
  assert.equal(noteSearchTextMatchesAll("Ops/Prod", ["ops", "PROD"]), true);
  assert.equal(noteSearchTextMatchesAll("Ops/Prod", ["ops", "dev"]), false);
  assert.equal(noteSearchTermsKey(["a", "b"]), "a\u0000b");
  assert.notEqual(noteSearchTermsKey(["a b"]), noteSearchTermsKey(["a", "b"]));
});
