import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../public/", import.meta.url));
const pages = readdirSync(dir).filter((f) => f.endsWith(".html"));

test("every page links the privacy policy and terms in its footer", () => {
  for (const page of pages) {
    const footer = readFileSync(dir + page, "utf8").split("<footer>")[1] ?? "";
    assert.match(footer, /href="privacy\.html"/, `${page} footer is missing the privacy link`);
    assert.match(footer, /href="terms\.html"/, `${page} footer is missing the terms link`);
  }
});

test("privacy and terms pages exist, are dated and avoid banned wording", () => {
  for (const page of ["privacy.html", "terms.html"]) {
    const html = readFileSync(dir + page, "utf8");
    assert.match(html, /Last updated/);
    assert.doesNotMatch(html, /automat/i);
    assert.doesNotMatch(html, /arbiter/i);
  }
});

test("the sign-up form links the privacy policy and terms", () => {
  const app = readFileSync(dir + "app.js", "utf8");
  assert.match(app, /"privacy\.html"/);
  assert.match(app, /"terms\.html"/);
});
