(function () {
  "use strict";
  var form = document.getElementById("loginform");
  var err = document.getElementById("loginerr");
  var btn = document.getElementById("loginbtn");

  fetch("/api/auth/me", { credentials: "same-origin" }).then(function (r) {
    if (r.status === 200) location.replace("/workspace.html");
  }).catch(function () {});

  function showErr(msg) {
    err.textContent = msg;
    err.hidden = false;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    err.hidden = true;
    var username = document.getElementById("username").value.trim();
    var password = document.getElementById("password").value;
    if (!username || !password) { showErr("Enter your username and password."); return; }
    btn.disabled = true;
    fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username, password: password })
    }).then(function (r) {
      if (r.status === 200) { location.href = "/workspace.html"; return null; }
      return r.json().catch(function () { return {}; }).then(function (j) {
        showErr(j.error || "Sign in failed. Try again.");
        btn.disabled = false;
      });
    }).catch(function () {
      showErr("Could not reach the server. Try again.");
      btn.disabled = false;
    });
  });
})();
