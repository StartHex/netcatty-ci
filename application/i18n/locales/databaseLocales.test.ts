import test from "node:test";
import assert from "node:assert/strict";

import { enDatabaseMessages } from "./en/database.ts";
import { zhCNDatabaseMessages } from "./zh-CN/database.ts";
import { zhTNDatabaseMessages } from "./zh-TW/database.ts";
import { ruDatabaseMessages } from "./ru/database.ts";
import { esDatabaseMessages } from "./es/database.ts";

const LOCALES = {
  en: enDatabaseMessages,
  "zh-CN": zhCNDatabaseMessages,
  "zh-TW": zhTNDatabaseMessages,
  ru: ruDatabaseMessages,
  es: esDatabaseMessages,
};

const REQUIRED_KEYS = Object.keys(enDatabaseMessages);

const PLACEHOLDER_KEYS: Record<string, string[]> = {
  "databases.count": ["{count}"],
  "databases.testOk": ["{ms}", "{version}"],
  "databases.deleteDescription": ["{label}"],
  "databases.workbench.rowCount": ["{count}"],
  "databases.workbench.pageOf": ["{page}", "{pages}"],
  "databases.workbench.elapsed": ["{ms}"],
  "databases.workbench.resultSet": ["{index}"],
  "databases.workbench.resultSetHint": ["{index}", "{line}"],
  "databases.workbench.statementOk": ["{command}"],
  "databases.workbench.statementSuccess": ["{command}"],
  "databases.workbench.rowsAffected": ["{count}"],
  "databases.transfer.exported": ["{count}"],
  "databases.transfer.exportFailed": ["{error}"],
  "databases.transfer.imported": ["{added}", "{updated}"],
  "databases.workbench.sortByColumn": ["{column}"],
  "databases.workbench.searchSelectedHint": ["{count}"],
  "databases.workbench.searchPosition": ["{index}", "{total}"],
  "databases.workbench.copySelectedColumns": ["{count}"],
  "databases.workbench.selectColumn": ["{column}"],
  "databases.workbench.deselectColumn": ["{column}"],
  "databases.workbench.copiedRows": ["{count}"],
  "databases.workbench.previewChars": ["{count}"],
  "databases.workbench.statementProgress": ["{index}", "{total}"],
  "databases.workbench.exportFailed": ["{error}"],
  "databases.testingElapsed": ["{seconds}"],
  "databases.workbench.runningElapsed": ["{seconds}"],
};

test("database messages exist in every bundled locale", () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    for (const key of REQUIRED_KEYS) {
      const value = messages[key];
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} has an empty value for ${key}`);
    }
  }
});

test("database placeholders survive translation", () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    for (const [key, placeholders] of Object.entries(PLACEHOLDER_KEYS)) {
      for (const placeholder of placeholders) {
        assert.ok(
          messages[key].includes(placeholder),
          `${locale} lost ${placeholder} in ${key}`,
        );
      }
    }
  }
});
