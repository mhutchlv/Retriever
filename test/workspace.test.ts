import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Auth, hashPassword, verifyPassword, accountsFromEnv } from "../src/auth/auth.ts";
import { MemoryLeadSink } from "../src/leads/store.ts";
import { MemoryRunLog } from "../src/runlog/store.ts";
import { createApp } from "../src/server/app.ts";
import { coiRequestText, reportHtml, worksheetCsv } from "../src/workspace/exports.ts";
import { computeCase } from "../src/workspace/model.ts";
import { verifyTimeline, WorkspaceStore } from "../src/workspace/store.ts";

const PASSWORD = "test-only-pass";
const accounts = [{ username: "tester", displayName: "Test Auditor", role: "auditor" as const, passwordHash: hashPassword(PASSWORD) }];

describe("auth", () => {
  it("verifies scrypt hashes and rejects wrong passwords", () => {
    const h = hashPassword("abc123!");
    assert.ok(verifyPassword("abc123!", h));
    assert.ok(!verifyPassword("abc123", h));
  });

  it("locks an account after repeated failures", () => {
    const auth = new Auth(accounts);
    for (let i = 0; i < 8; i++) assert.equal(auth.login("tester", "nope").ok, false);
    assert.deepEqual(auth.login("tester", PASSWORD), { ok: false, reason: "locked" });
  });

  it("expires sessions and signs out", () => {
    let now = 0;
    const auth = new Auth(accounts, () => now);
    const r = auth.login("TESTER", PASSWORD);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(auth.user(r.token)?.username, "tester");
    now = 9 * 3600 * 1000;
    assert.equal(auth.user(r.token), undefined);
  });

  it("reads accounts from the environment and skips bad ones", () => {
    const list = accountsFromEnv(JSON.stringify([...accounts, { username: "x" }, { username: "ok_name", passwordHash: "plain" }]));
    assert.equal(list.length, 1);
  });
});

describe("workspace store", () => {
  it("applies Nevada's per-employee cap and officer limits on the sample case", () => {
    const store = new WorkspaceStore();
    const c = store.get("tester", "DRL-2026")!;
    const t = computeCase(c, "ws:tester");
    assert.equal(t.lines.L1!.capped, true);
    assert.equal(t.lines.L1!.counted.display, "$36,000.00");
    assert.equal(t.officers.people[1]!.countedPayroll.display, "$6,000.00");
    assert.ok(t.estimate);
  });

  it("records a change with before, after, reason and premium effect, and undoes it", () => {
    const store = new WorkspaceStore();
    const e = store.apply("tester", "DRL-2026", { type: "update_line", lineId: "L7", classCode: "8742", reason: "Outside sales per job description" }, "Test Auditor", "workspace");
    assert.deepEqual(e.before, { classCode: "8810", flag: e.before!.flag, setBy: "penny" });
    assert.equal(e.after!.classCode, "8742");
    assert.ok(e.premium && e.premium.before !== e.premium.after);
    const c = store.get("tester", "DRL-2026")!;
    assert.equal(c.lines.find((l) => l.id === "L7")!.flag, undefined);

    store.apply("tester", "DRL-2026", { type: "undo", seq: e.seq }, "Test Auditor", "workspace");
    const back = store.get("tester", "DRL-2026")!.lines.find((l) => l.id === "L7")!;
    assert.equal(back.classCode, "8810");
    assert.ok(back.flag);
    assert.deepEqual(verifyTimeline(store.get("tester", "DRL-2026")!), { ok: true, events: e.seq + 1 });
  });

  it("previews without changing anything", () => {
    const store = new WorkspaceStore();
    const card = store.preview("tester", "DRL-2026", { type: "set_sub", subId: "S1", treatment: "uninsured", reason: "Certificate lapsed" }, "Penny");
    assert.ok(card.premium?.change.startsWith("+"));
    assert.equal(store.get("tester", "DRL-2026")!.subs[0]!.treatment, "insured");
  });

  it("detects an edited timeline", () => {
    const store = new WorkspaceStore();
    const c = store.get("tester", "DRL-2026")!;
    c.timeline[1]!.summary = "edited";
    assert.equal(verifyTimeline(c).ok, false);
  });

  it("keeps workspaces apart", () => {
    const store = new WorkspaceStore();
    store.apply("a-user", "SRR-2026", { type: "set_status", status: "Records received" }, "A", "workspace");
    assert.equal(store.get("b-user", "SRR-2026")!.status, "Records requested");
  });

  it("writes CSV cells that Excel won't run as formulas", () => {
    const store = new WorkspaceStore();
    const c = structuredClone(store.get("tester", "DRL-2026")!);
    c.lines[0]!.payee = "=HYPERLINK(\"x\")";
    assert.match(worksheetCsv(c, computeCase(c, "ws:tester")), /"'=HYPERLINK\(""x""\)"/);
  });
});

