// Penny front end. All user and server text goes through textContent, never innerHTML.

const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

const TOOL_INFO = {
  class_code_lookup: { title: "Class code lookup and compare", blurb: "Search codes by plain words, or compare one code across states." },
  audit_bill_estimator: { title: "Audit bill estimator", blurb: "Payroll and rates by class to an expected audit result, step by step." },
  officer_payroll: { title: "Officer payroll calculator", blurb: "What officer and owner pay counts, with state minimums and maximums." },
  document_checklist: { title: "Audit document checklist", blurb: "The records to gather for your business, and why each one matters." },
};

// ---------- DOM helper ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const field = (label, input) => h("label", { class: "field" }, h("span", {}, label), input);
const stateSelect = (name, value, { optional = false } = {}) =>
  h("select", { name },
    optional ? h("option", { value: "" }, "Any state") : null,
    STATES.map((s) => h("option", { value: s, selected: s === value }, s)));

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Result rendering ----------

function table(headers, rows, numericCols = []) {
  return h("div", { class: "table-wrap" },
    h("table", {},
      h("thead", {}, h("tr", {}, headers.map((t, i) => h("th", { class: numericCols.includes(i) ? "num" : undefined }, t)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c, i) => h("td", { class: numericCols.includes(i) ? "num" : undefined }, c)))))));
}

function warnings(list) {
  if (!list || !list.length) return null;
  return h("ul", { class: "warnings" }, list.map((w) => h("li", {}, w)));
}

const RENDER = {
  class_code_lookup(out) {
    const parts = [];
    if (out.comparison && out.comparison.byState.length) {
      parts.push(table(["State", "Governed by", `Class ${out.comparison.code}`],
        out.comparison.byState.map((s) => [
          `${s.stateName} (${s.state})`,
          s.bureau,
          s.found
            ? s.title
            : s.equivalent
              ? `Not used here. Closest code: ${s.equivalent.code}${s.equivalent.title ? ` (${s.equivalent.title})` : ""}. ${s.equivalent.note}`
              : s.note || "Not found",
        ])));
    }
    if (out.matches.length && (!out.comparison || !out.comparison.byState.length)) {
      parts.push(table(["Code", "Title", "Table"], out.matches.map((m) => [m.code, m.title, m.system])));
    }
    if (out.notes.length) parts.push(warnings(out.notes));
    return parts;
  },

  audit_bill_estimator(out) {
    const parts = [h("div", { class: "big" }, out.totalAuditPremium.display)];
    if (out.comparison) {
      const c = out.comparison;
      parts.push(h("p", { class: "sub" },
        c.result === "no change"
          ? `Matches the deposit premium of ${c.depositPremium.display}.`
          : `Likely ${c.result} of ${c.difference.display} against the deposit premium of ${c.depositPremium.display}.`));
    } else {
      parts.push(h("p", { class: "sub" }, "Estimated audit premium."));
    }
    parts.push(h("h4", {}, "By class"));
    parts.push(table(["Class", "Payroll", "Rate per $100", "Premium"],
      out.lines.map((l) => [l.description ? `${l.classCode} ${l.description}` : l.classCode, l.payroll.display, l.rate, l.premium.display]), [1, 2, 3]));
    parts.push(h("h4", {}, "How it adds up"));
    parts.push(table(["Step", "How", "Amount"], out.steps.map((s) => [s.label, s.detail, s.amount.display]), [2]));
    if (out.drivers.length) {
      parts.push(h("h4", {}, "What moves your bill"));
      parts.push(h("ul", {}, out.drivers.map((d) => h("li", {}, `Each $10,000 of payroll in class ${d.classCode} changes the bill by ${d.per10kPayroll.display}.`))));
    }
    parts.push(warnings(out.warnings));
    return parts;
  },

  officer_payroll(out) {
    return [
      h("div", { class: "big" }, out.totalCountedPayroll.display),
      h("p", { class: "sub" }, "Officer and owner payroll counted on the audit."),
      table(["Person", "Actual pay", "Counted", "Why"],
        out.people.map((p) => [p.name, p.actualPayroll.display, p.countedPayroll.display, p.reason]), [1, 2]),
      out.limits.minimum
        ? h("p", { class: "sub" }, `Limits used (${out.limits.source}, ${out.limits.proratedFor}): minimum ${out.limits.minimum.display}, maximum ${out.limits.maximum.display}, owner amount ${out.limits.ownerAmount.display}.`)
        : null,
      warnings(out.warnings),
    ];
  },

  document_checklist(out) {
    return [
      h("p", { class: "sub" }, `${out.counts.required} required and ${out.counts.recommended} recommended items. Tick them off as you go.`),
      out.groups.map((g) => [
        h("h4", {}, g.group),
        h("ul", { class: "checklist" }, g.items.map((i) =>
          h("li", {},
            h("input", { type: "checkbox", "aria-label": i.label }),
            h("div", {}, i.label, i.priority === "recommended" ? " (recommended)" : "", h("small", {}, i.why))))),
      ]),
      h("h4", {}, "Tips"),
      h("ul", {}, out.tips.map((t) => h("li", {}, t))),
    ];
  },
};

