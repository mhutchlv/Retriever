(function () {
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.pennyReduced = reduced;
  function onView(selector, cb, threshold) {
    var els = document.querySelectorAll(selector);
    if (!els.length) return;
    if (!('IntersectionObserver' in window) || reduced) { els.forEach(function (el) { cb(el); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { cb(e.target); io.unobserve(e.target); } });
    }, { threshold: threshold || 0.35 });
    els.forEach(function (el) { io.observe(el); });
  }
  window.pennyOnView = onView;
  document.addEventListener('DOMContentLoaded', function () {
    onView('.reveal', function (el) { el.classList.add('in'); }, 0.2);
    onView('.convo', function (el) { el.classList.add('in'); }, 0.15);
    setTimeout(function () { document.querySelectorAll('.convo').forEach(function (el) { el.classList.add('in'); }); }, 4000);
  });
  window.pennyMoney = function (n) { return '$' + Math.round(n).toLocaleString('en-US'); };
})();
