import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatBudget, costMicros, limitsFromEnv, SONNET_5_5 } from "../src/chat/budget.ts";
import { trimHistory, type ChatTurn } from "../src/chat/claude.ts";

const limits = { dailyUsd: 1, perVisitorUsd: 0.1, perVisitorMessages: 3, maxConcurrent: 2 };

test("prices usage from the API's token counts", () => {
  // 1,000 input ($0.002) + 500 output ($0.005) + 10,000 cache reads ($0.002) = $0.009
  assert.equal(costMicros({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10_000 }, SONNET_5_5), 9000);
  // cache writes at 1.25x input
  assert.equal(costMicros({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }, SONNET_5_5), 2_500_000);
});

test("caps messages per visitor per day", () => {
  const b = new ChatBudget({ limits });
  for (let i = 0; i < 3; i++) {
    const t = b.begin("1.2.3.4");
    assert.ok(t.ok);
    if (t.ok) b.finish(t.visitor, 0, 1);
  }
  assert.deepEqual(b.begin("1.2.3.4"), { ok: false, reason: "visitor_messages" });
  assert.ok(b.begin("5.6.7.8").ok, "another visitor is unaffected");
});

test("caps spend per visitor and for the whole site", () => {
  const b = new ChatBudget({ limits });
  const t = b.begin("a");
  assert.ok(t.ok);
  if (t.ok) b.finish(t.visitor, 100_000, 1); // $0.10, the visitor cap
  assert.deepEqual(b.begin("a"), { ok: false, reason: "visitor_budget" });

  for (let i = 0; i < 9; i++) {
    const v = b.begin(`v${i}`);
    assert.ok(v.ok);
    if (v.ok) b.finish(v.visitor, 100_000, 1);
  }
  assert.deepEqual(b.begin("someone-new"), { ok: false, reason: "daily_budget" });
});

test("limits calls in flight", () => {
  const b = new ChatBudget({ limits });
  assert.ok(b.begin("a").ok);
  assert.ok(b.begin("b").ok);
  assert.deepEqual(b.begin("c"), { ok: false, reason: "busy" });
});

test("resets at the next UTC day", () => {
  let now = Date.parse("2026-10-08T23:59:00Z");
  const b = new ChatBudget({ limits, clock: () => now });
  for (let i = 0; i < 3; i++) {
    const t = b.begin("a");
    if (t.ok) b.finish(t.visitor, 0, 1);
  }
  assert.equal(b.begin("a").ok, false);
  now = Date.parse("2026-10-09T00:01:00Z");
  assert.ok(b.begin("a").ok);
});

test("survives a restart and never writes raw addresses", () => {
  const file = join(mkdtempSync(join(tmpdir(), "penny-")), "budget.json");
  const clock = () => Date.parse("2026-10-08T12:00:00Z");
  const first = new ChatBudget({ limits, file, clock });
  const t = first.begin("203.0.113.9");
  if (t.ok) first.finish(t.visitor, 250_000, 2);
  assert.doesNotMatch(readFileSync(file, "utf8"), /203\.0\.113\.9/);

  const second = new ChatBudget({ limits, file, clock });
  assert.equal(second.snapshot().spentUsd, 0.25);
  assert.deepEqual(second.begin("203.0.113.9"), { ok: false, reason: "visitor_budget" });
});

test("reads limits from the environment, ignoring bad values", () => {
  const l = limitsFromEnv({ PENNY_CHAT_DAILY_USD: "25", PENNY_CHAT_VISITOR_USD: "abc" });
  assert.equal(l.dailyUsd, 25);
  assert.equal(l.perVisitorUsd, 0.5);
});

test("sends only recent turns to the model, starting with the visitor", () => {
  const long: ChatTurn[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }));
  const kept = trimHistory(long);
  assert.ok(kept.length <= 12);
  assert.equal(kept[0]?.role, "user");
  assert.equal(kept.at(-1)?.content, "turn 29");

  const huge: ChatTurn[] = [
    { role: "user", content: "x".repeat(4000) },
    { role: "assistant", content: "y".repeat(4000) },
    { role: "user", content: "z".repeat(4000) },
    { role: "assistant", content: "w".repeat(4000) },
    { role: "user", content: "latest" },
  ];
  const trimmed = trimHistory(huge);
  assert.equal(trimmed.at(-1)?.content, "latest");
  assert.ok(trimmed.reduce((n, t) => n + t.content.length, 0) <= 12_000);
});