function saveReceipt(receipt) {
  const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: `penny-receipt-${receipt.runId.slice(0, 8)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function resultCard(receipt) {
  const status = h("span", { class: "badge badge-muted" }, "Not verified yet");
  const verify = h("button", {
    type: "button",
    class: "btn btn-ghost btn-small",
    async onclick() {
      verify.disabled = true;
      try {
        const r = await api("/api/replay", { receipt });
        status.className = `badge ${r.reproduced ? "badge-success" : "badge-warning"}`;
        status.textContent = r.reproduced ? "Verified: same answer on re-run" : `Did not match: ${r.reason}`;
      } catch (err) {
        status.className = "badge badge-warning";
        status.textContent = err.message;
      } finally {
        verify.disabled = false;
      }
    },
  }, "Verify");

  const rules = receipt.rules.map((r) => `${r.id}@${r.version}`).join(", ");
  return h("article", { class: "result" },
    h("div", { class: "result-head" },
      h("h3", {}, TOOL_INFO[receipt.tool]?.title ?? receipt.tool),
      receipt.dataStatus === "sample" ? document.getElementById("sample-note").content.cloneNode(true) : null),
    RENDER[receipt.tool](receipt.output),
    h("div", { class: "provenance" },
      h("span", {}, "Run ", h("code", {}, receipt.runId.slice(0, 8)), ` · engine ${receipt.engineVersion} · rules ${rules}`),
      h("span", { class: "actions" }, status, verify,
        h("button", { type: "button", class: "btn btn-ghost btn-small", onclick: () => saveReceipt(receipt) }, "Save receipt"))));
}

// ---------- Chat ----------

const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const history = [];

async function ask(text) {
  const message = text.trim();
  if (!message) return;
  history.push({ role: "user", content: message });
  messagesEl.append(h("div", { class: "msg msg-user" }, message));
  const pending = h("div", { class: "msg msg-penny" }, h("p", {}, "Working on it..."));
  messagesEl.append(pending);
  const button = chatForm.querySelector("button");
  button.disabled = true;
  try {
    const data = await api("/api/chat", { messages: history.slice(-20) });
    history.push({ role: "assistant", content: data.reply });
    pending.replaceChildren(h("p", {}, data.reply), ...(data.receipts || []).map(resultCard));
    if (data.openTool) openTool(data.openTool.tool, data.openTool.prefill || {});
  } catch (err) {
    history.pop();
    pending.replaceChildren(h("p", { class: "msg-error" }, err.message));
  } finally {
    button.disabled = false;
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value;
  chatInput.value = "";
  ask(text);
});
document.getElementById("suggestions").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-ask]");
  if (chip) ask(chip.dataset.ask);
});

// ---------- Tool forms ----------

const grid = document.getElementById("tool-grid");
const panel = document.getElementById("tool-panel");
const cards = {};

for (const [name, info] of Object.entries(TOOL_INFO)) {
  cards[name] = h("button", { type: "button", class: "tool-card", "aria-expanded": "false", "aria-controls": "tool-panel", onclick: () => openTool(name, {}) },
    h("strong", {}, info.title), h("span", {}, info.blurb));
  grid.append(cards[name]);
}

const today = () => new Date().toISOString().slice(0, 10);
const val = (form, name) => form.elements.namedItem(name)?.value?.trim() ?? "";
const checked = (form, name) => Boolean(form.elements.namedItem(name)?.checked);
const splitList = (s) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function lineRow() {
  const row = h("div", { class: "row row-lines" },
    h("input", { name: "classCode", placeholder: "8810", inputmode: "numeric", "aria-label": "Class code", required: true }),
    h("input", { name: "description", placeholder: "Description (optional)", "aria-label": "Description" }),
    h("input", { name: "payroll", placeholder: "Payroll $", inputmode: "decimal", "aria-label": "Payroll", required: true }),
    h("input", { name: "rate", placeholder: "Rate", inputmode: "decimal", "aria-label": "Rate per $100", required: true }),
    h("button", { type: "button", class: "remove", "aria-label": "Remove line", onclick: () => row.remove() }, "×"));
  return row;
}

function personRow() {
  const row = h("div", { class: "row row-people" },
    h("input", { name: "name", placeholder: "Name", "aria-label": "Name", required: true }),
    h("input", { name: "payroll", placeholder: "Pay received $", inputmode: "decimal", "aria-label": "Pay received", required: true }),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "included", checked: true }), "Included"),
    h("button", { type: "button", class: "remove", "aria-label": "Remove person", onclick: () => row.remove() }, "×"));
  return row;
}

const rowValues = (container) => [...container.querySelectorAll(".row")].map((row) => {
  const get = (n) => row.querySelector(`[name="${n}"]`);
  return { get, value: (n) => get(n)?.value?.trim() ?? "" };
});

const FORMS = {
  class_code_lookup(prefill) {
    const form = h("form", {},
      h("div", { class: "form-grid" },
        field("Words or a code", h("input", { name: "q", placeholder: "janitorial, plumber, 8810", value: prefill.query || prefill.code || "", required: true })),
        field("States (optional)", h("input", { name: "states", placeholder: "NV, CA", value: (prefill.states || (prefill.state ? [prefill.state] : [])).join(", ") }))));
    const build = () => {
      const q = val(form, "q");
      const states = splitList(val(form, "states").toUpperCase());
      return /^\d{3,4}$/.test(q) ? { code: q, states } : { query: q, states };
    };
    return { form, build };
  },

  audit_bill_estimator(prefill) {
    const lines = h("div", { class: "rows" },
      h("div", { class: "row row-lines row-head" }, h("span", {}, "Class"), h("span", {}, "Description"), h("span", {}, "Payroll"), h("span", {}, "Rate per $100"), h("span", {})),
      lineRow());
    const form = h("form", {},
      h("div", { class: "form-grid" },
        field("State", stateSelect("state", prefill.state || "NV")),
        field("Policy effective date", h("input", { type: "date", name: "date", value: today() }))),
      lines,
      h("button", { type: "button", class: "btn btn-ghost btn-small", onclick: () => lines.append(lineRow()) }, "Add class"),
      h("div", { class: "form-grid mt-md" },
        field("Experience mod", h("input", { name: "mod", value: "1.00", inputmode: "decimal" })),
        field("Schedule rating % (credit is negative)", h("input", { name: "sched", value: "0", inputmode: "decimal" })),
        field("Expense constant $", h("input", { name: "expense", value: "0", inputmode: "decimal" })),
        field("Other flat charges $", h("input", { name: "other", value: "0", inputmode: "decimal" })),
        field("Deposit premium paid $ (optional)", h("input", { name: "deposit", inputmode: "decimal" }))));
    const build = () => {
      const other = val(form, "other");
      return {
        state: val(form, "state"),
        policyEffectiveDate: val(form, "date"),
        lines: rowValues(lines).filter((r) => r.get("classCode")).map((r) => ({
          classCode: r.value("classCode"),
          ...(r.value("description") ? { description: r.value("description") } : {}),
          payroll: r.value("payroll"),
          rate: r.value("rate"),
        })),
        experienceMod: val(form, "mod") || "1",
        scheduleRatingPct: val(form, "sched") || "0",
        expenseConstant: val(form, "expense") || "0",
        otherCharges: other && Number(other.replace(/[$,]/g, "")) !== 0 ? [{ label: "Other charges", amount: other }] : [],
        ...(val(form, "deposit") ? { depositPremium: val(form, "deposit") } : {}),
      };
    };
    return { form, build };
  },

  officer_payroll(prefill) {
    const people = h("div", { class: "rows" }, personRow());
    const limits = h("div", { class: "form-grid", hidden: true },
      field("State minimum (annual) $", h("input", { name: "min", inputmode: "decimal" })),
      field("State maximum (annual) $", h("input", { name: "max", inputmode: "decimal" })),
      field("Owner amount (annual) $", h("input", { name: "owner", inputmode: "decimal" })));
    const form = h("form", {},
      h("div", { class: "form-grid" },
        field("State", stateSelect("state", prefill.state || "NV")),
        field("Business type", h("select", { name: "entityType" },
          h("option", { value: "corporation" }, "Corporation"),
          h("option", { value: "llc" }, "LLC"),
          h("option", { value: "partnership" }, "Partnership"),
          h("option", { value: "sole_proprietor" }, "Sole proprietor"))),
        field("Policy effective date", h("input", { type: "date", name: "date", value: today() })),
        field("Policy term (days)", h("input", { name: "term", value: "365", inputmode: "numeric" }))),
      people,
      h("button", { type: "button", class: "btn btn-ghost btn-small", onclick: () => people.append(personRow()) }, "Add person"),
      h("label", { class: "check check-spaced" },
        h("input", { type: "checkbox", name: "useLimits", onchange: (e) => { limits.hidden = !e.target.checked; } }),
        "I have my state's current limits from the bureau"),
      limits);
    const build = () => ({
      state: val(form, "state"),
      entityType: val(form, "entityType"),
      policyEffectiveDate: val(form, "date"),
      policyTermDays: Number(val(form, "term") || 365),
      people: rowValues(people).filter((r) => r.get("name")).map((r) => ({
        name: r.value("name"),
        actualPayroll: r.value("payroll"),
        status: r.get("included").checked ? "included" : "excluded",
      })),
      ...(checked(form, "useLimits")
        ? { limitsOverride: { minAnnual: val(form, "min"), maxAnnual: val(form, "max"), ownerAnnual: val(form, "owner") } }
        : {}),
    });
    return { form, build };
  },

  document_checklist(prefill) {
    const box = (name, label, on = false) => h("label", { class: "check" }, h("input", { type: "checkbox", name, checked: on }), label);
    const form = h("form", {},
      h("div", { class: "form-grid" },
        field("Main state", stateSelect("state", prefill.state || "", { optional: true })),
        field("Business type", h("select", { name: "entityType" },
          h("option", { value: "corporation" }, "Corporation"),
          h("option", { value: "llc" }, "LLC"),
          h("option", { value: "partnership" }, "Partnership"),
          h("option", { value: "sole_proprietor" }, "Sole proprietor"))),
        field("How is the audit being done?", h("select", { name: "auditType" },
          h("option", { value: "unknown" }, "Not sure yet"),
          h("option", { value: "physical" }, "In person"),
          h("option", { value: "phone_or_mail" }, "By phone or mail"))),
        field("Class codes on your policy", h("input", { name: "codes", placeholder: "8810, 5183" }))),
      h("div", { class: "checks" },
        box("hasOfficersOrOwners", "Officers, members or owners work in the business", true),
        box("usesSubcontractors", "We hired subcontractors"),
        box("hasOvertime", "We paid overtime"),
        box("hasCasualLabor", "We used temporary or casual labor"),
        box("multiState", "People worked in more than one state")));
    const build = () => ({
      ...(val(form, "state") ? { state: val(form, "state") } : {}),
      entityType: val(form, "entityType"),
      auditType: val(form, "auditType"),
      classCodes: splitList(val(form, "codes")),
      hasOfficersOrOwners: checked(form, "hasOfficersOrOwners"),
      usesSubcontractors: checked(form, "usesSubcontractors"),
      hasOvertime: checked(form, "hasOvertime"),
      hasCasualLabor: checked(form, "hasCasualLabor"),
      multiState: checked(form, "multiState"),
    });
    return { form, build };
  },
};

function openTool(name, prefill) {
  if (!FORMS[name]) return;
  for (const [n, card] of Object.entries(cards)) card.setAttribute("aria-expanded", String(n === name));
  const { form, build } = FORMS[name](prefill);
  const error = h("p", { class: "form-error", role: "alert" });
  const results = h("div");
  const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Run");
  form.append(h("div", { class: "form-actions" }, submit), error);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      const { receipt } = await api(`/api/tools/${name}`, build());
      results.prepend(resultCard(receipt));
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
  panel.replaceChildren(h("h3", {}, TOOL_INFO[name].title), form, results);
  panel.hidden = false;
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}
