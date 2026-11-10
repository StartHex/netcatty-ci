import test from "node:test";
import assert from "node:assert/strict";

import { enCurlMessages } from "./en/curl.ts";
import { zhCNCurlMessages } from "./zh-CN/curl.ts";
import { zhTWCurlMessages } from "./zh-TW/curl.ts";
import { ruCurlMessages } from "./ru/curl.ts";
import { esCurlMessages } from "./es/curl.ts";

const LOCALES = {
  en: enCurlMessages,
  "zh-CN": zhCNCurlMessages,
  "zh-TW": zhTWCurlMessages,
  ru: ruCurlMessages,
  es: esCurlMessages,
};

const REQUIRED_KEYS = Object.keys(enCurlMessages);

const PLACEHOLDER_KEYS: Record<string, string[]> = {
  "curl.count": ["{count}"],
  "curl.deleteConfirmMessage": ["{name}"],
  "curl.folderDeleteMessage": ["{name}"],
  "curl.response.redirects": ["{count}"],
  "curl.body.invalidJson": ["{error}"],
  "curl.sendingElapsed": ["{seconds}"],
  "curl.response.largeBodyNotice": ["{size}"],
  "curl.json.showMore": ["{count}"],
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
