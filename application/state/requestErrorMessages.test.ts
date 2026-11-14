import assert from "node:assert/strict";
import test from "node:test";

import { describeHttpError } from "./useHttpClient.ts";
import { describeDatabaseError } from "./useDatabaseWorkbench.ts";

const translate = (key: string): string => `t:${key}`;

test("describeHttpError localizes known bridge codes and keeps the driver detail", () => {
  assert.equal(
    describeHttpError({ code: "timeout", message: "Request timed out", detail: "ETIMEDOUT" }, translate),
    "t:curl.errors.timeout (ETIMEDOUT)",
  );
  assert.equal(describeHttpError({ code: "cancelled", message: "x" }, translate), "t:curl.errors.cancelled");
  assert.equal(describeHttpError({ code: "weird", message: "raw message" }, translate), "raw message");
  assert.equal(describeHttpError({ code: "weird", message: "" }, translate), "t:curl.errors.unknown");
});

test("describeDatabaseError translates lifecycle codes and falls back to the driver text", () => {
  assert.equal(
    describeDatabaseError({ code: "transaction-lost", message: "English text" }, translate),
    "t:databases.workbench.transactionLost",
  );
  assert.equal(
    describeDatabaseError({ code: "query-cancelled", message: "Query cancelled" }, translate),
    "t:databases.workbench.queryCancelled",
  );
  // Without a translation (t returns the key) the bridge message is kept.
  assert.equal(
    describeDatabaseError({ code: "query-timeout", message: "Query timed out after 5 ms" }, (key) => key),
    "Query timed out after 5 ms · query-timeout",
  );
  assert.equal(
    describeDatabaseError({ message: "relation missing", sqlState: "42P01" }, translate),
    "relation missing · SQLSTATE 42P01",
  );
});
