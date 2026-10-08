// Auditor / Insured / Director switch at the top of each screen, for showing the
// preview. Hidden for business accounts: a real insured only ever sees their portal.
(function () {
  "use strict";
  var nav = document.getElementById("viewswitch");
  if (!nav) return;
  var FALLBACK_CASE = "SRR-2026";

  function lastCase() {
    try { return localStorage.getItem("penny.lastCase") || FALLBACK_CASE; } catch (e) { return FALLBACK_CASE; }
  }
  function setInsuredLink(id) {
    var a = nav.querySelector('[data-view="insured"]');
    if (a) a.href = "insured.html?case=" + encodeURIComponent(id || lastCase());
  }
  function current() {
    var p = location.pathname;
    if (/insured\.html$/.test(p)) return "insured";
    if (/director\.html$/.test(p)) return "director";
    return "auditor";
  }

  var here = current();
  Array.prototype.forEach.call(nav.querySelectorAll("a"), function (a) {
    if (a.getAttribute("data-view") === here) a.setAttribute("aria-current", "page");
  });
  setInsuredLink();
  // The auditor workspace announces the open case so "Insured" opens that case's portal.
  document.addEventListener("penny:case", function (e) {
    try { localStorage.setItem("penny.lastCase", e.detail); } catch (err) { /* per-browser memory only */ }
    setInsuredLink(e.detail);
  });

  fetch("/api/auth/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
    if (j && j.user && j.user.role !== "business") nav.hidden = false;
  }).catch(function () {});
})();