describe("workspace http", () => {
  const runLog = new MemoryRunLog();
  const app = createApp({ runLog, leads: new MemoryLeadSink(), useModel: false, auth: new Auth(accounts), workspace: new WorkspaceStore() });
  let base = "";
  let cookie = "";
  before(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => app.close(() => r())));

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, ...headers }, body: JSON.stringify(body) });

  it("refuses the workspace before sign-in", async () => {
    assert.equal((await fetch(base + "/api/workspace/cases")).status, 401);
  });

  it("rejects a wrong password without saying which part was wrong", async () => {
    const res = await post("/api/auth/login", { username: "tester", password: "wrong" });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /don't match/);
  });

  it("signs in with an HttpOnly, SameSite=Strict cookie", async () => {
    const res = await post("/api/auth/login", { username: "tester", password: PASSWORD });
    assert.equal(res.status, 200);
    const set = res.headers.get("set-cookie")!;
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    cookie = set.split(";")[0]!;
  });

  it("lists cases and applies an action", async () => {
    const list = await (await fetch(base + "/api/workspace/cases", { headers: { Cookie: cookie } })).json();
    assert.equal(list.cases.length, 4);
    const res = await post("/api/workspace/cases/DRL-2026/actions", { action: { type: "set_finding", findingId: "F4", status: "accepted" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.case.findings.find((f: { id: string }) => f.id === "F4").status, "accepted");
    assert.equal(body.timelineCheck.ok, true);
  });

  it("requires a reason for changes that move money", async () => {
    const res = await post("/api/workspace/cases/DRL-2026/actions", { action: { type: "update_line", lineId: "L1", payroll: "1" } });
    assert.equal(res.status, 400);
  });

  it("refuses cross-site posts", async () => {
    const res = await post("/api/workspace/cases/DRL-2026/actions", { action: { type: "add_note", text: "x" } }, { Origin: "https://evil.example" });
    assert.equal(res.status, 403);
  });

  it("shows a workspace run only to its own workspace", async () => {
    const view = await (await fetch(base + "/api/workspace/cases/DRL-2026", { headers: { Cookie: cookie } })).json();
    const runId = view.totals.runs[0].runId;
    assert.equal((await fetch(`${base}/api/runs/${runId}`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/runs/${runId}`)).status, 404);
  });

  it("serves the worksheet and the report", async () => {
    const csv = await fetch(base + "/api/workspace/cases/DRL-2026/worksheet.csv", { headers: { Cookie: cookie } });
    assert.match(csv.headers.get("content-type")!, /text\/csv/);
    const report = await (await fetch(base + "/api/workspace/cases/DRL-2026/report", { headers: { Cookie: cookie } })).text();
    assert.match(report, /Sample data for the Penny preview/);
  });

  it("signs out", async () => {
    await post("/api/auth/logout", {});
    assert.equal((await fetch(base + "/api/workspace/cases", { headers: { Cookie: cookie } })).status, 401);
  });
});

describe("description of operations", () => {
  it("is required before Draft ready, recorded and undoable", () => {
    const store = new WorkspaceStore();
    assert.throws(() => store.apply("tester", "SRR-2026", { type: "set_status", status: "Draft ready" }, "T", "workspace"), /description of operations/);
    const e = store.apply("tester", "SRR-2026", { type: "set_operations", text: "Residential and commercial roofing." }, "T", "workspace");
    assert.deepEqual(e.before, { operations: "" });
    store.apply("tester", "SRR-2026", { type: "set_status", status: "Draft ready" }, "T", "workspace");
    assert.equal(store.get("tester", "SRR-2026")!.status, "Draft ready");
  });

  it("appears in the report, or the report says it's missing", () => {
    const store = new WorkspaceStore();
    const done = store.get("tester", "DRL-2026")!;
    assert.match(reportHtml(done, computeCase(done, "ws:tester"), [], { ok: true, events: 1 }), /Landscape installation and maintenance/);
    const missing = store.get("tester", "SRR-2026")!;
    assert.match(reportHtml(missing, computeCase(missing, "ws:tester"), [], { ok: true, events: 1 }), /Not written yet/);
  });
});

describe("subcontractor certificates", () => {
  it("finds gaps in certificate coverage over the policy term", () => {
    const store = new WorkspaceStore();
    const c = store.get("tester", "DRL-2026")!;
    const t = computeCase(c, "ws:tester");
    assert.deepEqual(t.subs.S1, { status: "partial", gaps: [{ from: "2026-03-31", to: "2026-10-01" }] });
    assert.deepEqual(t.subs.S2, { status: "full", gaps: [] });
    assert.equal(t.subs.S3!.status, "none");
    const h = store.get("tester", "HEC-2026")!;
    assert.deepEqual(computeCase(h, "ws:tester").subs.S1!.gaps, [{ from: "2026-08-01", to: "2026-08-15" }]);
  });

  it("drafts a request for the uncovered dates and records it", () => {
    const store = new WorkspaceStore();
    const c = store.get("tester", "DRL-2026")!;
    const t = computeCase(c, "ws:tester");
    const req = coiRequestText(c, c.subs[0]!, t.subs.S1!, "Test Auditor");
    assert.match(req.body, /covering 3\/31\/2026 to 10\/1\/2026/);
    assert.match(req.body, /Desert Ridge Landscaping LLC as the certificate holder/);
    const e = store.apply("tester", "DRL-2026", { type: "request_coi", subId: "S3" }, "Test Auditor", "workspace");
    assert.match(e.summary, /Mesa Concrete Curbing/);
    assert.ok(store.get("tester", "DRL-2026")!.subs[2]!.coiRequestedAt);
  });
});
