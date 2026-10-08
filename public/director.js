(function () {
  "use strict";

  var ORDER = ["Assigned", "Scheduled", "Records requested", "Waiting on insured", "Records received", "In review", "Draft ready", "Director review", "Returned for revision", "Submitted to carrier"];
  var SIDE = ["Waiting on insured", "Returned for revision", "Non-compliant", "Cancelled"];
  var KINDS = { overdue: "Overdue", stalled: "Stalled", coi: "COI", flags: "Flags" };

  var $ = function (id) { return document.getElementById(id); };
  var main = $("main");
  var board = null, filterText = "", filterAuditor = "", busy = false;

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDate(s) {
    if (!s) return "—";
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    return m ? m[2] + "/" + m[3] + "/" + m[1] : String(s);
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
    return fetch(path, {
      method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
      credentials: "same-origin",
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) { location.href = "/login.html"; return new Promise(function () {}); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ("Request failed (" + r.status + ")"));
        return j;
      });
    });
  }
  function num(n) { return n == null ? 0 : n; }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function link(id) { return "workspace.html#case=" + encodeURIComponent(id); }
  function statusPill(s) {
    return '<span class="spill' + (SIDE.indexOf(s) >= 0 ? " side" : "") + '">' + esc(s) + "</span>";
  }
  function samplePill() { return '<span class="spill sample">Sample</span>'; }

  function dueText(r) {
    var d = r.daysToDue;
    if (d == null) return "";
    if (d < 0) return plural(-d, "day", "days") + " overdue";
    if (d === 0) return "due today";
    return "in " + plural(d, "day", "days");
  }
  function dueHtml(r) {
    var cls = r.daysToDue != null && r.daysToDue < 0 ? "late" : (r.daysToDue != null && r.daysToDue <= 7 ? "soon" : "");
    return '<span class="' + cls + '">' + esc(fmtDate(r.dueDate)) + (dueText(r) ? " (" + esc(dueText(r)) + ")" : "") + "</span>";
  }
  function diffText(r) {
    if (!r.difference) return "";
    var d = r.difference, res = d.result;
    if (res === "additional premium") return "Additional premium " + d.display;
    if (res === "return premium") return "Return premium " + d.display;
    return res === "no change" ? "No change in premium" : String(d.display || "");
  }
  function chips(r) {
    var o = "";
    if (r.openFlags) o += '<span class="spill flag">' + plural(r.openFlags, "flag", "flags") + "</span>";
    if (r.openFindings) o += '<span class="spill">' + plural(r.openFindings, "finding", "findings") + "</span>";
    if (r.coiGaps) o += '<span class="spill coiwarn">' + plural(r.coiGaps, "COI gap", "COI gaps") + "</span>";
    return o;
  }

  /* ---------- sections ---------- */
  function renderStrip(t) {
    var items = [
      ["Open audits", t.open, ""], ["Due this week", t.dueThisWeek, ""],
      ["Overdue", t.overdue, t.overdue > 0 ? "late" : ""], ["Awaiting your review", t.awaitingReview, ""],
      ["Waiting on insured", t.waitingOnInsured, ""], ["Average days open", t.averageDaysOpen, ""]
    ];
    return '<div class="strip">' + items.map(function (i) {
      return "<div><small>" + esc(i[0]) + '</small><b class="' + i[2] + '">' + esc(i[1] == null ? "—" : i[1]) + "</b></div>";
    }).join("") + "</div>";
  }

  function renderQueue(rows) {
    var h = '<section class="dircard" aria-labelledby="hq"><h2 id="hq">Review queue</h2>';
    if (!rows.length) return h + '<p class="muted">Nothing waiting on you.</p></section>';
    h += '<ul class="dirlist">' + rows.map(function (r) {
      var premium = r.premium ? "Est. premium " + r.premium : "";
      var diff = diffText(r);
      var s = '<li><div class="top"><span class="nm">' + esc(r.insured) + "</span>" + statusPill(r.status) + (r.live ? "" : samplePill()) + "</div>";
      s += '<div class="meta"><span>' + esc(r.auditor) + "</span><span>Due " + dueHtml(r) + "</span>" +
        (premium ? "<span>" + esc(premium) + "</span>" : "") + (diff ? "<span>" + esc(diff) + "</span>" : "") + "</div>";
      var c = chips(r);
      if (c) s += '<div class="chips">' + c + "</div>";
      if (r.live) {
        s += '<div class="acts"><a class="btn ghost sm" href="' + link(r.id) + '">Open case</a>' +
          '<button class="btn sm" type="button" data-act="approve" data-id="' + esc(r.id) + '">Approve</button>' +
          '<button class="btn ghost sm" type="button" data-act="return" data-id="' + esc(r.id) + '">Return</button></div>';
      }
      return s + "</li>";
    }).join("") + "</ul></section>";
    return h;
  }

  function renderAttention(items) {
    var h = '<section class="dircard" aria-labelledby="ha"><h2 id="ha">Needs attention</h2>';
    if (!items.length) return h + '<p class="muted">Nothing needs attention.</p></section>';
    return h + '<ul class="dirlist">' + items.map(function (a) {
      var nm = a.live ? '<a class="nm" href="' + link(a.id) + '">' + esc(a.insured) + "</a>" : '<span class="nm">' + esc(a.insured) + "</span>";
      return '<li><div class="top"><span class="kind ' + esc(a.kind) + '">' + esc(KINDS[a.kind] || a.kind) + "</span>" + nm + (a.live ? "" : samplePill()) + "</div>" +
        '<div class="meta"><span>' + esc(a.auditor) + "</span></div><div>" + esc(a.text) + "</div></li>";
    }).join("") + "</ul></section>";
  }

  function renderAuditors(list) {
    var max = 0;
    list.forEach(function (a) { if (a.open > max) max = a.open; });
    var h = '<section class="dircard" aria-labelledby="hb"><h2 id="hb">By auditor</h2><div class="tablebox"><table class="ws"><thead><tr>' +
      '<th scope="col">Auditor</th><th scope="col"><span class="sr">Share of open audits</span></th><th class="num" scope="col">Open</th><th class="num" scope="col">Due this week</th><th class="num" scope="col">Overdue</th>' +
      '<th class="num" scope="col">In review</th><th class="num" scope="col">Waiting on insured</th><th class="num" scope="col">Open flags</th></tr></thead><tbody>';
    list.forEach(function (a) {
      var pct = max ? Math.round(num(a.open) / max * 100) : 0;
      h += "<tr><td>" + esc(a.auditor) + (a.live ? ' <span class="spill sample">You</span>' : "") + "</td>" +
        '<td><div class="barrow"><div class="bar" aria-hidden="true"><i style="width:' + pct + '%"></i></div></div></td>' +
        '<td class="num">' + esc(num(a.open)) + '</td><td class="num">' + esc(num(a.dueThisWeek)) + '</td><td class="num' + (a.overdue > 0 ? " late" : "") + '">' + esc(num(a.overdue)) +
        '</td><td class="num">' + esc(num(a.inReview)) + '</td><td class="num">' + esc(num(a.waitingOnInsured)) + '</td><td class="num">' + esc(num(a.flags)) + "</td></tr>";
    });
    return h + "</tbody></table></div></section>";
  }

  function renderStatus(by) {
    var keys = ORDER.filter(function (k) { return by[k] != null; });
    Object.keys(by).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    var max = 0;
    keys.forEach(function (k) { if (by[k] > max) max = by[k]; });
    return '<section class="dircard" aria-labelledby="hs"><h2 id="hs">Status across the team</h2><ul class="statuschart">' + keys.map(function (k) {
      var pct = max ? Math.round(by[k] / max * 100) : 0;
      return "<li><span>" + esc(k) + '</span><div class="bar" aria-hidden="true"><i style="width:' + pct + '%"></i></div><b>' + esc(by[k]) + "</b></li>";
    }).join("") + "</ul></section>";
  }

  function visibleCases() {
    var q = filterText.trim().toLowerCase();
    return (board.cases || []).filter(function (r) {
      if (filterAuditor && r.auditor !== filterAuditor) return false;
      if (!q) return true;
      return [r.insured, r.auditor, r.status].join(" ").toLowerCase().indexOf(q) >= 0;
    });
  }

  function caseRows(rows) {
    if (!rows.length) return '<tr><td colspan="10" class="muted">No audits match.</td></tr>';
    return rows.map(function (r) {
      var late = r.daysToDue != null && r.daysToDue < 0;
      return "<tr><td>" + (r.live ? '<a href="' + link(r.id) + '">' + esc(r.insured) + "</a>" : esc(r.insured) + " " + samplePill()) + "</td>" +
        "<td>" + esc(r.auditor) + "</td><td>" + esc(r.state || "—") + "</td><td>" + statusPill(r.status) + "</td>" +
        '<td class="' + (late ? "late" : "") + '">' + esc(fmtDate(r.dueDate)) + (late ? "<br><small>" + esc(dueText(r)) + "</small>" : "") + "</td>" +
        '<td class="num">' + esc(num(r.daysOpen)) + '</td><td class="num">' + esc(num(r.openFlags)) + '</td><td class="num">' + esc(num(r.openFindings)) +
        '</td><td class="num">' + esc(num(r.coiGaps)) + '</td><td class="num">' + esc(r.premium || "—") + "</td></tr>";
    }).join("");
  }

  function renderAll() {
    var names = [];
    (board.cases || []).forEach(function (r) { if (names.indexOf(r.auditor) < 0) names.push(r.auditor); });
    var opts = '<option value="">All auditors</option>' + names.map(function (n) {
      return '<option value="' + esc(n) + '"' + (n === filterAuditor ? " selected" : "") + ">" + esc(n) + "</option>";
    }).join("");
    return '<section class="dircard" aria-labelledby="hl"><h2 id="hl">All open audits</h2><div class="dirfilters">' +
      '<label class="sr" for="dfilter">Search audits</label><input id="dfilter" type="search" placeholder="Search insured, auditor or status" autocomplete="off" value="' + esc(filterText) + '">' +
      '<label class="sr" for="dauditor">Auditor</label><select id="dauditor">' + opts + "</select></div>" +
      '<div class="tablebox"><table class="ws"><thead><tr><th scope="col">Insured</th><th scope="col">Auditor</th><th scope="col">State</th><th scope="col">Status</th><th scope="col">Due</th>' +
      '<th class="num" scope="col">Days open</th><th class="num" scope="col">Flags</th><th class="num" scope="col">Findings</th><th class="num" scope="col">COI gaps</th><th class="num" scope="col">Est. premium</th></tr></thead>' +
      '<tbody id="casebody">' + caseRows(visibleCases()) + "</tbody></table></div></section>";
  }

  function render() {
    var b = board;
    main.innerHTML = '<div class="dirwrap">' +
      '<div class="dirtitle"><div><h1>Team board</h1><p>Every open audit across your team</p></div>' +
      (b.note ? '<p class="callout info">' + esc(b.note) + "</p>" : "") + "</div>" +
      renderStrip(b.team || {}) +
      '<div class="dircols">' + renderQueue(b.reviewQueue || []) + renderAttention(b.attention || []) + "</div>" +
      renderAuditors(b.byAuditor || []) + renderStatus(b.byStatus || {}) + renderAll() +
      '<p class="dirfoot">Director console is an Enterprise feature. Preview with sample data.<br><a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></p></div>';
  }

  function load() {
    return api("/api/director/board").then(function (b) { board = b; render(); }).catch(function (e) {
      main.innerHTML = '<p class="callout bad">' + esc(e.message) + "</p>";
    });
  }

  function findRow(id) {
    var rows = (board.reviewQueue || []).concat(board.cases || []);
    for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i];
    return null;
  }

  function act(kind, id, btn) {
    var r = findRow(id);
    if (!r || busy) return;
    var action;
    if (kind === "approve") {
      if (!confirm("Approve " + r.insured + " and send it to the carrier?")) return;
      action = { type: "set_status", status: "Submitted to carrier" };
    } else {
      var reason = prompt("Why are you returning " + r.insured + " to the auditor?");
      if (reason == null) return;
      reason = reason.trim();
      if (!reason) { toast("Add a reason so the auditor knows what to fix.", true); return; }
      action = { type: "set_status", status: "Returned for revision", reason: reason };
    }
    busy = true; btn.disabled = true;
    api("/api/workspace/cases/" + encodeURIComponent(id) + "/actions", { body: { action: action } }).then(function () {
      toast(kind === "approve" ? "Approved: sent to the carrier" : "Returned to the auditor");
      return load();
    }).catch(function (e) { toast(e.message, true); btn.disabled = false; }).then(function () { busy = false; });
  }

  main.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("button[data-act]") : null;
    if (b) act(b.getAttribute("data-act"), b.getAttribute("data-id"), b);
  });
  function refreshTable() { var tb = $("casebody"); if (tb) tb.innerHTML = caseRows(visibleCases()); }
  main.addEventListener("input", function (e) {
    if (e.target.id === "dfilter") { filterText = e.target.value; refreshTable(); }
  });
  main.addEventListener("change", function (e) {
    if (e.target.id === "dauditor") { filterAuditor = e.target.value; refreshTable(); }
  });

  $("signout").addEventListener("click", function () {
    api("/api/auth/logout", { method: "POST", body: {} }).catch(function () {}).then(function () { location.href = "/login.html"; });
  });

  api("/api/auth/me").then(function (me) {
    var u = me.user || {};
    if (u.role === "business") { location.href = "/insured.html"; return; }
    $("who").textContent = u.displayName || u.username || "";
    return load();
  }).catch(function (e) { main.innerHTML = '<p class="callout bad">' + esc(e.message) + "</p>"; });
})();
