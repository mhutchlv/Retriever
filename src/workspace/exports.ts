import { dollars, type Case, type CaseTotals, type CoiCoverage, type Sub } from "./model.ts";

// Work product built by deterministic code from the case and its engine runs.
// The model never writes these.

const csvCell = (v: string) => {
  // Leading = + - @ would run as a formula in Excel; prefix a quote to keep it text.
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const row = (cells: string[]) => cells.map(csvCell).join(",");

export function worksheetCsv(c: Case, t: CaseTotals): string {
  const out: string[] = [];
  out.push(row([`${c.insured} (SAMPLE)`, `Policy ${c.policyNumber}`, `${c.policyEffectiveDate} to ${c.policyExpirationDate}`, c.state]));
  out.push(row(["Description of operations", c.operations ?? ""]));
  out.push("");
  out.push(row(["Type", "Name", "Title or work", "Class", "Gross pay", "Overtime premium", "Overtime left out", "Counted", "Capped", "Source", "Set by", "Open flag"]));
  for (const l of c.lines) {
    const lc = t.lines[l.id]!;
    out.push(row(["Employee", l.payee, l.title, l.classCode, l.payroll, l.overtimePremium, lc.overtimeLeftOut.display, lc.counted.display, lc.capped ? "yes" : "", srcText(l.source), l.setBy, l.flag ?? ""]));
  }
  c.officers.forEach((o, i) => {
    const p = t.officers.people[i]!;
    out.push(row(["Officer", o.name, o.title, o.classCode, o.payroll, "", "", p.countedPayroll.display, "", srcText(o.source), o.status, p.reason]));
  });
  for (const s of c.subs) {
    out.push(row(["Subcontractor", s.name, s.work, s.classCode, s.paid, "", "", s.treatment === "uninsured" ? dollars(s.paid) : "$0.00", "", srcText(s.source), s.treatment, coverageText(t.subs[s.id]!)]));
  }
  out.push("");
  out.push(row(["Class", "Title", "Employees", "Officers", "Uninsured subs", "Total payroll", "Rate", "Premium"]));
  for (const b of t.byClass) {
    const est = t.estimate?.lines.find((l) => l.classCode === b.classCode);
    out.push(row([b.classCode, b.title, b.employees.display, b.officers.display, b.uninsuredSubs.display, b.payroll.display, est?.rate ?? "no rate", est?.premium.display ?? ""]));
  }
  if (t.estimate) {
    out.push("");
    for (const s of t.estimate.steps) out.push(row([s.label, s.detail, s.amount.display]));
    out.push(row(["Estimated audit premium", "", t.estimate.totalAuditPremium.display]));
  }
  out.push("");
  for (const r of t.runs) out.push(row(["Engine run", r.tool, r.fingerprint, r.dataStatus, r.rules.map((x) => `${x.id}@${x.version}`).join(" ")]));
  return out.join("\r\n") + "\r\n";
}

const usDate = (d: string) => {
  const [y, m, day] = d.split("-");
  return `${Number(m)}/${Number(day)}/${y}`;
};

/** "Covers the full policy term", "No certificate on file" or the uncovered dates. */
export function coverageText(cov: CoiCoverage): string {
  if (cov.status === "full") return "Covers the full policy term";
  if (cov.status === "none") return "No certificate on file";
  return `Not covered ${cov.gaps.map((g) => `${usDate(g.from)} to ${usDate(g.to)}`).join(" and ")}`;
}

/** A certificate request for one subcontractor, ready to copy into an email or letter. */
export function coiRequestText(c: Case, s: Sub, cov: CoiCoverage, from: string): { subject: string; body: string } {
  const need =
    cov.status === "none"
      ? `covering the full policy term, ${usDate(c.policyEffectiveDate)} to ${usDate(c.policyExpirationDate)}`
      : `covering ${cov.gaps.map((g) => `${usDate(g.from)} to ${usDate(g.to)}`).join(" and ")}`;
  return {
    subject: `Certificate of insurance needed: ${c.insured} workers' comp audit`,
    body: [
      `Hello ${s.name},`,
      "",
      `We're completing the workers' compensation premium audit for ${c.insured} (policy ${c.policyNumber}, ${usDate(c.policyEffectiveDate)} to ${usDate(c.policyExpirationDate)}). Their records show payments to you for ${s.work.toLowerCase()}.`,
      "",
      `Please send a certificate of insurance showing your workers' compensation coverage ${need}, with ${c.insured} as the certificate holder. If you had no employees and no coverage, please tell us that instead.`,
      "",
      `Without a certificate, those payments may be counted as payroll on ${c.insured}'s audit. Please reply by ${usDate(c.dueDate)}.`,
      "",
      "Thank you,",
      from,
      `Premium auditor for ${c.carrier}`,
    ].join("\n"),
  };
}

const srcText = (s: { doc: string; page?: number; note?: string }) => `${s.doc}${s.page ? ` p.${s.page}` : ""}${s.note ? ` (${s.note})` : ""}`;

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

interface Receipt {
  tool: string;
  fingerprint: string;
  dataStatus: string;
  rules: { id: string; version: string }[];
  engineVersion: string;
}

export function reportHtml(c: Case, t: CaseTotals, runs: Receipt[], chain: { ok: boolean; events: number; brokenAt?: number }): string {
  const e = t.estimate;
  const td = (v: unknown, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${esc(v)}</td>`;
  const findings = c.findings.filter((f) => f.status !== "rejected");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Audit report: ${esc(c.insured)}</title>
<style>
body{font-family:'IBM Plex Sans',system-ui,sans-serif;color:#15191F;max-width:900px;margin:32px auto;padding:0 16px;line-height:1.45;font-size:14px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:2px solid #15191F;padding-bottom:4px}
.sample{background:#F6E9E2;color:#7E3415;padding:8px 12px;border-radius:8px;font-weight:600;margin:12px 0}
table{width:100%;border-collapse:collapse;margin:6px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #E3E0DA;vertical-align:top}
th{font-size:12px;color:#5B5F66}td.n{text-align:right;font-family:'IBM Plex Mono',monospace;white-space:nowrap}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:4px 16px;color:#3E434A}
.ops{white-space:pre-line;margin:0}.missing{background:#FBEAE6;color:#7A2410;padding:8px 12px;border-radius:8px;margin:0}
.total td{font-weight:700;border-top:2px solid #15191F}.small{font-size:12px;color:#5B5F66}code{font-size:11px}
@media print{.sample{border:1px solid #7E3415}body{margin:0}}
</style></head><body>
<h1>Premium audit report</h1>
<div class="sample">Sample data for the Penny preview. Not a real audit.</div>
<div class="meta">
<div><b>Insured:</b> ${esc(c.insured)}</div><div><b>Policy:</b> ${esc(c.policyNumber)}</div>
<div><b>Carrier:</b> ${esc(c.carrier)}</div><div><b>State:</b> ${esc(c.state)}</div>
<div><b>Period:</b> ${esc(c.policyEffectiveDate)} to ${esc(c.policyExpirationDate)}</div><div><b>Audit type:</b> ${esc(c.auditType)}</div>
<div><b>Status:</b> ${esc(c.status)}</div><div><b>Auditor:</b> ${esc(c.assignee)}</div>
</div>
<h2>Description of operations</h2>
${c.operations?.trim() ? `<p class="ops">${esc(c.operations)}</p>` : `<p class="missing">Not written yet. The report isn't complete without a description of operations.</p>`}
<h2>Payroll by class</h2>
<table><thead><tr><th>Class</th><th>Title</th><th>Employees</th><th>Officers</th><th>Uninsured subs</th><th>Total</th><th>Rate</th><th>Premium</th></tr></thead><tbody>
${t.byClass
  .map((b) => {
    const l = e?.lines.find((x) => x.classCode === b.classCode);
    return `<tr>${td(b.classCode)}${td(b.title)}${td(b.employees.display, "n")}${td(b.officers.display, "n")}${td(b.uninsuredSubs.display, "n")}${td(b.payroll.display, "n")}${td(l?.rate ?? "no rate", "n")}${td(l?.premium.display ?? "", "n")}</tr>`;
  })
  .join("\n")}
</tbody></table>
${e ? `<h2>Premium</h2><table><tbody>${e.steps.map((s) => `<tr>${td(s.label)}${td(s.detail)}${td(s.amount.display, "n")}</tr>`).join("")}
<tr class="total">${td("Estimated audit premium")}${td("")}${td(e.totalAuditPremium.display, "n")}</tr>
${e.comparison ? `<tr>${td("Deposit premium")}${td("")}${td(e.comparison.depositPremium.display, "n")}</tr><tr>${td(e.comparison.result === "additional premium" ? "Additional premium due" : e.comparison.result === "return premium" ? "Return premium" : "No change")}${td("")}${td(e.comparison.difference.display, "n")}</tr>` : ""}
</tbody></table>` : ""}
<h2>Officers and owners</h2>
<table><thead><tr><th>Name</th><th>Title</th><th>Class</th><th>Status</th><th>Actual pay</th><th>Counted</th><th>Why</th></tr></thead><tbody>
${c.officers.map((o, i) => { const p = t.officers.people[i]!; return `<tr>${td(o.name)}${td(o.title)}${td(o.classCode)}${td(o.status)}${td(p.actualPayroll.display, "n")}${td(p.countedPayroll.display, "n")}${td(p.reason)}</tr>`; }).join("")}
</tbody></table>
${t.officers.stateRules ? `<p class="small">${esc(t.officers.stateRules.citations.join("; "))}</p>` : ""}
${c.subs.length ? `<h2>Subcontractors</h2><table><thead><tr><th>Name</th><th>Work</th><th>Class</th><th>Paid</th><th>Certificate coverage</th><th>Treatment</th></tr></thead><tbody>
${c.subs.map((s) => `<tr>${td(s.name)}${td(s.work)}${td(s.classCode)}${td(dollars(s.paid), "n")}${td(coverageText(t.subs[s.id]!))}${td(s.treatment)}</tr>`).join("")}</tbody></table>` : ""}
${findings.length ? `<h2>Findings</h2><table><tbody>${findings.map((f) => `<tr>${td(f.status)}<td><b>${esc(f.title)}</b><br>${esc(f.detail)}</td></tr>`).join("")}</tbody></table>` : ""}
${t.cap ? `<p class="small">${esc(t.cap.note)}</p>` : ""}
<h2>How these figures were produced</h2>
<p class="small">Every figure above comes from Penny's engine. Each run can be reproduced from its fingerprint and rule versions.
Change history: ${chain.ok ? `${chain.events} events, hash chain verified` : `hash chain broken at event ${chain.brokenAt}`}.</p>
<table><tbody>${runs.map((r) => `<tr>${td(r.tool)}<td><code>${esc(r.fingerprint)}</code></td>${td(r.dataStatus)}${td(r.rules.map((x) => `${x.id}@${x.version}`).join(", "))}${td(`engine ${r.engineVersion}`)}</tr>`).join("")}</tbody></table>
</body></html>`;
}
