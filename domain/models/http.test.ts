import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CURL_FOLDER_SEGMENTS,
  curlFolderAncestors,
  curlFolderIsWithin,
  curlFolderJoin,
  curlFolderLeafName,
  curlFolderParentPath,
  duplicateCurlRequest,
  removeCurlFolderSubtree,
  reparentCurlFolderPath,
  rewriteCurlFolderPath,
  rewriteCurlFolders,
  rewriteCurlRequestFolders,
  sanitizeCurlFolderPath,
  sanitizeCurlFolders,
  type CurlRequest,
} from "./http.ts";

const request = (id: string, folder?: string): CurlRequest => ({
  id,
  name: id,
  folder,
  method: "GET",
  url: "https://example.com",
  params: [],
  headers: [],
  cookies: [],
  body: { kind: "none", text: "" },
  auth: { kind: "none" },
  options: {
    followRedirects: true,
    maxRedirects: 5,
    verifyTls: true,
    timeoutMs: 30000,
  },
  createdAt: 1,
  updatedAt: 1,
});

test("sanitizeCurlFolderPath trims segments and rejects the root path", () => {
  assert.equal(sanitizeCurlFolderPath("  Team / Users  "), "Team/Users");
  assert.equal(sanitizeCurlFolderPath("Team//Users/"), "Team/Users");
  assert.equal(sanitizeCurlFolderPath("   "), undefined);
  assert.equal(sanitizeCurlFolderPath(""), undefined);
  assert.equal(sanitizeCurlFolderPath(42), undefined);
  assert.equal(sanitizeCurlFolderPath(null), undefined);
});

test("sanitizeCurlFolderPath rejects paths deeper than the folder depth cap", () => {
  const deep = Array.from({ length: MAX_CURL_FOLDER_SEGMENTS + 3 }, (_, index) => `l${index}`).join("/");
  assert.equal(sanitizeCurlFolderPath(deep), undefined);
  const atCap = Array.from({ length: MAX_CURL_FOLDER_SEGMENTS }, (_, index) => `l${index}`).join("/");
  assert.equal(sanitizeCurlFolderPath(atCap), atCap);
});

test("sanitizeCurlFolders dedupes, keeps parents and sorts", () => {
  assert.deepEqual(
    sanitizeCurlFolders(["Team/Users/Admin", "Archived", " Team/Users ", "", "Team/Users"]),
    ["Archived", "Team", "Team/Users", "Team/Users/Admin"],
  );
  assert.deepEqual(sanitizeCurlFolders(["a//b/"]), ["a", "a/b"]);
  assert.deepEqual(sanitizeCurlFolders(undefined), []);
  assert.deepEqual(sanitizeCurlFolders([1, null, {}, "ok"]), ["ok"]);
});

test("curlFolderAncestors and parent/leaf helpers agree", () => {
  assert.deepEqual(curlFolderAncestors("a/b/c"), ["a", "a/b"]);
  assert.deepEqual(curlFolderAncestors("a"), []);
  assert.equal(curlFolderParentPath("a/b/c"), "a/b");
  assert.equal(curlFolderParentPath("a"), undefined);
  assert.equal(curlFolderLeafName("a/b/c"), "c");
  assert.equal(curlFolderJoin("a", "b/c"), "a/b/c");
  assert.equal(curlFolderJoin(undefined, "a"), "a");
  assert.equal(curlFolderJoin("a", ""), undefined);
});

test("curlFolderIsWithin does not treat a prefix as a descendant", () => {
  assert.equal(curlFolderIsWithin("a/b", "a"), true);
  assert.equal(curlFolderIsWithin("a", "a"), true);
  assert.equal(curlFolderIsWithin("ab", "a"), false);
  assert.equal(curlFolderIsWithin("a", "a/b"), false);
});

test("rewriteCurlFolderPath renames a folder and keeps the rest of the path", () => {
  assert.equal(rewriteCurlFolderPath("a", "a", "new"), "new");
  assert.equal(rewriteCurlFolderPath("a/b", "a", "new"), "new/b");
  assert.equal(rewriteCurlFolderPath("a/b/c", "a/b", "x/y"), "x/y/c");
  assert.equal(rewriteCurlFolderPath("other/b", "a", "new"), "other/b");
  assert.equal(rewriteCurlFolderPath("a/b", "a", undefined), "b");
});

test("rewriteCurlFolders reparents a whole subtree and drops orphan paths", () => {
  assert.deepEqual(
    rewriteCurlFolders(["a", "a/b", "a/b/c", "ab"], "a", "z"),
    ["ab", "z", "z/b", "z/b/c"],
  );
});

test("removeCurlFolderSubtree removes the folder and its descendants only", () => {
  assert.deepEqual(
    removeCurlFolderSubtree(["a", "a/b", "a/b/c", "ab", "b"], "a"),
    ["ab", "b"],
  );
});

test("reparentCurlFolderPath moves a folder under a new parent", () => {
  assert.equal(reparentCurlFolderPath("a", undefined), undefined);
  assert.equal(reparentCurlFolderPath("a", "b"), "b/a");
  assert.equal(reparentCurlFolderPath("x/a", "b"), "b/a");
  assert.equal(reparentCurlFolderPath("x/a", undefined), "a");
  assert.equal(reparentCurlFolderPath("a/b", "a/b/c"), undefined);
  assert.equal(reparentCurlFolderPath("a", "a"), undefined);
  const deepParent = "p1/p2/p3/p4/p5/p6";
  assert.equal(reparentCurlFolderPath("a", deepParent), undefined);
});

test("rewriteCurlRequestFolders rewrites members and preserves untouched requests", () => {
  const untouched = request("keep", "Other");
  const next = rewriteCurlRequestFolders(
    [request("root"), request("member", "a"), request("nested", "a/b"), untouched],
    "a",
    "new",
  );

  assert.equal(next[0], next[0]);
  assert.equal(next[0]?.folder, undefined);
  assert.equal(next[1]?.folder, "new");
  assert.equal(next[2]?.folder, "new/b");
  assert.equal(next[3], untouched);
});

test("duplicateCurlRequest inserts an independent copy right after the source", () => {
  const source = { ...request("a", "team/api"), name: "Login", lastUsedAt: 5 };
  source.headers.push({ id: "h1", key: "X-Token", value: "1", enabled: true });
  const list = [request("first"), source, request("last")];
  const next = duplicateCurlRequest(list, "a", { id: "copy-1", copyLabel: "copy", now: 42 });

  assert.deepEqual(next.map((entry) => entry.id), ["first", "a", "copy-1", "last"]);
  const copy = next[2];
  assert.equal(copy.name, "Login copy");
  assert.equal(copy.folder, "team/api");
  assert.equal(copy.createdAt, 42);
  assert.equal(copy.updatedAt, 42);
  assert.equal(copy.lastUsedAt, undefined);
  assert.deepEqual(copy.headers, source.headers);
  assert.notEqual(copy.headers, source.headers, "deep copy: editing one must not edit the other");
  assert.equal(next[1], source);
});

test("duplicateCurlRequest numbers the name when it is taken and ignores unknown ids", () => {
  const list = [{ ...request("a"), name: "Login" }, { ...request("b"), name: "Login copy" }];
  const next = duplicateCurlRequest(list, "a", { id: "c", copyLabel: "copy" });
  assert.equal(next[1].name, "Login copy 2");
  assert.equal(duplicateCurlRequest(list, "missing", { id: "x", copyLabel: "copy" }), list);
});
