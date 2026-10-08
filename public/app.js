// Penny homepage chat. The conversation design matches the preview site; every
// answer now comes from the audit engine (/api/tools, /api/chat), carries a
// receipt with its rule and engine versions, and can be verified by replay.
// All text goes into the page through textContent, never innerHTML.
(function () {
  var chat = document.getElementById("chat");
  var chipsEl = document.getElementById("chips");
  var input = document.getElementById("penny-input");
  var sendBtn = document.getElementById("send");

  var STATES = {
    AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut",
    DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois",
    IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland",
    MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana",
    NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york",
    NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania",
    RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah",
    VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming",
  };

  var GREETING =
    "Hi, I'm Penny. I can look up a class code, estimate an audit bill, work out officer payroll, or build your document checklist. I can also show you a demo, walk you through plans, or get you signed up.\n\nPick one below, or just ask.";

  var S = { flow: null, step: 0, ans: {} };
  var history = [];
  var busy = false;

  // ---------- small helpers ----------

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function avatar(size) {
    var a = el("span", "avatar", "P");
    if (size) { a.style.width = size + "px"; a.style.height = size + "px"; a.style.fontSize = size / 2 + "px"; }
    return a;
  }

  function num(t) {
    var cleaned = String(t).replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    return cleaned;
  }

  function parseState(t) {
    var s = t.trim();
    if (/^[a-z]{2}$/i.test(s) && STATES[s.toUpperCase()]) return s.toUpperCase();
    var low = s.toLowerCase();
    for (var code in STATES) if (STATES[code] === low) return code;
    return null;
  }

  function statesIn(t) {
    var found = [];
    (t.match(/\b[A-Z]{2}\b/g) || []).forEach(function (s) { if (STATES[s] && found.indexOf(s) < 0) found.push(s); });
    var low = t.toLowerCase();
    for (var code in STATES) if (new RegExp("\\b" + STATES[code] + "\\b").test(low) && found.indexOf(code) < 0) found.push(code);
    return found.sort();
  }

  function yes(t) { return /^\s*y/i.test(t); }

  async function api(path, body) {
    var res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "Something went wrong (" + res.status + ").");
    return data;
  }

  function runTool(name, input) {
    return api("/api/tools/" + name, input).then(function (d) { return d.receipt; });
  }

  // ---------- messages ----------

  function add(from, content) {
    var d = el("div", "msg" + (from === "user" ? " user" : ""));
    if (from === "penny") d.appendChild(avatar(28));
    var b = el("div", "b");
    if (typeof content === "string") b.textContent = content;
    else b.appendChild(content);
    d.appendChild(b);
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  }

  function typing() {
    var t = el("div", "typing");
    t.appendChild(avatar(28));
    var dots = el("div", "dots");
    dots.appendChild(el("i")); dots.appendChild(el("i")); dots.appendChild(el("i"));
    t.appendChild(dots);
    chat.appendChild(t);
    chat.scrollTop = chat.scrollHeight;
    return t;
  }

  function pennySays(content, delay) {
    if (window.pennyReduced) { add("penny", content); return; }
    var t = typing();
    setTimeout(function () { t.remove(); add("penny", content); }, delay || 500);
  }

  /** Run engine work behind a typing indicator, then show what it returns. */
  async function pennyWorks(work) {
    busy = true;
    var t = typing();
    try {
      var content = await work();
      t.remove();
      if (content) add("penny", content);
    } catch (err) {
      t.remove();
      add("penny", "I couldn't run that: " + err.message);
    } finally {
      busy = false;
    }
  }

  // ---------- receipts ----------

  function saveReceipt(receipt) {
    var blob = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "penny-receipt-" + receipt.runId.slice(0, 8) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function receiptBar(receipt) {
    var bar = el("div", "receipt");
    if (receipt.dataStatus === "sample") bar.appendChild(el("span", "pill", "Sample data"));
    var id = el("span", "", "Run ");
    id.appendChild(el("code", "", receipt.runId.slice(0, 8)));
    id.title = "Engine " + receipt.engineVersion + " · rules " + receipt.rules.map(function (r) { return r.id + "@" + r.version; }).join(", ");
    bar.appendChild(id);
    var status = el("span", "");
    var verify = el("button", "", "Verify");
    verify.type = "button";
    verify.onclick = async function () {
      verify.disabled = true;
      try {
        var r = await api("/api/replay", { receipt: receipt });
        status.className = r.reproduced ? "pill ok" : "pill";
        status.textContent = r.reproduced ? "Verified: same answer on re-run" : "Did not match: " + r.reason;
      } catch (err) {
        status.className = "pill";
        status.textContent = err.message;
      } finally {
        verify.disabled = false;
      }
    };
    var save = el("button", "", "Save receipt");
    save.type = "button";
    save.onclick = function () { saveReceipt(receipt); };
    bar.appendChild(verify);
    bar.appendChild(save);
    bar.appendChild(status);
    return bar;
  }

  function answer(text, receipts) {
    var frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(text));
    (receipts || []).forEach(function (r) { frag.appendChild(receiptBar(r)); });
    return frag;
  }

  function warningsText(list) {
    return list && list.length ? "\n\n" + list.map(function (w) { return "Note: " + w; }).join("\n") : "";
  }

  // ---------- result summaries ----------

  function summarize(receipt) {
    var o = receipt.output;
    switch (receipt.tool) {
      case "class_code_lookup": {
        if (o.comparison && o.comparison.byState.length) {
          return "Class " + o.comparison.code + " by state:\n\n" + o.comparison.byState.map(function (s) {
            var what = s.found ? s.title
              : s.equivalent ? "not used here; closest code is " + s.equivalent.code + (s.equivalent.title ? " · " + s.equivalent.title : "") + ". " + s.equivalent.note
              : s.note || "not found";
            return s.stateName + " (" + s.bureau + "): " + what;
          }).join("\n") + warningsText(o.notes);
        }
        if (o.matches.length) {
          return (o.mode === "compare" ? "" : "Closest matches:\n\n") + o.matches.map(function (m) {
            return m.code + " · " + m.title + " (" + m.system + ")";
          }).join("\n") + warningsText(o.notes);
        }
        return o.notes.join("\n") || "No match in Penny's tables yet.";
      }
      case "audit_bill_estimator": {
        var lines = [];
        if (o.comparison) {
          lines.push("Estimated premium: " + o.comparison.depositPremium.display);
          lines.push("Audited premium: " + o.totalAuditPremium.display);
          lines.push(
            o.comparison.result === "no change" ? "No change from the estimate."
              : (o.comparison.result === "additional premium" ? "Additional premium due: " : "Return premium: ") + o.comparison.difference.display,
          );
        } else {
          lines.push("Audited premium: " + o.totalAuditPremium.display);
        }
        lines.push("", "How it adds up:");
        o.steps.forEach(function (s) { lines.push(s.label + ": " + s.amount.display + " (" + s.detail + ")"); });
        o.drivers.forEach(function (d) { lines.push("", "Each extra $10,000 of payroll in class " + d.classCode + " changes the bill by " + d.per10kPayroll.display + "."); });
        lines.push("", "This leaves out fees, taxes and minimum premiums, which vary by carrier. If your bill does not match, Audit Review checks it line by line.");
        return lines.join("\n") + warningsText(o.warnings);
      }
      case "officer_payroll": {
        var p = o.people[0];
        var text = "Payroll counted on the audit: " + o.totalCountedPayroll.display + "\n" + p.reason;
        if (o.limits.minimum) {
          text += "\n\nLimits used for a " + o.limits.proratedFor + ": minimum " + o.limits.minimum.display + ", maximum " + o.limits.maximum.display +
            ", owner amount " + o.limits.ownerAmount.display + ".";
        }
        return text + warningsText(o.warnings);
      }
      case "document_checklist": {
        var n = 0;
        var out = "Here is your audit checklist:\n";
        o.groups.forEach(function (g) {
          out += "\n" + g.group + "\n";
          g.items.forEach(function (i) { n++; out += n + ". " + i.label + (i.priority === "recommended" ? " (recommended)" : "") + "\n"; });
        });
        return out + "\n" + o.tips.join("\n");
      }
    }
    return "Done.";
  }

  // ---------- guided flows ----------

  var FLOWS = {
    estimate: {
      placeholder: "Type your answer",
      first: "Let's estimate it. Which state is the policy in? For example: NV",
      steps: [
        { key: "state", parse: parseState, retry: "I need a state, like NV or Nevada.", next: "Which class code is this for? For example: 8810" },
        { key: "classCode", parse: function (t) { return /^\d{3,4}$/.test(t.trim()) ? t.trim() : null; }, retry: "I need a 3 or 4 digit class code, like 8810.", next: "What payroll did your policy estimate for this class? For example: 160000" },
        { key: "est", parse: num, retry: "I need a number for that one. For example: 160000", next: "What did you actually pay in payroll for the policy period?" },
        { key: "act", parse: num, retry: "I need a number for that one. For example: 185000", next: "What is the rate per $100 of payroll on your policy? For example: 2.75" },
        { key: "rate", parse: num, retry: "I need a number for that one. For example: 2.75", next: "What is your experience mod? Type 1 if you do not have one." },
        { key: "mod", parse: num, retry: "I need a number for that one. For example: 0.95" },
      ],
      async finish(a) {
        var base = { state: a.state, experienceMod: a.mod };
        var estimated = await runTool("audit_bill_estimator", Object.assign({}, base, { lines: [{ classCode: a.classCode, payroll: a.est, rate: a.rate }] }));
        var audited = await runTool("audit_bill_estimator", Object.assign({}, base, {
          lines: [{ classCode: a.classCode, payroll: a.act, rate: a.rate }],
          depositPremium: (estimated.output.totalAuditPremium.cents / 100).toFixed(2),
        }));
        return answer(summarize(audited), [audited]);
      },
    },

    officer: {
      placeholder: "Type your answer",
      first: "Which state is the policy in? For example: NV",
      steps: [
        { key: "state", parse: parseState, retry: "I need a state, like NV or Nevada.", next: "What type of business is it? Type corporation, LLC, partnership, or sole proprietor." },
        {
          key: "entityType",
          parse: function (t) {
            var l = t.toLowerCase();
            return /llc/.test(l) ? "llc" : /corp|inc/.test(l) ? "corporation" : /partner/.test(l) ? "partnership" : /sole|proprietor/.test(l) ? "sole_proprietor" : null;
          },
          retry: "Type corporation, LLC, partnership, or sole proprietor.",
          next: "Is the owner or officer included or excluded on your policy? Type included, excluded, or not sure.",
        },
        {
          key: "status",
          parse: function (t) { var l = t.toLowerCase().trim(); return l.indexOf("ex") === 0 ? "excluded" : l.indexOf("in") === 0 ? "included" : l.indexOf("not") === 0 || l.indexOf("?") >= 0 ? "unsure" : null; },
          retry: "Type included, excluded, or not sure.",
          next: function (a) {
            if (a.status === "unsure") return null;
            return a.status === "excluded" ? null : "What did they actually receive in pay for the policy period? For example: 40000";
          },
        },
        { key: "pay", parse: num, retry: "I need a number for that one. For example: 40000" },
      ],
      async finish(a) {
        if (a.status === "unsure") {
          return "Look for an officer or owner exclusion endorsement in your policy forms. If it is there, their pay is left out; if not, it is usually counted within your state's minimum and maximum. Ask me again once you know, and I'll work out the number.";
        }
        var receipt = await runTool("officer_payroll", {
          state: a.state,
          entityType: a.entityType,
          people: [{ name: "Owner or officer", actualPayroll: a.pay || "0", status: a.status }],
        });
        var extra = a.status === "excluded" ? "\n\nMake sure the exclusion endorsement is actually on your policy. Without it, their pay can be added at audit." : "";
        return answer(summarize(receipt) + extra, [receipt]);
      },
    },

    checklist: {
      placeholder: "Type your answer",
      first: "What type of business are you? Type LLC, corporation, sole proprietor, or partnership.",
      steps: [
        {
          key: "entityType",
          parse: function (t) {
            var l = t.toLowerCase();
            return /llc/.test(l) ? "llc" : /corp|inc/.test(l) ? "corporation" : /partner/.test(l) ? "partnership" : /sole|proprietor/.test(l) ? "sole_proprietor" : null;
          },
          retry: "Type LLC, corporation, sole proprietor, or partnership.",
          next: "Did you pay any subcontractors or 1099 workers during the policy period? Yes or no.",
        },
        { key: "subs", parse: function (t) { return /^\s*[yn]/i.test(t) ? yes(t) : null; }, retry: "Yes or no?", next: "Did any employees work in more than one state? Yes or no." },
        { key: "multi", parse: function (t) { return /^\s*[yn]/i.test(t) ? yes(t) : null; }, retry: "Yes or no?", next: "Did you pay any overtime? Yes or no." },
        { key: "overtime", parse: function (t) { return /^\s*[yn]/i.test(t) ? yes(t) : null; }, retry: "Yes or no?" },
      ],
      async finish(a) {
        var receipt = await runTool("document_checklist", {
          entityType: a.entityType,
          usesSubcontractors: a.subs,
          multiState: a.multi,
          hasOvertime: a.overtime,
        });
        return answer(summarize(receipt), [receipt]);
      },
    },

    lookup: {
      placeholder: "A job or a code, like roofer or 8810",
      first: 'Type a job, like "roofer" or "office staff", or a code like 8810. Add states to compare them, like "8810 in NV and CA".',
    },
  };

  function setPlaceholder() {
    input.placeholder = (S.flow && FLOWS[S.flow].placeholder) || "Ask Penny about your audit";
  }

  function startFlow(flow, userText) {
    if (busy) return;
    add("user", userText);
    S = { flow: flow, step: 0, ans: {} };
    setPlaceholder();
    pennySays(FLOWS[flow].first, 450);
  }

  function endFlow() {
    S = { flow: null, step: 0, ans: {} };
    setPlaceholder();
  }

  async function lookup(text) {
    var codes = text.match(/\b\d{4}\b/g) || [];
    var states = statesIn(text);
    var receipts = codes.length
      ? await Promise.all(codes.slice(0, 3).map(function (c) { return runTool("class_code_lookup", { code: c, states: states }); }))
      : [await runTool("class_code_lookup", {
          query: text.toLowerCase().replace(/\b(compare|class|code|codes|for|in|and|the|a|an|my|staff|employees?)\b/g, " ").replace(/\b[a-z]{2}\b/g, function (w) { return STATES[w.toUpperCase()] ? " " : w; }).replace(/\s+/g, " ").trim() || text,
          states: states,
        })];
    var text2 = receipts.map(summarize).join("\n\n");
    if (codes.length >= 2) text2 += "\n\nThe deciding question is usually what the employee actually does day to day.";
    return answer(text2, receipts);
  }

  async function freeChat(text) {
    history.push({ role: "user", content: text });
    var data = await api("/api/chat", { messages: history.slice(-20) });
    history.push({ role: "assistant", content: data.reply });
    setChips(data.suggestions && data.suggestions.length ? data.suggestions : null);
    var map = { audit_bill_estimator: "estimate", officer_payroll: "officer", document_checklist: "checklist" };
    if (data.openTool && map[data.openTool.tool]) {
      var flow = map[data.openTool.tool];
      S = { flow: flow, step: 0, ans: {} };
      setPlaceholder();
      return answer(data.reply + "\n\n" + FLOWS[flow].first);
    }
    if (data.demo || data.signup) {
      // Show the reply now; the demo or sign-up card follows as its own message.
      setTimeout(function () {
        if (data.demo) playDemo(data.demo);
        if (data.signup) showSignup(data.signup.interest);
      }, 50);
      return answer(data.reply);
    }
    var body = data.receipts && data.receipts.length && data.mode === "rules" ? data.receipts.map(summarize).join("\n\n") : data.reply;
    return answer(body, data.receipts);
  }

  // ---------- sign-up ----------

  var ROLE_OPTIONS = [["business", "A business being audited"], ["auditor", "A premium auditor"], ["agency_or_partner", "An agency, bookkeeper or partner"], ["insurer", "An insurer or audit firm"], ["other", "Something else"]];
  var INTEREST_OPTIONS = [["free_account", "Free account"], ["pro", "PennyPro"], ["max", "PennyMax"], ["team", "Extra seats for my team"], ["enterprise", "Enterprise"], ["audit_ready", "Audit Ready"], ["audit_review", "Audit Review"], ["partner", "Partner or white-label"], ["insurer_demo", "Insurer walkthrough"], ["other", "Just talk to the team"]];

  function select(name, options, value) {
    var sel = el("select");
    sel.name = name;
    options.forEach(function (o) { var opt = el("option", "", o[1]); opt.value = o[0]; if (o[0] === value) opt.selected = true; sel.appendChild(opt); });
    return sel;
  }

  function labeled(text, control) {
    var l = el("label", "field");
    l.appendChild(el("span", "", text));
    l.appendChild(control);
    return l;
  }

  function textInput(name, type, required, autocomplete) {
    var i = el("input");
    i.name = name; i.type = type; i.required = required;
    if (autocomplete) i.autocomplete = autocomplete;
    return i;
  }

  function showSignup(interest) {
    var form = el("form", "signup");
    form.appendChild(el("strong", "", "Early access"));
    form.appendChild(labeled("Name", textInput("name", "text", true, "name")));
    form.appendChild(labeled("Email", textInput("email", "email", true, "email")));
    form.appendChild(labeled("I am", select("role", ROLE_OPTIONS, interest === "insurer_demo" ? "insurer" : interest === "partner" ? "agency_or_partner" : /pro|max|team/.test(interest) ? "auditor" : "business")));
    form.appendChild(labeled("Interested in", select("interest", INTEREST_OPTIONS, interest)));
    form.appendChild(labeled("Company (optional)", textInput("company", "text", false, "organization")));
    var consent = el("label", "check");
    var box = el("input"); box.type = "checkbox"; box.name = "consent"; box.required = true;
    consent.appendChild(box);
    consent.appendChild(document.createTextNode(" It's OK for the Propono team to contact me about Penny."));
    form.appendChild(consent);
    var legal = el("span", "small");
    var pp = el("a", "", "privacy policy"); pp.href = "privacy.html"; pp.target = "_blank"; pp.rel = "noopener";
    var tt = el("a", "", "terms"); tt.href = "terms.html"; tt.target = "_blank"; tt.rel = "noopener";
    legal.append("See our ", pp, " and ", tt, ".");
    form.appendChild(legal);
    var err = el("span", "small signup-error");
    var submit = el("button", "btn", "Sign me up");
    submit.type = "submit";
    form.appendChild(submit);
    form.appendChild(err);
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      err.textContent = "";
      submit.disabled = true;
      var f = form.elements;
      try {
        await api("/api/leads", {
          name: f.namedItem("name").value, email: f.namedItem("email").value, role: f.namedItem("role").value,
          interest: f.namedItem("interest").value, company: f.namedItem("company").value, consent: f.namedItem("consent").checked,
        });
        form.replaceChildren(el("strong", "", "You're on the list."), el("span", "", "The Propono team will reach out personally. In the meantime, the free tools are all yours."));
        setChips(null);
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    });
    add("penny", form);
  }

  // ---------- demos ----------
  // Sample businesses and demo rates; every dollar figure comes from the engine.

  function lineList(out) {
    return out.lines.map(function (l) { return l.classCode + (l.description ? " " + l.description : "") + ": " + l.payroll.display + " payroll × " + l.rate + " = " + l.premium.display; }).join("\n");
  }

  var DEMOS = {
    audit_review: function () {
      var base = { state: "NV", policyEffectiveDate: "2026-01-01", experienceMod: "1.04", expenseConstant: "250" };
      var billed = [
        { classCode: "5551", description: "Roofing", payroll: "460000", rate: "9.85" },
        { classCode: "5606", description: "Supervisors", payroll: "85000", rate: "1.95" },
        { classCode: "8810", description: "Clerical", payroll: "64000", rate: "0.31" },
      ];
      var corrected = billed.map(function (l) { return l.classCode === "5551" ? Object.assign({}, l, { payroll: "412000" }) : l; });
      var A, B, C;
      return {
        title: "Audit Review · Sierra Ridge Roofing LLC (sample)",
        steps: [
          { title: "Open your audit", async body() {
            A = await runTool("audit_bill_estimator", Object.assign({}, base, { lines: billed, depositPremium: "45000" }));
            var o = A.output;
            return ["Here is the audit the carrier sent, line by line:\n\n" + lineList(o) + "\n\nAudited premium " + o.totalAuditPremium.display + " against " + o.comparison.depositPremium.display + " already paid: " + o.comparison.difference.display + " " + o.comparison.result + " due.", A];
          } },
          { title: "Penny explains it", async body() {
            var d = A.output.drivers.find(function (x) { return x.classCode === "5551"; });
            return ["The roofing line includes $48,000 paid to two subcontractors: Ridgeline Gutters ($30,000) and Basin Sheet Metal ($18,000). No certificates of insurance were on file for the dates they worked, so their payments were added to your roofing payroll. That's the usual rule for uninsured subcontractors.\n\nWhat would change it: certificates showing their workers' comp was in force. Each $10,000 in class 5551 is " + d.per10kPayroll.display + " on this bill."];
          } },
          { title: "Add what's missing", action: "Upload both certificates", async body() {
            B = await runTool("audit_bill_estimator", Object.assign({}, base, { lines: corrected, depositPremium: (A.output.totalAuditPremium.cents / 100).toFixed(2) }));
            return ["Both certificates check out for the work dates. With the $48,000 removed from class 5551, the audit drops by " + B.output.comparison.difference.display + " to " + B.output.totalAuditPremium.display + ".", B];
          } },
          { title: "Escalate if needed", action: "Auditor approves", async body() {
            return ["The auditor sees only the disputed line, with both certificates attached and Penny's assessment. No re-audit from scratch. In this demo, the auditor approves."];
          } },
          { title: "Revised automatically", async body() {
            C = await runTool("audit_bill_estimator", Object.assign({}, base, { lines: corrected, depositPremium: "45000" }));
            var o = C.output;
            return ["The approved change regenerates the audit and the bill: " + o.totalAuditPremium.display + " audited, " + o.comparison.difference.display + " " + o.comparison.result + " against the deposit. Press Verify to re-run it and confirm the same answer.\n\nThe carrier's auditor makes the final decision, and you keep every appeal right your state provides.", C];
          } },
        ],
        cta: ["Sign up for Audit Review", "Plans and pricing"],
      };
    },

    audit_ready: function () {
      var R, F;
      return {
        title: "Audit Ready · Coyote Creek Landscaping LLC (sample)",
        steps: [
          { title: "Your checklist", async body() {
            R = await runTool("document_checklist", { entityType: "llc", usesSubcontractors: true, hasOvertime: true, multiState: false, classCodes: ["0042", "8810"], auditType: "phone_or_mail", policyEffectiveDate: "2026-01-01" });
            var items = []; R.output.groups.forEach(function (g) { g.items.forEach(function (i) { items.push(i.label); }); });
            var have = 4;
            return ["Penny built this list from your answers. You've uploaded " + have + " of " + items.length + ":\n\n" + items.map(function (x, i) { return (i < have ? "✓ " : "○ ") + x; }).join("\n"), R];
          } },
          { title: "Penny flags issues before the auditor does", async body() {
            F = await runTool("audit_bill_estimator", { state: "NV", policyEffectiveDate: "2026-01-01", lines: [{ classCode: "0042", description: "Landscaping", payroll: "14500", rate: "5.12" }] });
            return ["One subcontractor, Desert Edge Irrigation, was paid $14,500 with no certificate on file. Without one, that payment can be added to your landscaping payroll: about " + F.output.totalAuditPremium.display + " in premium at your rate. Upload their certificate now.\n\nYour payroll register shows overtime. Send the overtime breakdown so the premium portion can be left out where your state allows.", F];
          } },
          { title: "Packaged for the auditor", async body() {
            return ["When everything is in, Penny packages one file indexed by checklist item, with a cover summary of payroll by class, officers and subcontractors. You send it, or your agent does."];
          } },
        ],
        cta: ["Sign up for Audit Ready", "Plans and pricing"],
      };
    },

    auditor_pro: function () {
      var W;
      return {
        title: "PennyPro · Basin Electric Inc. audit (sample)",
        steps: [
          { title: "Forward the documents", async body() {
            return ["The insured's documents arrive at your Penny intake address: four quarterly 941s, a payroll register for 14 employees, the general ledger and three subcontractor certificates. Penny reads and files each one."];
          } },
          { title: "Reconcile", async body() {
            return ["Payroll register total: $1,182,400. Wages on the four 941s: $1,182,400. They match, so the register can be relied on.\n\n(Illustration: the signed-in 941 check arrives with PennyPro.)"];
          } },
          { title: "Drafted worksheet", async body() {
            W = await runTool("audit_bill_estimator", { state: "NV", policyEffectiveDate: "2026-01-01", experienceMod: "0.91", lines: [
              { classCode: "5190", description: "Electricians", payroll: "968000", rate: "5.48" },
              { classCode: "8810", description: "Office", payroll: "142400", rate: "0.29" },
              { classCode: "8742", description: "Outside sales", payroll: "72000", rate: "0.62" },
            ] });
            return ["Penny drafts the worksheet with payroll split by class. Each line ties to the register rows and the job duties behind it:\n\n" + lineList(W.output) + "\n\nAudited premium: " + W.output.totalAuditPremium.display + " after the 0.91 mod. All three subcontractors had valid certificates, so nothing was added.", W];
          } },
          { title: "You decide", async body() {
            return ["You review, edit any line, and sign off. Your decision is final; Penny keeps the record of every source and change."];
          } },
        ],
        cta: ["Sign up for PennyPro", "Plans and pricing"],
      };
    },
  };

  function playDemo(id) {
    if (!DEMOS[id]) return;
    var demo = DEMOS[id]();
    var card = el("div", "demo");
    var head = el("div", "demo-head");
    head.appendChild(el("span", "kicker", "Demo · sample data"));
    head.appendChild(el("strong", "", demo.title));
    var progress = el("span", "small muted");
    head.appendChild(progress);
    var body = el("div", "demo-body");
    var nav = el("div", "demo-nav");
    card.appendChild(head); card.appendChild(body); card.appendChild(nav);
    add("penny", card);
    var i = 0;

    async function show() {
      var step = demo.steps[i];
      progress.textContent = "Step " + (i + 1) + " of " + demo.steps.length + ": " + step.title;
      body.replaceChildren(el("span", "small muted", "Working..."));
      nav.replaceChildren();
      try {
        var result = await step.body();
        body.replaceChildren(answer(result[0], result[1] ? [result[1]] : []));
      } catch (err) {
        body.replaceChildren(el("span", "", "The demo hit a problem: " + err.message));
      }
      var next = demo.steps[i + 1];
      if (next) {
        var b = el("button", "btn", next.action || "Next: " + next.title);
        b.type = "button";
        b.onclick = function () { i++; show(); };
        nav.appendChild(b);
      } else {
        nav.appendChild(el("span", "small muted", "That's the demo."));
        setChips(demo.cta);
      }
      chat.scrollTop = chat.scrollHeight;
    }
    show();
  }

  function handle(raw) {
    var t = raw.trim();
    if (!t || busy) return;
    input.value = "";

    if (S.flow === "lookup") {
      add("user", t);
      return pennyWorks(function () { return lookup(t); });
    }

    if (S.flow) {
      var flow = FLOWS[S.flow];
      var step = flow.steps[S.step];
      add("user", t);
      var v = step.parse(t);
      if (v === null) {
        if (/\?|\b(price|pricing|plans?|demo|sign|cost|what|how|who|why)\b/i.test(t)) {
          endFlow();
          return pennyWorks(function () { return freeChat(t); });
        }
        pennySays(step.retry);
        return;
      }
      S.ans[step.key] = v;
      var next = typeof step.next === "function" ? step.next(S.ans) : step.next;
      if (next && S.step < flow.steps.length - 1) { S.step++; pennySays(next); return; }
      var answers = S.ans;
      var finish = flow.finish;
      endFlow();
      return pennyWorks(function () { return finish(answers); });
    }

    var low = t.toLowerCase();
    if (/\b\d{4}\b/.test(t) && !/\$|payroll|premium|bill/.test(low)) {
      add("user", t);
      S = { flow: "lookup", step: 0, ans: {} };
      setPlaceholder();
      return pennyWorks(function () { return lookup(t); });
    }
    add("user", t);
    return pennyWorks(function () { return freeChat(t); });
  }

  var FLOW_CHIPS = { "Look up a class code": "lookup", "Estimate my audit bill": "estimate", "Officer payroll rules": "officer", "What documents do I need?": "checklist" };
  var DEFAULT_CHIPS = ["Look up a class code", "Estimate my audit bill", "Officer payroll rules", "What documents do I need?", "Watch a demo", "Plans and pricing"];

  function chipClick(label) {
    if (FLOW_CHIPS[label]) return startFlow(FLOW_CHIPS[label], label);
    if (busy) return;
    endFlow();
    add("user", label);
    pennyWorks(function () { return freeChat(label); });
  }

  /** Show follow-up suggestions, or the default chips when given null. */
  function setChips(labels) {
    chipsEl.replaceChildren();
    (labels || DEFAULT_CHIPS).forEach(function (label) {
      var b = el("button", "chip", label);
      b.type = "button";
      b.onclick = function () { chipClick(label); };
      chipsEl.appendChild(b);
    });
  }

  function reset() {
    chat.replaceChildren();
    setChips(null);
    history = [];
    endFlow();
    pennySays(GREETING, 700);
  }

  document.getElementById("reset").onclick = reset;
  sendBtn.onclick = function () { handle(input.value); };
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); handle(input.value); } });
  reset();
  // index.html#talk opens the contact form (linked from the privacy and terms pages).
  if (location.hash === "#talk") setTimeout(function () { showSignup("other"); }, 800);
  // Plan buttons in the pricing section open the same form with that plan chosen.
  document.querySelectorAll("[data-plan]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      showSignup(a.getAttribute("data-plan"));
    });
  });
})();
