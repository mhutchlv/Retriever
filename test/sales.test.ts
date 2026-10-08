import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FACTS, pageText, siteText } from "../src/chat/knowledge.ts";
import { routeMessage } from "../src/chat/router.ts";
import { MemoryLeadSink } from "../src/leads/store.ts";
import { InputError } from "../src/engine/money.ts";

const route = (text: string) => routeMessage(text, "public");

describe("homepage salesperson (rules mode)", () => {
  it("answers pricing from the plan facts", () => {
    const r = route("How much is Penny Pro?");
    assert.match(r.reply, /\$99 a month with 30 audits/);
    assert.match(r.reply, /early access/);
  });

  it("starts sign-up with the right interest", () => {
    assert.deepEqual(route("I want to sign up for Max").signup, { interest: "max" });
    assert.deepEqual(route("Book an insurer demo").signup, { interest: "insurer_demo" });
    assert.deepEqual(route("Become a partner").signup, { interest: "partner" });
    assert.deepEqual(route("Request the SOC 2 report").signup, { interest: "other" });
  });

  it("picks the demo that matches the question", () => {
    assert.equal(route("show me a demo of audit review").demo, "audit_review");
    assert.equal(route("Watch the Audit Ready demo").demo, "audit_ready");
    assert.equal(route("demo the auditor worksheet").demo, "auditor_pro");
    assert.equal(route("can I see a demo?").suggestions?.length, 3);
  });

  it("routes dispute questions to Audit Review with a demo offer", () => {
    const r = route("my audit bill is wrong");
    assert.match(r.reply, /neutral first review/);
    assert.ok(r.suggestions?.includes("Watch the Audit Review demo"));
  });

  it("keeps audit questions on the tools", () => {
    assert.equal(route("how much will my audit bill be?").openTool?.tool, "audit_bill_estimator");
    assert.equal(route("my partnership has two partners, do they count?").openTool?.tool, "officer_payroll");
  });

  it("treats a bare job word as a class code search", () => {
    const r = route("roofer");
    assert.equal(r.runs[0]?.tool, "class_code_lookup");
  });
});

describe("knowledge", () => {
  it("strips markup from site pages", () => {
    assert.equal(pageText("<p>Hi <b>there</b></p><script>x()</script><style>a{}</style>"), "Hi there");
  });

  it("includes the live site pages and authoritative facts", () => {
    const text = siteText();
    assert.match(text, /Site page: Home/);
    assert.match(text, /Your audit, accurate to the penny/);
    assert.match(FACTS, /never lower premiums/);
  });
});

describe("leads", () => {
  it("stores a valid sign-up", () => {
    const sink = new MemoryLeadSink();
    const lead = sink.add({ name: "Pat Doe", email: "Pat@Example.com", role: "auditor", interest: "pro", consent: true });
    assert.equal(lead.email, "pat@example.com");
    assert.equal(sink.leads.length, 1);
  });

  it("requires consent and a real email", () => {
    const sink = new MemoryLeadSink();
    assert.throws(() => sink.add({ name: "Pat", email: "pat@example.com" }), InputError);
    assert.throws(() => sink.add({ name: "Pat", email: "not-an-email", consent: true }), InputError);
  });
});
