/** The setup wizard page and its script (inline scripts are blocked by the default CSP). */

export const INSTALL_SCRIPT_PATH = '/install/install.js';
export const MIN_ADMIN_PASSWORD = 10;

export const INSTALL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Set up NodePress</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#4b5260; --line:#c9cfda; --accent:#2f4fd8; --error:#b3261e; --ok:#1b6e3c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161b; --card:#1d2027; --text:#eef0f4; --muted:#aab1be; --line:#3a404c; --accent:#8fa6ff; --error:#ff9d94; --ok:#7fd69e; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, sans-serif; }
  main { width:100%; max-width:480px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:24px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  .steps { color:var(--muted); margin:0 0 20px; }
  fieldset { border:0; padding:0; margin:0; }
  legend { font-size:1.1rem; font-weight:600; padding:0; margin-bottom:12px; }
  label { display:block; font-weight:600; margin-top:12px; }
  input { width:100%; padding:10px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  input:focus-visible, button:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
  .hint { color:var(--muted); font-size:.9rem; margin:4px 0 0; }
  .error { color:var(--error); font-size:.9rem; margin:4px 0 0; }
  .ok { color:var(--ok); }
  .row { display:flex; gap:8px; margin-top:20px; justify-content:space-between; }
  button { padding:10px 18px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  @media (prefers-color-scheme: dark) { button { color:#111; } }
  button.secondary { background:transparent; color:var(--accent); }
  button[disabled] { opacity:.6; cursor:default; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<main>
  <h1>Set up NodePress</h1>
  <p class="steps" id="step-label" aria-live="polite"></p>
  <noscript><p>The setup needs JavaScript.</p></noscript>
  <form id="wizard" novalidate>
    <fieldset data-step="0">
      <legend>Check your server</legend>
      <p id="db-status" role="status">Checking the database…</p>
      <label for="code">Setup code</label>
      <input id="code" name="code" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="code-hint code-error" required>
      <p class="hint" id="code-hint">Find it in the server log, next to the line that says setup is waiting (or in the <code>INSTALL_CODE</code> you set).</p>
      <p class="error" id="code-error" role="alert" hidden></p>
    </fieldset>
    <fieldset data-step="1" hidden>
      <legend>Your site</legend>
      <label for="siteName">Site name</label>
      <input id="siteName" name="siteName" type="text" maxlength="200" aria-describedby="siteName-error" required>
      <p class="error" id="siteName-error" role="alert" hidden></p>
    </fieldset>
    <fieldset data-step="2" hidden>
      <legend>Administrator account</legend>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" maxlength="254" aria-describedby="email-error" required>
      <p class="error" id="email-error" role="alert" hidden></p>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="new-password" aria-describedby="password-hint password-error" required>
      <p class="hint" id="password-hint">At least ${MIN_ADMIN_PASSWORD} characters.</p>
      <p class="error" id="password-error" role="alert" hidden></p>
      <label for="confirm">Repeat the password</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password" aria-describedby="confirm-error" required>
      <p class="error" id="confirm-error" role="alert" hidden></p>
    </fieldset>
    <p class="error" id="form-error" role="alert" hidden></p>
    <div class="row">
      <button type="button" class="secondary" id="back" hidden>Back</button>
      <button type="submit" id="next">Continue</button>
    </div>
  </form>
</main>
<script src="${INSTALL_SCRIPT_PATH}" defer></script>
</body>
</html>
`;

export const INSTALL_SCRIPT = `(function () {
  'use strict';
  var STEPS = ['Step 1 of 3: server check', 'Step 2 of 3: your site', 'Step 3 of 3: administrator'];
  var MIN_PASSWORD = ${MIN_ADMIN_PASSWORD};
  var form = document.getElementById('wizard');
  var panels = form.querySelectorAll('[data-step]');
  var label = document.getElementById('step-label');
  var back = document.getElementById('back');
  var next = document.getElementById('next');
  var formError = document.getElementById('form-error');
  var step = 0;
  var dbOk = false;

  function field(name) { return document.getElementById(name); }
  function setError(name, message) {
    var box = document.getElementById(name + '-error');
    var input = field(name);
    if (!box) return;
    box.hidden = !message;
    box.textContent = message || '';
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }
  function clearAll() {
    ['code', 'siteName', 'email', 'password', 'confirm'].forEach(function (n) { setError(n, ''); });
    formError.hidden = true;
  }
  function show(n) {
    step = n;
    for (var i = 0; i < panels.length; i++) panels[i].hidden = i !== n;
    label.textContent = STEPS[n];
    back.hidden = n === 0;
    next.textContent = n === 2 ? 'Install NodePress' : 'Continue';
    var first = panels[n].querySelector('input');
    if (first) first.focus();
  }
  function fail(name, message) {
    setError(name, message);
    field(name).focus();
    return false;
  }
  function valid() {
    clearAll();
    if (step === 0) {
      if (!dbOk) { formError.hidden = false; formError.textContent = 'The database is not ready.'; return false; }
      if (!field('code').value.trim()) return fail('code', 'Enter the setup code.');
    } else if (step === 1) {
      if (!field('siteName').value.trim()) return fail('siteName', 'Enter a name for your site.');
    } else {
      if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(field('email').value.trim())) return fail('email', 'Enter a valid email address.');
      if (field('password').value.length < MIN_PASSWORD) return fail('password', 'Use at least ' + MIN_PASSWORD + ' characters.');
      if (field('confirm').value !== field('password').value) return fail('confirm', 'The passwords do not match.');
    }
    return true;
  }
  function submit() {
    next.disabled = true;
    return fetch('/api/v1/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: field('code').value.trim(),
        siteName: field('siteName').value.trim(),
        email: field('email').value.trim(),
        password: field('password').value
      })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (response.status === 201) { window.location.assign('/admin/'); return; }
        next.disabled = false;
        if (body.error === 'bad_code') { show(0); fail('code', 'That setup code is not right.'); return; }
        if (body.error === 'rate_limited') { show(0); fail('code', 'Too many tries. Wait a few minutes and try again.'); return; }
        if (body.error === 'already_installed') { window.location.assign('/admin/'); return; }
        if (body.fields) {
          var names = ['siteName', 'email', 'password'];
          for (var i = 0; i < names.length; i++) {
            if (body.fields[names[i]]) { show(names[i] === 'siteName' ? 1 : 2); fail(names[i], body.fields[names[i]]); return; }
          }
        }
        formError.hidden = false;
        formError.textContent = 'Setup failed. Check the server log and try again.';
      });
    }).catch(function () {
      next.disabled = false;
      formError.hidden = false;
      formError.textContent = 'The server could not be reached. Try again.';
    });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!valid()) return;
    if (step < 2) show(step + 1);
    else submit();
  });
  back.addEventListener('click', function () { clearAll(); show(step - 1); });

  fetch('/api/v1/install/status', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(function (status) {
      var box = document.getElementById('db-status');
      if (!status.needsSetup) { window.location.assign('/admin/'); return; }
      dbOk = !!(status.database && status.database.ok);
      box.className = dbOk ? 'ok' : 'error';
      box.textContent = dbOk
        ? 'Database connected (' + status.database.dialect + ') and up to date.'
        : 'The database cannot be used. Check DATABASE_URL and the server log.';
    })
    .catch(function () {
      var box = document.getElementById('db-status');
      box.className = 'error';
      box.textContent = 'The server did not answer.';
    });
  show(0);
})();
`;
