(function () {
  "use strict";

  var MAIN = ["Assigned", "Scheduled", "Records requested", "Records received", "In review", "Draft ready", "Director review", "Submitted to carrier", "Final"];
  var SIDE = ["Waiting on insured", "Returned for revision", "Non-compliant", "Cancelled"];
  var TABS = [["overview", "Overview"], ["worksheet", "Worksheet"], ["officers", "Officers & subs"], ["documents", "Documents"], ["findings", "Findings"], ["timeline", "Timeline"], ["reports", "Reports"]];

  var S = {
    user: null, cases: [], caseId: null, data: null, tab: "overview",
    chats: {}, sel: {}, editLine: null, hl: null, busy: false, runCache: {}
  };

  var $ = function (id) { return document.getElementById(id); };
  var center = $("center"), logEl = $("log");

  /* ---------- helpers ---------- */
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Decimal string -> $1,234.56 using string handling only (no float math).
  function fmtDec(s) {
    if (s == null || s === "") return "—";
    var m = /^\s*(-?)\$?(\d+)(?:\.(\d*))?\s*$/.exec(String(s));
    if (!m) return String(s);
    var whole = m[2].replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var frac = ((m[3] || "") + "00").slice(0, 2);
    return (m[1] ? "-" : "") + "$" + whole + "." + frac;
  }
  function money(x) {
    if (x == null) return "—";
    if (typeof x === "object") return x.display != null ? String(x.display) : "—";
    return fmtDec(x);
  }
  function signed(x) {
    var d = money(x);
    return /^[+\-−]/.test(d) || d === "—" ? d : "+" + d;
  }
  function scalar(v) {
    if (v == null) return "—";
    if (typeof v === "object") return v.display != null ? String(v.display) : kv(v);
    if (typeof v === "boolean") return v ? "yes" : "no";
    return String(v);
  }
  function kv(o) {
    if (o == null) return "—";
    if (typeof o !== "object") return String(o);
    return Object.keys(o).map(function (k) { return k + ": " + scalar(o[k]); }).join(", ");
  }
  function fmtTime(t) {
    var d = new Date(t);
    return isNaN(d) ? String(t || "") : d.toLocaleString();
  }
  function fmtDate(s) {
    if (!s) return "—";
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    return m ? m[2] + "/" + m[3] + "/" + m[1] : String(s);
  }
  function daysUntil(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
    if (!m) return null;
    var t = new Date(); t = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return Math.round((d - t) / 86400000);
  }
  function toast(msg, bad) {
    var el = document.createElement("div");
    el.className = "toast" + (bad ? " err" : "");
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, bad ? 6000 : 3500);
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.via) headers["X-Penny-Via"] = opts.via;
    return fetch(path, {
      method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
      credentials: "same-origin",
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) { location.href = "/login.html"; return new Promise(function () {}); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ("Request failed (" + r.status + ")")); e.field = j.field; throw e; }
        return j;
      });
    });
  }

  function statusPill(s) {
    var cls = SIDE.indexOf(s) >= 0 ? " side" : (s === "Final" ? " final" : "");
    return '<span class="spill' + cls + '">' + esc(s) + "</span>";
  }

  /* ---------- left rail ---------- */
  function renderRail() {
    var due = 0, review = 0, waiting = 0, flags = 0;
    S.cases.forEach(function (c) {
      var d = daysUntil(c.dueDate);
      if (d != null && d <= 7) due++;
      if (c.status === "In review") review++;
      if (c.status === "Waiting on insured") waiting++;
      flags += c.openFlags || 0;
    });
    $("counts").innerHTML =
      '<div><dt>Due this week</dt><dd>' + due + '</dd></div>' +
      '<div><dt>In review</dt><dd>' + review + '</dd></div>' +
      '<div><dt>Waiting on insured</dt><dd>' + waiting + '</dd></div>' +
      '<div><dt>Open flags</dt><dd>' + flags + '</dd></div>';
    $("caselist").innerHTML = S.cases.map(function (c) {
      return '<li><button type="button" data-act="pick" data-id="' + esc(c.id) + '"' + (c.id === S.caseId ? ' aria-current="true"' : "") + ">" +
        '<span class="nm">' + esc(c.insured) + "</span>" +
        '<span class="meta">' + esc(c.state) + " " + statusPill(c.status) + "</span>" +
        '<span class="meta"><span>Due ' + esc(fmtDate(c.dueDate)) + "</span>" +
        (c.openFlags ? '<span class="flagn">' + c.openFlags + " flag" + (c.openFlags === 1 ? "" : "s") + "</span>" : "") + "</span>" +
        "</button></li>";
    }).join("");
  }

  /* ---------- center ---------- */
  function T() { return S.data.totals || {}; }
  function C() { return S.data.case; }

  function renderCenter(keepScroll) {
    if (!S.data) return;
    var top = center.scrollTop;
    var c = C(), t = T();
    var idx = MAIN.indexOf(c.status), side = SIDE.indexOf(c.status) >= 0;
    var next = idx >= 0 && idx < MAIN.length - 1 ? MAIN[idx + 1] : null;

    var stepper = '<ol class="stepper" aria-label="Audit status">' + MAIN.map(function (s, i) {
      var cls = i === idx ? "cur" : (idx >= 0 && i < idx ? "done" : "");
      return '<li class="' + cls + '"' + (i === idx ? ' aria-current="step"' : "") + ">" + esc(s) + "</li>";
    }).join("") + "</ol>";

    var opts = MAIN.concat(SIDE).map(function (s) {
      return '<option value="' + esc(s) + '"' + (s === c.status ? " selected" : "") + ">" + esc(s) + "</option>";
    }).join("");

    var head =
      '<section class="chead" aria-label="Case"><div class="statusrow"><h1>' + esc(c.insured) + "</h1>" +
      (side ? statusPill(c.status) : "") + "</div>" +
      '<div class="facts2">' +
      f("Policy", c.policyNumber) + f("Carrier", c.carrier) + f("State", c.state) +
      f("Period", fmtDate(c.policyEffectiveDate) + " to " + fmtDate(c.policyExpirationDate)) +
      f("Audit type", c.auditType) + f("Contact", c.contact && typeof c.contact === "object" ? kv(c.contact) : c.contact) +
      f("Assignee", c.assignee) + f("Due", fmtDate(c.dueDate)) + "</div>" +
      stepper +
      '<div class="statusrow">' +
      (next ? '<button class="btn sm" type="button" data-act="next" data-status="' + esc(next) + '">Next step: ' + esc(next) + "</button>" : "") +
      '<label class="sr" for="st-sel">Set status</label><select id="st-sel">' + opts + "</select>" +
      '<label class="sr" for="st-reason">Reason (optional)</label><input id="st-reason" type="text" placeholder="Reason (optional)" maxlength="300">' +
      '<button class="btn ghost sm" type="button" data-act="setstatus">Set status</button></div></section>';

    var est = t.estimate || {}, cmp = est.comparison || null;
    var strip = '<div class="strip">' +
      '<div><small>Estimated audit premium</small><b>' + esc(money(est.totalAuditPremium)) + "</b></div>" +
      '<div><small>Deposit premium</small><b>' + esc(cmp && cmp.depositPremium ? money(cmp.depositPremium) : fmtDec(c.depositPremium)) + "</b></div>" +
      '<div><small>Difference</small><b>' + esc(cmp ? money(cmp.difference) : "—") + '</b><span class="sub">' + esc(cmp ? cmp.result : "") + "</span></div>" +
      '<div><small>Open flags</small><b>' + esc(t.openFlags != null ? t.openFlags : "—") + "</b></div>" +
      '<div><small>Open findings</small><b>' + esc(t.openFindings != null ? t.openFindings : "—") + "</b></div></div>";

    var tabs = '<div class="tabs" role="tablist" aria-label="Case sections">' + TABS.map(function (x) {
      return '<button type="button" role="tab" data-act="tab" data-tab="' + x[0] + '" aria-selected="' + (S.tab === x[0]) + '">' + x[1] + "</button>";
    }).join("") + "</div>";

    var body = { overview: tabOverview, worksheet: tabWorksheet, officers: tabOfficers, documents: tabDocuments, findings: tabFindings, timeline: tabTimeline, reports: tabReports }[S.tab]();

    center.innerHTML = head + strip + tabs + '<div class="panel" role="tabpanel">' + body + "</div>";
    if (keepScroll) center.scrollTop = top;
    if (S.hl) {
      var el = center.querySelector('[data-rowid="' + S.hl.replace(/"/g, "") + '"]');
      if (el) { el.classList.add("hl"); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
      S.hl = null;
    }
    function f(k, v) { return v == null || v === "" ? "" : "<span><b>" + esc(k) + "</b>" + esc(v) + "</span>"; }
  }

  function table(head, rows, cls) {
    return '<div class="tablebox"><table class="ws"><thead><tr>' + head.map(function (h) {
      var n = h.charAt(0) === "#";
      return '<th scope="col"' + (n ? ' class="num"' : "") + ">" + esc(n ? h.slice(1) : h) + "</th>";
    }).join("") + "</tr></thead><tbody>" + (rows.join("") || '<tr><td colspan="' + head.length + '" class="muted">Nothing here yet.</td></tr>') + "</tbody></table></div>";
  }

  function opsBlock() {
    var c = C(), text = (c.operations || "").trim();
    var out = '<section class="ops" aria-labelledby="ops-h"><div class="opshead"><h3 id="ops-h">Description of operations</h3>';
    if (S.editOps) {
      return out + "</div>" +
        '<label class="sr" for="ops-in">Description of operations</label><textarea id="ops-in" rows="6" maxlength="4000">' + esc(c.operations || "") + "</textarea>" +
        '<div class="opsbtns"><button class="btn sm" type="button" data-act="saveops">Save</button><button class="btn ghost sm" type="button" data-act="cancelops">Cancel</button></div></section>';
    }
    out += '<span class="opsbtns"><button class="btn ghost sm" type="button" data-act="editops">' + (text ? "Edit" : "Write it") + '</button><button class="btn ghost sm" type="button" data-act="draftops">Ask Penny to draft</button></span></div>';
    out += text ? '<p class="opstext">' + esc(c.operations) + "</p>"
      : '<div class="callout bad" role="note">Not written yet. The audit report needs a description of operations before the case can move to Draft ready.</div>';
    return out + "</section>";
  }

  function tabOverview() {
    var t = T(), est = t.estimate || {}, out = opsBlock();
    var warns = [];
    (t.problems || []).forEach(function (p) { warns.push(["bad", p]); });
    (est.warnings || []).forEach(function (p) { warns.push(["warn", p]); });
    ((t.officers && t.officers.warnings) || []).forEach(function (p) { warns.push(["warn", p]); });
    if (warns.length) {
      out += "<h3>Problems and warnings</h3>" + warns.map(function (w) { return '<div class="callout ' + w[0] + '" role="note">' + esc(w[1]) + "</div>"; }).join("");
    }
    if (t.cap) out += '<div class="callout info">' + esc(money(t.cap.perEmployee)) + " per employee cap. " + esc(t.cap.note || "") + "</div>";

    out += "<h3>Payroll by class</h3>" + table(["Class", "Title", "#Employees", "#Officers", "#Uninsured subs", "#Total payroll", "#Estimated at binding"],
      (t.byClass || []).map(function (r) {
        return "<tr><td>" + esc(r.classCode) + "</td><td>" + esc(r.title) + '</td><td class="num">' + esc(money(r.employees)) + '</td><td class="num">' + esc(money(r.officers)) +
          '</td><td class="num">' + esc(money(r.uninsuredSubs)) + '</td><td class="num">' + esc(money(r.payroll)) + '</td><td class="num">' + esc(r.estimated != null ? money(r.estimated) : "—") + "</td></tr>";
      }));

    if (est.steps && est.steps.length) {
      out += "<h3>How the premium is built</h3>" + table(["Step", "Detail", "#Amount"], est.steps.map(function (s) {
        return "<tr><td>" + esc(s.label) + "</td><td>" + esc(s.detail) + '</td><td class="num">' + esc(money(s.amount)) + "</td></tr>";
      }));
    }

    out += "<h3>Engine runs</h3>" + table(["Tool", "Fingerprint", "Data", "Rules", ""], (t.runs || []).map(function (r) {
      var ver = r.dataStatus === "verified";
      var rules = (r.rules || []).map(function (x) { return esc(x.id + " v" + x.version + (x.status ? " (" + x.status + ")" : "")); }).join("<br>");
      return "<tr><td>" + esc(r.tool) + '</td><td class="mono">' + esc(String(r.fingerprint || "").slice(0, 12)) + '</td><td><span class="spill ' + (ver ? "ver" : "sample") + '">' + (ver ? "Verified" : "Sample data") + "</span></td><td>" + rules +
        '</td><td><button class="iconbtn" type="button" data-act="verify" data-run="' + esc(r.runId) + '">Verify</button> <span class="small muted" data-vout="' + esc(r.runId) + '"></span></td></tr>';
    }));
    out += '<p class="small-note">Figures come from the engine\'s runs. Penny does not do the arithmetic.</p>';
    return out;
  }

  function srcLink(src) {
    if (!src || !src.doc) return "—";
    return '<button type="button" class="refchip" data-act="ref" data-ref="' + esc(src.doc) + '">' + esc(src.doc + (src.page ? " p." + src.page : "")) + "</button>" + (src.note ? '<div class="small muted">' + esc(src.note) + "</div>" : "");
  }
  function setBy(s) { return s === "person" ? "Person" : (s === "penny-for-person" ? "Penny, for a person" : "Penny"); }

  function tabWorksheet() {
    var c = C(), t = T(), lines = c.lines || [], tl = t.lines || {};
    var nsel = Object.keys(S.sel).length;
    var out = '<div class="bulk"><span><b>' + nsel + "</b> selected</span>" +
      '<label class="sr" for="bk-class">Class code</label><input id="bk-class" type="text" size="8" placeholder="Class code">' +
      '<label class="sr" for="bk-reason">Reason</label><input id="bk-reason" type="text" placeholder="Reason (required)" maxlength="300">' +
      '<button class="btn sm" type="button" data-act="bulkmove"' + (nsel ? "" : " disabled") + ">Move to class</button></div>";
    var rows = [];
    lines.forEach(function (l) {
      var cnt = tl[l.id] || {};
      rows.push('<tr data-rowid="' + esc(l.id) + '"' + (S.sel[l.id] ? ' class="sel"' : "") + '><td><input type="checkbox" data-act="selrow" data-id="' + esc(l.id) + '" aria-label="Select ' + esc(l.payee) + '"' + (S.sel[l.id] ? " checked" : "") + "></td>" +
        "<td>" + esc(l.payee) + '<div class="small muted">' + esc(l.title) + "</div></td><td>" + esc(l.classCode) + '</td><td class="num">' + esc(fmtDec(l.payroll)) +
        '</td><td class="num">' + esc(fmtDec(l.overtimePremium)) + '<div class="small muted">' + (l.overtimeExcluded ? "left out" : "included") + "</div></td>" +
        '<td class="num">' + esc(money(cnt.counted)) + (cnt.capped ? ' <span class="spill side">capped</span>' : "") + "</td><td>" + srcLink(l.source) + "</td><td>" + esc(setBy(l.setBy)) + "</td>" +
        "<td>" + (l.flag ? '<span class="warncell" aria-hidden="true">⚑</span> <span class="sr">Flag:</span>' + esc(l.flag) : "") + "</td>" +
        '<td><div class="rowact"><button class="iconbtn" type="button" data-act="editline" data-id="' + esc(l.id) + '">Edit</button>' +
        (l.flag ? '<button class="iconbtn" type="button" data-act="keepline" data-id="' + esc(l.id) + '">Keep as is</button>' : "") + "</div></td></tr>");
      if (S.editLine === l.id) {
        rows.push('<tr class="ed"><td colspan="10"><div class="edgrid">' +
          '<label>Class code<input id="ed-class" type="text" size="8" value="' + esc(l.classCode) + '"></label>' +
          '<label>Gross payroll<input id="ed-pay" type="text" inputmode="decimal" size="12" value="' + esc(l.payroll) + '"></label>' +
          '<label>Overtime premium<input id="ed-ot" type="text" inputmode="decimal" size="10" value="' + esc(l.overtimePremium) + '"></label>' +
          '<label class="chk"><input id="ed-otx" type="checkbox"' + (l.overtimeExcluded ? " checked" : "") + "> Leave overtime premium out</label>" +
          '<label class="reason">Reason (required)<input id="ed-reason" type="text" maxlength="300"></label>' +
          '<button class="btn sm" type="button" data-act="saveline" data-id="' + esc(l.id) + '">Save</button>' +
          '<button class="iconbtn" type="button" data-act="cancelline">Cancel</button></div></td></tr>');
      }
    });
    return out + table(["", "Payee", "Class", "#Gross payroll", "#Overtime premium", "#Counted", "Source", "Set by", "Flag", "Actions"], rows);
  }

  function tabOfficers() {
    var c = C(), t = T(), o = t.officers || {}, people = o.people || [], lim = o.limits || {};
    var out = "<h3>Officers</h3>";
    out += table(["Name", "Title", "Class", "#Actual pay", "#Counted pay", "Status", "Why", "Actions"], (c.officers || []).map(function (of, i) {
      var p = people.filter(function (x) { return x.name === of.name; })[0] || people[i] || {};
      var inc = of.status === "included";
      return '<tr data-rowid="' + esc(of.id) + '"><td>' + esc(of.name) + "</td><td>" + esc(of.title) + "</td><td>" + esc(of.classCode) + '</td><td class="num">' + esc(money(p.actualPayroll != null ? p.actualPayroll : of.payroll)) +
        '</td><td class="num">' + esc(money(p.countedPayroll)) + "</td><td>" + (inc ? "Included" : "Excluded") + "</td><td>" + esc(p.reason || "") + srcLink(of.source) + "</td>" +
        '<td><div class="rowact"><button class="iconbtn" type="button" data-act="offtoggle" data-id="' + esc(of.id) + '" data-to="' + (inc ? "excluded" : "included") + '">' + (inc ? "Exclude" : "Include") + "</button>" +
        '<button class="iconbtn" type="button" data-act="offclass" data-id="' + esc(of.id) + '">Change class</button></div></td></tr>';
    }));
    var lt = [];
    if (lim.source) lt.push("Source: " + lim.source);
    if (lim.minimum != null) lt.push("Minimum: " + money(lim.minimum));
    if (lim.maximum != null) lt.push("Maximum: " + money(lim.maximum));
    if (lim.ownerAmount != null) lt.push("Owner amount: " + money(lim.ownerAmount));
    if (lt.length) out += '<p class="small-note"><b>Officer limits.</b> ' + esc(lt.join(" · ")) + "</p>";
    var sr = o.stateRules;
    if (sr) {
      if (sr.notes && sr.notes.length) out += '<ul class="small">' + sr.notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>";
      if (sr.citations && sr.citations.length) out += '<p class="small muted">Citations: ' + esc(sr.citations.join("; ")) + "</p>";
    }
    var pol = c.policyExpirationDate;
    out += "<h3>Subcontractors</h3>" + table(["Name", "Work", "Class", "#Paid", "Certificate expires", "Treatment", "Source", "Actions"], (c.subs || []).map(function (s) {
      var lapsed = s.coiExpires && pol && s.coiExpires < pol;
      var uni = s.treatment === "uninsured";
      return '<tr data-rowid="' + esc(s.id) + '"><td>' + esc(s.name) + "</td><td>" + esc(s.work) + "</td><td>" + esc(s.classCode) + '</td><td class="num">' + esc(fmtDec(s.paid)) + "</td><td>" +
        (s.coiExpires ? (lapsed ? '<span class="warncell">' + esc(fmtDate(s.coiExpires)) + " (before policy ends)</span>" : esc(fmtDate(s.coiExpires))) : "None on file") +
        "</td><td>" + (uni ? "Uninsured" : "Insured") + "</td><td>" + srcLink(s.source) + "</td>" +
        '<td><div class="rowact"><button class="iconbtn" type="button" data-act="subtoggle" data-id="' + esc(s.id) + '" data-to="' + (uni ? "insured" : "uninsured") + '">Treat as ' + (uni ? "insured" : "uninsured") + "</button>" +
        '<button class="iconbtn" type="button" data-act="subclass" data-id="' + esc(s.id) + '">Change class</button></div></td></tr>';
    }));
    return out;
  }

  function citedBy(docId) {
    var c = C(), refs = [];
    (c.lines || []).forEach(function (x) { if (x.source && x.source.doc === docId) refs.push(x.id); });
    (c.officers || []).forEach(function (x) { if (x.source && x.source.doc === docId) refs.push(x.id); });
    (c.subs || []).forEach(function (x) { if (x.source && x.source.doc === docId) refs.push(x.id); });
    (c.findings || []).forEach(function (x) { if ((x.refs || []).indexOf(docId) >= 0) refs.push(x.id); });
    return refs;
  }
  function chip(r) { return '<button type="button" class="refchip" data-act="ref" data-ref="' + esc(r) + '">' + esc(r) + "</button>"; }

  function tabDocuments() {
    return '<div class="callout info">Uploads are off in the preview. Documents here are sample records.</div>' +
      table(["Document", "Type", "Period", "#Pages", "Cited by"], (C().documents || []).map(function (d) {
        return '<tr data-rowid="' + esc(d.id) + '"><td><b>' + esc(d.id) + "</b> " + esc(d.name) + "</td><td>" + esc(d.type) + "</td><td>" + esc(d.period) + '</td><td class="num">' + esc(d.pages) + "</td><td>" + (citedBy(d.id).map(chip).join("") || '<span class="muted">Nothing yet</span>') + "</td></tr>";
      }));
  }

  function tabFindings() {
    var list = C().findings || [];
    if (!list.length) return '<p class="muted">No findings on this case.</p>';
    return '<div class="cardlist">' + list.map(function (f) {
      var st = f.status;
      return '<div class="fcard" data-rowid="' + esc(f.id) + '"><div class="row"><b>' + esc(f.title) + '</b><span class="spill' + (st === "open" ? " side" : (st === "accepted" ? " final" : "")) + '">' + esc(st) + "</span></div><div>" + esc(f.detail) + "</div>" +
        '<div class="row">' + (f.refs || []).map(chip).join("") + "</div>" +
        '<div class="row">' + (st !== "accepted" ? '<button class="btn sm" type="button" data-act="finding" data-id="' + esc(f.id) + '" data-to="accepted">Accept</button>' : "") +
        (st !== "rejected" ? '<button class="btn ghost sm" type="button" data-act="finding" data-id="' + esc(f.id) + '" data-to="rejected">Reject</button>' : "") +
        (st !== "open" ? '<button class="iconbtn" type="button" data-act="finding" data-id="' + esc(f.id) + '" data-to="open">Reopen</button>' : "") + "</div></div>";
    }).join("") + "</div>";
  }

  function tabTimeline() {
    var chk = S.data.timelineCheck || {}, evs = (C().timeline || []).slice().sort(function (a, b) { return b.seq - a.seq; });
    var undone = {};
    evs.forEach(function (e) { if (e.undoes != null) undone[e.undoes] = true; });
    var out = '<div class="chain ' + (chk.ok ? "ok" : "bad") + '">' + (chk.ok ? "Hash chain verified · " + esc(chk.events) + " events" : "Chain broken at #" + esc(chk.brokenAt)) + "</div>" +
      '<div class="notebox"><label class="sr" for="note-in">Add a note</label><textarea id="note-in" rows="2" maxlength="1000" placeholder="Add a note to this case"></textarea><button class="btn sm" type="button" data-act="addnote">Add note</button></div>';
    var notes = C().notes || [];
    if (notes.length) out += '<ul class="notes">' + notes.map(function (n) { return "<li><b>" + esc(n.author) + "</b> <span class=\"muted\">" + esc(fmtTime(n.at)) + "</span><br>" + esc(n.text) + "</li>"; }).join("") + "</ul>";
    out += '<ul class="tl">' + evs.map(function (e) {
      var canUndo = e.target && e.before != null && e.after != null && e.action !== "undo" && e.undoes == null && !undone[e.seq];
      return '<li data-rowid="e' + esc(e.seq) + '"><div class="top"><span class="seq">#' + esc(e.seq) + "</span><b>" + esc(e.actor) + (e.via === "penny" ? " (via Penny)" : "") + "</b><span class=\"muted\">" + esc(fmtTime(e.at)) + "</span>" +
        (canUndo ? '<button class="iconbtn" type="button" data-act="undo" data-seq="' + esc(e.seq) + '">Undo</button>' : "") + "</div><div>" + esc(e.summary) + "</div>" +
        (e.reason ? '<div class="small muted">Reason: ' + esc(e.reason) + "</div>" : "") +
        (e.before != null || e.after != null ? '<div class="kv">' + esc(kv(e.before)) + " → " + esc(kv(e.after)) + "</div>" : "") +
        (e.premium ? '<div class="small">Estimated audit premium ' + esc(money(e.premium.before)) + " → " + esc(money(e.premium.after)) + "</div>" : "") + "</li>";
    }).join("") + "</ul>";
    return out;
  }

  function tabReports() {
    var id = encodeURIComponent(S.caseId);
    return '<div class="repbtns"><a class="btn" href="/api/workspace/cases/' + id + '/report" target="_blank" rel="noopener">Audit report (print or save as PDF)</a>' +
      '<a class="btn ghost" href="/api/workspace/cases/' + id + '/worksheet.csv" download>Worksheet (CSV, opens in Excel)</a></div>' +
      '<p class="small-note">Exports are built by deterministic code from the engine\'s runs, not written by Penny.</p>';
  }

  /* ---------- data actions ---------- */
  function applyResult(res) {
    if (res && res.case) S.data = { case: res.case, totals: res.totals, timelineCheck: res.timelineCheck };
    renderCenter(true);
    api("/api/workspace/cases").then(function (j) { S.cases = j.cases || []; renderRail(); }).catch(function () {});
  }
  function act(action, via) {
    var opts = { body: { action: action } };
    if (via) opts.via = via;
    return api("/api/workspace/cases/" + encodeURIComponent(S.caseId) + "/actions", opts).then(function (res) {
      applyResult(res);
      return res;
    }).catch(function (e) { toast(e.message, true); return null; });
  }
  function needReason(label) {
    var r = window.prompt(label || "Reason for this change (required)");
    r = r == null ? null : r.trim();
    if (!r) { if (r !== null) toast("A reason is required.", true); return null; }
    return r;
  }

  function loadCase(id) {
    S.caseId = id; S.sel = {}; S.editLine = null; S.editOps = false; S.data = null;
    center.innerHTML = '<p class="muted pad">Loading…</p>';
    renderRail(); renderChat(); location.hash = "case=" + encodeURIComponent(id);
    return api("/api/workspace/cases/" + encodeURIComponent(id)).then(function (res) {
      if (S.caseId !== id) return;
      S.data = res; renderCenter(false);
    }).catch(function (e) { center.innerHTML = '<div class="callout bad pad">' + esc(e.message) + "</div>"; });
  }

  function goRef(ref) {
    var c = C(), tab = null;
    if ((c.lines || []).some(function (x) { return x.id === ref; })) tab = "worksheet";
    else if ((c.officers || []).some(function (x) { return x.id === ref; }) || (c.subs || []).some(function (x) { return x.id === ref; })) tab = "officers";
    else if ((c.documents || []).some(function (x) { return x.id === ref; })) tab = "documents";
    else if ((c.findings || []).some(function (x) { return x.id === ref; })) tab = "findings";
    if (!tab) return;
    S.tab = tab; S.hl = ref; renderCenter(false);
  }

  /* ---------- clicks ---------- */
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]");
    if (!b || b.tagName === "INPUT") return;
    var a = b.getAttribute("data-act"), id = b.getAttribute("data-id");
    var h = handlers[a];
    if (h) h(b, id);
  });
  document.addEventListener("change", function (ev) {
    var b = ev.target;
    if (b.getAttribute && b.getAttribute("data-act") === "selrow") {
      if (b.checked) S.sel[b.getAttribute("data-id")] = true; else delete S.sel[b.getAttribute("data-id")];
      renderCenter(true);
    }
  });

  var handlers = {
    pick: function (b, id) { closeRail(); loadCase(id); },
    tab: function (b) { S.tab = b.getAttribute("data-tab"); renderCenter(false); var t = center.querySelector('[data-tab="' + S.tab + '"]'); if (t) t.focus(); },
    ref: function (b) { goRef(b.getAttribute("data-ref")); },
    next: function (b) { act({ type: "set_status", status: b.getAttribute("data-status") }); },
    setstatus: function () {
      var s = $("st-sel").value, r = $("st-reason").value.trim(), a = { type: "set_status", status: s };
      if (r) a.reason = r;
      act(a);
    },
    editops: function () { S.editOps = true; renderCenter(true); var i = $("ops-in"); if (i) i.focus(); },
    cancelops: function () { S.editOps = false; renderCenter(true); },
    saveops: function () {
      var v = $("ops-in").value.trim();
      if (!v) { toast("Write the description first.", true); return; }
      act({ type: "set_operations", text: v }).then(function (r) { if (r) { S.editOps = false; renderCenter(true); } });
    },
    draftops: function () {
      $("penny").classList.add("open");
      sendChat("Draft the description of operations for this case's audit report from the case records.");
    },
    editline: function (b, id) { S.editLine = S.editLine === id ? null : id; renderCenter(true); },
    cancelline: function () { S.editLine = null; renderCenter(true); },
    saveline: function (b, id) {
      var l = C().lines.filter(function (x) { return x.id === id; })[0], reason = $("ed-reason").value.trim();
      var a = { type: "update_line", lineId: id, reason: reason };
      var cc = $("ed-class").value.trim(), pay = $("ed-pay").value.trim(), ot = $("ed-ot").value.trim(), otx = $("ed-otx").checked;
      var changed = false;
      if (cc !== l.classCode) { a.classCode = cc; changed = true; }
      if (pay !== String(l.payroll)) { a.payroll = pay; changed = true; }
      if (ot !== String(l.overtimePremium)) { a.overtimePremium = ot; changed = true; }
      if (otx !== !!l.overtimeExcluded) { a.overtimeExcluded = otx; changed = true; }
      if (!changed) { toast("Nothing changed.", true); return; }
      if (!reason) { toast("A reason is required.", true); $("ed-reason").focus(); return; }
      act(a).then(function (r) { if (r) S.editLine = null, renderCenter(true); });
    },
    keepline: function (b, id) { var r = needReason("Why keep this line as is? (required)"); if (r) act({ type: "clear_flag", lineId: id, reason: r }); },
    bulkmove: function () {
      var ids = Object.keys(S.sel), cc = $("bk-class").value.trim(), r = $("bk-reason").value.trim();
      if (!cc || !r) { toast("Enter a class code and a reason.", true); return; }
      var p = Promise.resolve(true);
      ids.forEach(function (id) {
        p = p.then(function (ok) {
          if (!ok) return false;
          return act({ type: "update_line", lineId: id, classCode: cc, reason: r }).then(function (res) { return !!res; });
        });
      });
      p.then(function (ok) { if (ok) { S.sel = {}; renderCenter(true); toast("Moved " + ids.length + " line" + (ids.length === 1 ? "" : "s") + " to " + cc + "."); } });
    },
    offtoggle: function (b, id) { var r = needReason(); if (r) act({ type: "set_officer", officerId: id, status: b.getAttribute("data-to"), reason: r }); },
    offclass: function (b, id) {
      var cc = window.prompt("New class code"); if (!cc || !cc.trim()) return;
      var r = needReason(); if (r) act({ type: "set_officer", officerId: id, classCode: cc.trim(), reason: r });
    },
    subtoggle: function (b, id) { var r = needReason(); if (r) act({ type: "set_sub", subId: id, treatment: b.getAttribute("data-to"), reason: r }); },
    subclass: function (b, id) {
      var cc = window.prompt("New class code"); if (!cc || !cc.trim()) return;
      var r = needReason(); if (r) act({ type: "set_sub", subId: id, classCode: cc.trim(), reason: r });
    },
    finding: function (b, id) {
      var to = b.getAttribute("data-to"), a = { type: "set_finding", findingId: id, status: to };
      if (to === "rejected") { var r = window.prompt("Reason for rejecting (optional)"); if (r === null) return; if (r.trim()) a.reason = r.trim(); }
      act(a);
    },
    addnote: function () {
      var t = $("note-in").value.trim();
      if (!t) { toast("Write a note first.", true); return; }
      act({ type: "add_note", text: t });
    },
    undo: function (b) { act({ type: "undo", seq: Number(b.getAttribute("data-seq")) }); },
    verify: function (b) {
      var rid = b.getAttribute("data-run"), out = center.querySelector('[data-vout="' + rid.replace(/"/g, "") + '"]');
      if (out) out.textContent = "Checking…";
      api("/api/runs/" + encodeURIComponent(rid)).then(function (j) {
        return api("/api/replay", { body: { receipt: j.run } });
      }).then(function (j) { if (out) out.textContent = j.reproduced ? "Reproduced" : "Did not reproduce"; })
        .catch(function (e) { if (out) out.textContent = e.message; });
    },
    chip: function (b) { sendChat(b.getAttribute("data-q")); },
    apply: function (b) { cardApply(+b.getAttribute("data-m"), +b.getAttribute("data-c")); },
    dismiss: function (b) { cardSet(+b.getAttribute("data-m"), +b.getAttribute("data-c"), { state: "dismissed" }); },
    cundo: function (b) {
      var m = +b.getAttribute("data-m"), ci = +b.getAttribute("data-c"), cd = chatList()[m].cards[ci];
      act({ type: "undo", seq: cd.seq }).then(function (r) { if (r) cardSet(m, ci, { state: "undone" }); });
    }
  };

  /* ---------- Penny chat ---------- */
  var PROMPTS = ["Why is Tom Becker flagged?", "What's left before Draft ready?", "Move Tom Becker to 8742", "Explain the premium"];
  $("chips").innerHTML = PROMPTS.map(function (q) { return '<button type="button" class="chip" data-act="chip" data-q="' + esc(q) + '">' + esc(q) + "</button>"; }).join("");

  function chatList() { return S.chats[S.caseId] || (S.chats[S.caseId] = []); }

  function cardHtml(m, ci, cd) {
    var c = cd.card, st = cd.state || "pending", p = c.premium;
    var h = '<div class="ccard ' + (st === "applied" ? "applied" : (st === "dismissed" || st === "undone" ? "dismissed" : "")) + '"><b>' + esc(c.summary) + "</b>";
    if (c.before != null || c.after != null) h += '<div class="kv">' + esc(kv(c.before)) + " → " + esc(kv(c.after)) + "</div>";
    if (p) h += '<div class="prem">Estimated audit premium ' + esc(money(p.before)) + " → " + esc(money(p.after)) + (p.change != null ? " (" + esc(signed(p.change)) + ")" : "") + "</div>";
    if (c.movesMoney) h += '<div class="money">This changes the premium.</div>';
    if (st === "pending") h += '<div class="btns"><button class="btn sm" type="button" data-act="apply" data-m="' + m + '" data-c="' + ci + '">Apply</button><button class="btn ghost sm" type="button" data-act="dismiss" data-m="' + m + '" data-c="' + ci + '">Dismiss</button></div>';
    else if (st === "applied") h += '<div class="btns"><span class="spill final">Applied · #' + esc(cd.seq) + '</span><button class="iconbtn" type="button" data-act="cundo" data-m="' + m + '" data-c="' + ci + '">Undo</button></div>';
    else if (st === "undone") h += '<div class="btns"><span class="spill">Undone</span></div>';
    else h += '<div class="btns"><span class="spill">Dismissed</span></div>';
    return h + "</div>";
  }
  function msgHtml(m, i) {
    var x = chatList()[i];
    var h = '<div class="b">' + esc(x.content) + "</div>";
    (x.cards || []).forEach(function (cd, ci) { h += cardHtml(i, ci, cd); });
    if (x.receipts && x.receipts.length) h += '<div class="receipts">Engine runs: ' + esc(x.receipts.map(function (r) { return String(r.fingerprint || r.runId || r).slice(0, 12); }).join(", ")) + "</div>";
    return h;
  }
  function addMsgEl(i) {
    var x = chatList()[i], el = document.createElement("div");
    el.className = "msg " + (x.role === "user" ? "user" : "penny");
    el.setAttribute("data-i", i);
    el.innerHTML = msgHtml(x, i);
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function renderChat() {
    logEl.innerHTML = "";
    var l = chatList();
    if (!l.length && S.caseId) {
      var cs = S.cases.filter(function (c) { return c.id === S.caseId; })[0];
      l.push({ role: "assistant", local: true, content: "I know this case" + (cs ? " (" + cs.insured + ")" : "") + ". Ask me why a line is where it is, what's left, or ask for a change. I'll show it as a card for you to apply." });
    }
    l.forEach(function (x, i) { addMsgEl(i); });
  }
  function cardSet(m, ci, patch) {
    var cd = chatList()[m].cards[ci];
    Object.keys(patch).forEach(function (k) { cd[k] = patch[k]; });
    var el = logEl.querySelector('[data-i="' + m + '"]');
    if (el) el.innerHTML = msgHtml(chatList()[m], m);
  }
  function cardApply(m, ci) {
    var cd = chatList()[m].cards[ci];
    act(cd.card.action, "penny").then(function (res) {
      if (res) cardSet(m, ci, { state: "applied", seq: res.event && res.event.seq });
    });
  }

  var sending = false;
  function sendChat(text) {
    text = (text || "").trim();
    if (!text || sending || !S.caseId) return;
    if (text.length > 4000) { toast("Messages can be up to 4,000 characters.", true); return; }
    var id = S.caseId, l = chatList();
    l.push({ role: "user", content: text });
    addMsgEl(l.length - 1);
    $("chatin").value = "";
    sending = true; $("chatform").querySelector(".send").disabled = true;
    var ty = document.createElement("div");
    ty.className = "msg typing"; ty.innerHTML = '<div class="dots" aria-label="Penny is typing"><i></i><i></i><i></i></div>';
    logEl.appendChild(ty); logEl.scrollTop = logEl.scrollHeight;
    var msgs = l.filter(function (x) { return !x.local; }).slice(-20).map(function (x) { return { role: x.role, content: x.content }; });
    api("/api/workspace/cases/" + encodeURIComponent(id) + "/chat", { body: { messages: msgs } }).then(function (res) {
      var list = S.chats[id];
      list.push({ role: "assistant", content: res.reply || "", cards: (res.cards || []).map(function (c) { return { card: c, state: "pending" }; }), receipts: res.receipts });
      if (S.caseId === id) { if (ty.parentNode) ty.parentNode.removeChild(ty); addMsgEl(list.length - 1); }
    }).catch(function (e) {
      S.chats[id].push({ role: "assistant", local: true, content: "Sorry, I couldn't answer that: " + e.message });
      if (S.caseId === id) { if (ty.parentNode) ty.parentNode.removeChild(ty); addMsgEl(S.chats[id].length - 1); }
    }).then(function () { sending = false; $("chatform").querySelector(".send").disabled = false; });
  }
  $("chatform").addEventListener("submit", function (e) { e.preventDefault(); sendChat($("chatin").value); });
  $("chatin").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat($("chatin").value); }
  });

  /* ---------- chrome ---------- */
  function closeRail() { $("rail").classList.remove("open"); $("railbtn").setAttribute("aria-expanded", "false"); }
  $("railbtn").addEventListener("click", function () {
    var o = $("rail").classList.toggle("open"); $("railbtn").setAttribute("aria-expanded", String(o));
  });
  $("fab").addEventListener("click", function () { $("penny").classList.add("open"); $("chatin").focus(); });
  $("sheetclose").addEventListener("click", function () { $("penny").classList.remove("open"); $("fab").focus(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { $("penny").classList.remove("open"); closeRail(); }
  });
  $("signout").addEventListener("click", function () {
    api("/api/auth/logout", { body: {} }).catch(function () {}).then(function () { location.href = "/login.html"; });
  });
  $("resetbtn").addEventListener("click", function () {
    if (!window.confirm("Reset all sample data? Changes and notes you made will be lost.")) return;
    api("/api/workspace/reset", { body: {} }).then(function () { location.reload(); }).catch(function (e) { toast(e.message, true); });
  });

  /* ---------- start ---------- */
  api("/api/auth/me").then(function (me) {
    S.user = me.user;
    $("who").textContent = me.user.displayName || me.user.username;
    return api("/api/workspace/cases");
  }).then(function (j) {
    S.cases = j.cases || [];
    renderRail();
    if (!S.cases.length) { center.innerHTML = '<p class="muted pad">No cases yet.</p>'; return; }
    var m = /case=([^&]+)/.exec(location.hash), want = m ? decodeURIComponent(m[1]) : null;
    var pick = S.cases.filter(function (c) { return c.id === want; })[0] || S.cases[0];
    return loadCase(pick.id);
  }).catch(function (e) { center.innerHTML = '<div class="callout bad pad">' + esc(e.message) + "</div>"; });
})();
