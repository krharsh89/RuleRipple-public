import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("long request identifiers stay inside approval summary cards", () => {
  assert.match(styles, /\.comparison-summary strong \{[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.comparison-summary article \{[^}]*min-width: 0;/);
  assert.match(styles, /\.comparison-summary \.request-reference \{ font-size: 13px;/);
});

test("tablet layout keeps account switching available and preserves save warnings", () => {
  const tablet = [...styles.matchAll(/@media \(max-width: 1120px\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]).join("\n");
  assert.ok(tablet);
  assert.match(tablet, /\.topbar-actions \.account-menu \{ display: grid;/);
  assert.match(tablet, /\.cloud-pill:not\(\.cloud-error\):not\(\.cloud-saving\) \{ display: none;/);
  assert.doesNotMatch(styles, /\.account-menu\s*,\s*\.cloud-pill\s*\{\s*display:\s*none/);
});
