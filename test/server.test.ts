import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { detectStates, routeMessage } from "../src/chat/router.ts";
import { MemoryLeadSink } from "../src/leads/store.ts";
import { MemoryRunLog } from "../src/runlog/store.ts";
import type { IncomingMessage } from "node:http";
import { clientKey, createApp } from "../src/server/app.ts";

const runLog = new MemoryRunLog();
const leads = new MemoryLeadSink();
const app = createApp({ runLog, leads, useModel: false });
let base = "";

before(async () => {
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => app.close(() => resolve())));

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const estimate = {
  state: "NV",
  policyEffectiveDate: "2026-07-01",
  lines: [{ classCode: "8810", payroll: "100000", rate: "0.30" }],
};

describe("http api", () => {
  it("runs a tool and returns a full receipt", async () => {
    const res = await post("/api/tools/audit_bill_estimator", estimate);
    assert.equal(res.status, 200);
    const { receipt } = await res.json();
    assert.equal(receipt.output.totalAuditPremium.display, "$300.00");
    assert.ok(receipt.fingerprint);
  });

  it("keeps only hashes for public runs, never the input", async () => {
    const { receipt } = await (await post("/api/tools/audit_bill_estimator", estimate)).json();
    const { run } = await (await fetch(`${base}/api/runs/${receipt.runId}`)).json();
    assert.equal(run.retention, "hashes-only");
    assert.equal(run.input, undefined);
    assert.equal(run.output, undefined);
    assert.equal(run.outputHash, receipt.outputHash);
  });

  it("replays a receipt and rejects an altered one", async () => {
    const { receipt } = await (await post("/api/tools/audit_bill_estimator", estimate)).json();
    const ok = await (await post("/api/replay", { receipt })).json();
    assert.equal(ok.reproduced, true);

    receipt.outputHash = "0".repeat(64);
    const bad = await post("/api/replay", { receipt });
    assert.equal(bad.status, 409);
  });

  it("returns 400 with the field for bad input", async () => {
    const res = await post("/api/tools/audit_bill_estimator", { state: "NV", lines: [{ classCode: "8810", payroll: "x", rate: "1" }] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).field, "lines[0].payroll");
  });

  it("answers chat with the rules router when no model is configured", async () => {
    const res = await post("/api/chat", { messages: [{ role: "user", content: "compare 8810 in NV and California" }] });
    const body = await res.json();
    assert.equal(body.mode, "rules");
    assert.equal(body.receipts.length, 1);
    assert.deepEqual(body.receipts[0].input.states, ["CA", "NV"]);
  });

  it("returns sales actions from chat and accepts sign-ups", async () => {
    const chat = await (await post("/api/chat", { messages: [{ role: "user", content: "sign me up for Pro" }] })).json();
    assert.deepEqual(chat.signup, { interest: "pro" });
    const ok = await post("/api/leads", { name: "Pat", email: "pat@example.com", role: "auditor", interest: "pro", consent: true });
    assert.equal(ok.status, 200);
    assert.equal(leads.leads.length, 1);
    const bad = await post("/api/leads", { name: "Pat", email: "pat@example.com" });
    assert.equal(bad.status, 400);
  });

  it("validates chat history", async () => {
    const res = await post("/api/chat", { messages: [{ role: "assistant", content: "hi" }] });
    assert.equal(res.status, 400);
  });

  it("serves the app with security headers and blocks path traversal", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.match(await res.text(), /Penny/);
    const traversal = await fetch(base + "/..%2fpackage.json");
    assert.equal(traversal.status, 404);
  });
});

describe("rules router", () => {
  it("finds states by code or name without catching ordinary words", () => {
    assert.deepEqual(detectStates("8810 in NV and California"), ["CA", "NV"]);
    assert.deepEqual(detectStates("what is in my audit"), []);
  });

  it("opens the right tool for the question", () => {
    assert.equal(routeMessage("how much will my audit bill be?", "public").openTool?.tool, "audit_bill_estimator");
    assert.equal(routeMessage("what records do I need for the auditor", "public").openTool?.tool, "document_checklist");
    assert.equal(routeMessage("our owner takes a small salary", "public").openTool?.tool, "officer_payroll");
    assert.equal(routeMessage("what will my 2026 audit bill be", "public").openTool?.tool, "audit_bill_estimator");
  });

  it("runs a class code search from plain words", () => {
    const reply = routeMessage("what class code for janitorial in CA", "public");
    assert.equal(reply.runs.length, 1);
    assert.deepEqual(reply.runs[0]!.input, { policyEffectiveDate: reply.runs[0]!.input.policyEffectiveDate, query: "janitorial", states: ["CA"] });
  });
});

describe("client address", () => {
  const req = (xff: string | undefined) =>
    ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: "10.0.0.9" } }) as unknown as IncomingMessage;

  it("uses the proxy-appended address when behind a trusted proxy", () => {
    assert.equal(clientKey(req("6.6.6.6, 203.0.113.7"), true), "203.0.113.7");
    assert.equal(clientKey(req(undefined), true), "10.0.0.9");
  });

  it("ignores the header when not behind a proxy", () => {
    assert.equal(clientKey(req("6.6.6.6"), false), "10.0.0.9");
  });
});
