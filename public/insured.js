(function () {
  "use strict";

  var MAX_FILES = 10, MAX_NAME = 150, MAX_BYTES = 50 * 1024 * 1024;
  var PROMPTS = ["What is a Form 941?", "Why do you need my subcontractor certificates?", "What happens after I send everything?", "How is my audit bill figured?"];

  var S = { user: null, view: null, whyOpen: {}, busy: false, chat: [], sending: false };
  var $ = function (id) { return document.getElementById(id); };
  var app = $("app"), logEl = $("log");

  /* ---------- helpers ---------- */
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ""));
    return m ? MON[+m[2] - 1] + " " + (+m[3]) + ", " + m[1] : String(s || "");
  }
  function fmtStamp(t) {
    var d = new Date(t);
    if (isNaN(d)) return String(t || "");
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function fmtSize(n) {
    n = +n || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  function toast(msg, bad) {
    var el = document.createElement("div");
    el.className = "toast" + (bad ? " err" : "");
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, bad ? 6000 : 3500);
  }
  // An auditor can open this portal for one of their cases (?case=ID) to see what the insured sees.
  var CASE = (function () { try { return new URLSearchParams(location.search).get("case") || ""; } catch (e) { return ""; } })();
  function api(path, opts) {
    opts = opts || {};
    if (CASE && path.indexOf("/api/insured/") === 0) path += (path.indexOf("?") < 0 ? "?" : "&") + "case=" + encodeURIComponent(CASE);
    return fetch(path, {
      method: opts.body !== undefined ? "POST" : "GET",
      credentials: "same-origin",
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (r.status === 401) { location.href = "/login.html"; return new Promise(function () {}); }
      if (r.status === 403 && path.indexOf("/api/insured/") === 0) { location.href = "/workspace.html"; return new Promise(function () {}); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ("Something went wrong (" + r.status + ")"));
        return j;
      });
    });
  }
  function itemIds(v) {
    var ids = {};
    ((v && v.checklist && v.checklist.groups) || []).forEach(function (g) {
      (g.items || []).forEach(function (it) { ids[it.id] = true; });
    });
    return ids;
  }
  function findItem(id) {
    var out = null;
    ((S.view && S.view.checklist.groups) || []).forEach(function (g) {
      g.items.forEach(function (it) { if (it.id === id) out = it; });
    });
    return out;
  }

  /* ---------- render ---------- */
  function fileList(files) {
    if (!files || !files.length) return "";
    return '<ul class="files">' + files.map(function (f) {
      return "<li><span class=\"fn\">" + esc(f.name) + '</span><span class="fm">' + esc(fmtSize(f.size)) + " · added " + esc(fmtStamp(f.uploadedAt)) + "</span>" +
        (f.removable ? '<button class="iconbtn xs" type="button" data-act="remove" data-id="' + esc(f.id) + '" data-key="rm-' + esc(f.id) + '" aria-label="Remove ' + esc(f.name) + '">Remove</button>' : "") + "</li>";
    }).join("") + "</ul>";
  }
  function uploadBtn(id, label) {
    return '<button class="btn ghost sm" type="button" data-act="pick" data-item="' + esc(id) + '" data-key="up-' + esc(id) + '">' + esc(label) + "</button>" +
      '<input type="file" multiple hidden tabindex="-1" data-item="' + esc(id) + '" aria-label="Choose files for ' + esc(id) + '">';
  }
  function itemHtml(it) {
    var got = it.status === "received";
    var badge = got ? '<span class="badge2 received">Received</span>' :
      (it.priority === "required" ? '<span class="badge2 needed">Needed</span>' : '<span class="badge2 rec">Recommended</span>');
    var open = !!S.whyOpen[it.id];
    return '<li class="item' + (got ? " is-received" : "") + '" data-drop="' + esc(it.id) + '">' +
      '<div class="irow"><span class="ilabel">' + esc(it.label) + "</span>" + badge + "</div>" +
      '<div><button class="linkbtn" type="button" data-act="why" data-id="' + esc(it.id) + '" data-key="why-' + esc(it.id) + '" aria-expanded="' + open + '" aria-controls="why-' + esc(it.id) + '">Why we ask</button></div>' +
      '<p class="why" id="why-' + esc(it.id) + '"' + (open ? "" : " hidden") + ">" + esc(it.why) + "</p>" +
      fileList(it.files) +
      '<div class="iact">' + uploadBtn(it.id, got ? "Add more files" : "Upload") + '<span class="hint">or drop files here</span></div></li>';
  }
  function render() {
    var v = S.view, b = v.business, st = v.stage, c = v.checklist.counts;
    var pct = c.required ? Math.round(100 * c.requiredReceived / c.required) : 100;
    var h = "";

    h += '<section class="card2 hero" aria-labelledby="biz"><h1 id="biz">' + esc(b.name) + "</h1>" +
      '<p class="lede2">Workers’ comp audit for policy ' + esc(b.policyNumber) + " · " + esc(b.carrier) + "</p>" +
      '<div class="facts2"><span><b>Policy period</b>' + esc(fmtDay(b.period && b.period.from)) + " to " + esc(fmtDay(b.period && b.period.to)) + "</span>" +
      "<span><b>Audit type</b>" + esc(b.auditType) + "</span>" +
      (b.auditor ? "<span><b>Auditor</b>" + esc(b.auditor) + "</span>" : "") + "</div>" +
      '<span class="pill duepill">Audit due ' + esc(fmtDay(b.dueDate)) + "</span>" +
      '<ol class="track" aria-label="Audit progress">' + (st.stages || []).map(function (s, i) {
        var cls = i < st.index ? "done" : (i === st.index ? "cur" : "");
        return '<li class="' + cls + '"' + (i === st.index ? ' aria-current="step"' : "") + ">" + esc(s) +
          (i < st.index ? '<span class="sr"> (done)</span>' : "") + "</li>";
      }).join("") + "</ol>" +
      (st.note ? '<p class="stagenote">' + esc(st.note) + "</p>" : "") + "</section>";

    h += '<section class="card2" aria-label="Your progress"><div class="progtext">' + esc(c.requiredReceived) + " of " + esc(c.required) + " required items received</div>" +
      '<div class="bar' + (pct >= 100 ? " full" : "") + '" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Required items received"><i style="width:' + pct + '%"></i></div>' +
      '<p class="sub">' + esc(c.recommendedReceived) + " of " + esc(c.recommended) + " recommended items received. Recommended items can speed things up but aren’t required.</p></section>";

    if ((v.questions || []).length) {
      h += '<section class="card2" aria-labelledby="qh"><h2 id="qh">A few quick questions</h2><p class="sub">Your answers help us build the right list for your business.</p><ul class="qlist">' +
        v.questions.map(function (q) {
          var a = v.answers ? v.answers[q.id] : undefined;
          return '<li><div class="qtext"><b id="q-' + esc(q.id) + '">' + esc(q.text) + "</b>" + (q.help ? '<span class="small muted">' + esc(q.help) + "</span>" : "") + "</div>" +
            '<div class="seg" role="group" aria-labelledby="q-' + esc(q.id) + '">' +
            '<button type="button" data-act="ans" data-q="' + esc(q.id) + '" data-v="1" data-key="a-' + esc(q.id) + '-1" aria-pressed="' + (a === true) + '">Yes</button>' +
            '<button type="button" data-act="ans" data-q="' + esc(q.id) + '" data-v="0" data-key="a-' + esc(q.id) + '-0" aria-pressed="' + (a === false) + '">No</button></div></li>';
        }).join("") + "</ul></section>";
    }

    h += '<section class="card2" aria-labelledby="sendh"><h2 id="sendh">What to send</h2><p class="sub">Pick files or drop them onto an item. Send what you have; you can add more any time.</p>' +
      v.checklist.groups.map(function (g) {
        return '<div class="group"><h3>' + esc(g.group) + '</h3><ul class="items" style="list-style:none;margin:0;padding:0">' + g.items.map(itemHtml).join("") + "</ul></div>";
      }).join("") + "</section>";

    h += '<section class="card2" aria-labelledby="oth"><h2 id="oth">Something else to send?</h2>' +
      '<div class="drop" data-drop="other"><span>Drop any other records here, or choose them from your computer.</span>' + fileList(v.otherFiles) +
      uploadBtn("other", "Choose files") + "</div></section>";

    if ((v.checklist.tips || []).length) {
      h += '<section class="card2" aria-labelledby="tiph"><h2 id="tiph">Helpful tips</h2><ul class="tips">' + v.checklist.tips.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul></section>";
    }

    if (v.submittedAt) {
      h += '<section class="card2 submitcard sent" aria-labelledby="subh"><h2 id="subh" class="big">Sent to your auditor</h2><p>Sent to your auditor on ' + esc(fmtDay(String(v.submittedAt).slice(0, 10))) +
        ". They’ll reach out if anything else is needed.</p><p class=\"sub\">You can still add files above.</p></section>";
    } else {
      h += '<section class="card2 submitcard" aria-labelledby="subh"><h2 id="subh">Ready to send?</h2>' +
        '<button class="btn lg" type="button" data-act="submit" data-key="submit"' + (v.canSubmit ? "" : " disabled") + ">Send to your auditor</button>" +
        (!v.canSubmit && (v.submitBlockers || []).length ? '<p class="small muted">Before you can send:</p><ul class="blockers">' + v.submitBlockers.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" : "") + "</section>";
    }

    var acts = (v.activity || []).slice(0, 8);
    if (acts.length) {
      h += '<section class="card2" aria-labelledby="acth"><h2 id="acth">Recent activity</h2><ul class="act">' + acts.map(function (a) {
        return "<li><span>" + esc(a.summary) + "</span><time>" + esc(fmtStamp(a.at)) + (a.actor ? " · " + esc(a.actor) : "") + "</time></li>";
      }).join("") + "</ul></section>";
    }

    var r = v.receipt || {};
    h += '<p class="foot">' + (r.fingerprint ? "Checklist built by Penny’s engine · " + esc(r.dataStatus) + " · " + esc(String(r.fingerprint).slice(0, 12)) + "<br>" : "") +
      '<a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></p>';

    var sc = $("center").scrollTop, fk = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-key");
    app.innerHTML = h;
    $("center").scrollTop = sc;
    if (fk) {
      var f = app.querySelector('[data-key="' + fk + '"]');
      if (f && !f.disabled) f.focus({ preventScroll: true });
    }
  }

  /* ---------- actions ---------- */
  function setView(v, announce) {
    var before = S.view ? itemIds(S.view) : null;
    S.view = v;
    render();
    if (announce && before) {
      var after = itemIds(v), added = Object.keys(after).some(function (k) { return !before[k]; });
      if (added) toast("Your list was updated");
    }
  }
  function run(p, announce, fail) {
    if (S.busy) return Promise.resolve();
    S.busy = true;
    return p().then(function (v) { setView(v, announce); return v; })
      .catch(function (e) { toast(e.message, true); if (fail) fail(); })
      .then(function () { S.busy = false; });
  }

  function answer(q, val) {
    var a = {};
    Object.keys(S.view.answers || {}).forEach(function (k) { a[k] = S.view.answers[k]; });
    if (a[q] === val) return;
    a[q] = val;
    run(function () { return api("/api/insured/answers", { body: { answers: a } }); }, true);
  }

  function upload(itemId, fileList) {
    var files = Array.prototype.slice.call(fileList || []), ok = [], big = 0;
    files.forEach(function (f) {
      if (f.size > MAX_BYTES) { big++; return; }
      ok.push({ name: String(f.name).slice(0, MAX_NAME), size: f.size, type: f.type || "application/octet-stream" });
    });
    if (big) toast(big === 1 ? "One file is over 50 MB, so it wasn’t added." : big + " files are over 50 MB, so they weren’t added.", true);
    if (!ok.length) return;
    var it = itemId === "other" ? null : findItem(itemId), label = it ? it.label : "your other files";
    var chunks = [];
    for (var i = 0; i < ok.length; i += MAX_FILES) chunks.push(ok.slice(i, i + MAX_FILES));
    run(function () {
      return chunks.reduce(function (p, ch) {
        return p.then(function () { return api("/api/insured/upload", { body: { item: itemId, files: ch } }); });
      }, Promise.resolve());
    }, true).then(function (v) {
      if (v) toast("Added " + ok.length + (ok.length === 1 ? " file" : " files") + " to " + label);
    });
  }

  app.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]");
    if (!b || !app.contains(b)) return;
    var act = b.getAttribute("data-act");
    if (act === "ans") answer(b.getAttribute("data-q"), b.getAttribute("data-v") === "1");
    else if (act === "why") {
      var id = b.getAttribute("data-id"), p = $("why-" + id);
      S.whyOpen[id] = !S.whyOpen[id];
      if (p) p.hidden = !S.whyOpen[id];
      b.setAttribute("aria-expanded", String(!!S.whyOpen[id]));
    } else if (act === "pick") {
      var inp = b.parentNode.querySelector('input[type="file"]');
      if (inp) inp.click();
    } else if (act === "remove") {
      run(function () { return api("/api/insured/files/" + encodeURIComponent(b.getAttribute("data-id")) + "/remove", { body: {} }); }, false)
        .then(function (v) { if (v) toast("File removed"); });
    } else if (act === "submit") {
      if (!window.confirm("Send these records to your auditor? You can still add files afterward.")) return;
      run(function () { return api("/api/insured/submit", { body: {} }); }, false).then(function (v) { if (v) toast("Sent to your auditor"); });
    }
  });
  app.addEventListener("change", function (e) {
    var inp = e.target;
    if (inp.type !== "file") return;
    var files = inp.files;
    var id = inp.getAttribute("data-item");
    upload(id, files);
    inp.value = "";
  });
  function dropTarget(e) { return e.target.closest ? e.target.closest("[data-drop]") : null; }
  app.addEventListener("dragover", function (e) {
    var t = dropTarget(e);
    if (!t) return;
    e.preventDefault();
    t.classList.add("over");
  });
  app.addEventListener("dragleave", function (e) {
    var t = dropTarget(e);
    if (t && !t.contains(e.relatedTarget)) t.classList.remove("over");
  });
  app.addEventListener("drop", function (e) {
    var t = dropTarget(e);
    if (!t) return;
    e.preventDefault();
    t.classList.remove("over");
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) upload(t.getAttribute("data-drop"), e.dataTransfer.files);
  });
  // a stray drop outside a target shouldn't navigate away to the file
  document.addEventListener("dragover", function (e) { e.preventDefault(); });
  document.addEventListener("drop", function (e) { e.preventDefault(); });

  /* ---------- Penny chat ---------- */
  $("chips").innerHTML = PROMPTS.map(function (q) { return '<button type="button" class="chip" data-q="' + esc(q) + '">' + esc(q) + "</button>"; }).join("");
  $("chips").addEventListener("click", function (e) {
    var b = e.target.closest("[data-q]");
    if (b) sendChat(b.getAttribute("data-q"));
  });

  function addMsg(role, text) {
    var el = document.createElement("div");
    el.className = "msg " + (role === "user" ? "user" : "penny");
    el.innerHTML = '<div class="b">' + esc(text) + "</div>";
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function greet() {
    var who = S.user && S.user.role !== "business" && S.view ? S.view.business.contact : (S.user && (S.user.displayName || S.user.username));
    var first = String(who || "there").split(/[\s,]+/)[0];
    addMsg("assistant", "Hi " + first + ". I can explain any item on your list, what an auditor looks for, or what happens next. What would you like to know?");
  }
  function sendChat(text) {
    text = (text || "").trim();
    if (!text || S.sending) return;
    if (text.length > 4000) { toast("Messages can be up to 4,000 characters.", true); return; }
    S.chat.push({ role: "user", content: text });
    addMsg("user", text);
    $("chatin").value = "";
    S.sending = true;
    $("chatform").querySelector(".send").disabled = true;
    var ty = document.createElement("div");
    ty.className = "msg typing";
    ty.innerHTML = '<div class="dots" aria-label="Penny is typing"><i></i><i></i><i></i></div>';
    logEl.appendChild(ty);
    logEl.scrollTop = logEl.scrollHeight;
    api("/api/insured/chat", { body: { messages: S.chat.slice(-20) } }).then(function (res) {
      var reply = res.reply || "";
      S.chat.push({ role: "assistant", content: reply });
      if (ty.parentNode) ty.parentNode.removeChild(ty);
      addMsg("assistant", reply);
    }).catch(function (e) {
      S.chat.pop();
      if (ty.parentNode) ty.parentNode.removeChild(ty);
      addMsg("assistant", "Sorry, I couldn’t answer that just now. " + e.message);
    }).then(function () { S.sending = false; $("chatform").querySelector(".send").disabled = false; });
  }
  $("chatform").addEventListener("submit", function (e) { e.preventDefault(); sendChat($("chatin").value); });
  $("chatin").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat($("chatin").value); }
  });

  /* ---------- chrome ---------- */
  $("fab").addEventListener("click", function () { $("penny").classList.add("open"); $("chatin").focus(); });
  $("sheetclose").addEventListener("click", function () { $("penny").classList.remove("open"); $("fab").focus(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") $("penny").classList.remove("open");
  });
  $("signout").addEventListener("click", function () {
    api("/api/auth/logout", { body: {} }).catch(function () {}).then(function () { location.href = "/login.html"; });
  });

  /* ---------- start ---------- */
  api("/api/auth/me").then(function (me) {
    if (!me.user || (me.user.role !== "business" && !CASE)) { location.replace("/workspace.html"); return new Promise(function () {}); }
    S.user = me.user;
    $("who").textContent = me.user.displayName || me.user.username;
    return api("/api/insured/case");
  }).then(function (v) {
    setView(v, false);
    if (v.previewFor) {
      var note = document.querySelector(".previewnote");
      var bar = document.createElement("div");
      bar.className = "callout warn asinsured";
      bar.setAttribute("role", "note");
      bar.innerHTML = "<b>Insured view.</b> This is " + esc(v.business.name) + "'s portal, the way " + esc(v.business.contact) + " sees it. Anything you do here is recorded as you, in insured view. " +
        '<a href="workspace.html#case=' + encodeURIComponent(v.previewFor.caseId) + '">Back to the auditor workspace</a>';
      if (note && note.parentNode) note.parentNode.insertBefore(bar, note);
    }
    greet();
  })
    .catch(function (e) { app.innerHTML = '<div class="callout bad">' + esc(e.message) + "</div>"; });
})();
