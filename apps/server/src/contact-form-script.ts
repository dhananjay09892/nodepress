/**
 * The script that makes the `core/contact-form` block work. It is served from this site
 * (`/np/contact-form.js`) because the default Content-Security-Policy blocks inline scripts.
 *
 * It asks `/api/v1/contact/token` for a signed token when a form is found (pages are cached, so
 * the token cannot be part of the HTML), waits until the token is old enough, posts the JSON,
 * and shows field errors next to the fields. Written in plain ES2015 without dependencies.
 */
export const CONTACT_FORM_SCRIPT = `(function () {
  'use strict';
  if (window.__npContactForm) return;
  window.__npContactForm = true;
  var MIN_WAIT = 3200;
  var FIELDS = ['name', 'email', 'message'];

  function setup(form) {
    var status = form.querySelector('.np-contact-status');
    var button = form.querySelector('button[type="submit"]');
    var token = null;
    var issuedAt = 0;

    function fetchToken() {
      return fetch('/api/v1/contact/token', { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (body) { token = body.token; issuedAt = Date.now(); });
    }

    function show(text, isError) {
      status.hidden = false;
      status.textContent = text;
      status.className = 'np-contact-status ' + (isError ? 'np-contact-error' : 'np-contact-success');
    }

    function clearErrors() {
      status.hidden = true;
      FIELDS.forEach(function (name) {
        var input = form.elements[name];
        var error = document.getElementById(input.id + '-error');
        input.removeAttribute('aria-invalid');
        error.hidden = true;
        error.textContent = '';
      });
    }

    function showFieldErrors(fields) {
      var first = null;
      FIELDS.forEach(function (name) {
        if (!fields[name]) return;
        var input = form.elements[name];
        var error = document.getElementById(input.id + '-error');
        input.setAttribute('aria-invalid', 'true');
        error.textContent = fields[name];
        error.hidden = false;
        if (!first) first = input;
      });
      if (first) first.focus();
    }

    function send() {
      var payload = {
        form: form.getAttribute('data-form') || 'contact',
        name: form.elements.name.value,
        email: form.elements.email.value,
        message: form.elements.message.value,
        website: form.elements.website.value,
        token: token
      };
      return fetch('/api/v1/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          return { status: response.status, body: body };
        });
      });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      clearErrors();
      button.disabled = true;
      show('Sending…', false);
      var ready = token ? Promise.resolve() : fetchToken();
      ready
        .then(function () {
          var wait = Math.max(0, MIN_WAIT - (Date.now() - issuedAt));
          return new Promise(function (resolve) { setTimeout(resolve, wait); });
        })
        .then(send)
        .then(function (result) {
          if (result.status === 201) {
            form.reset();
            show(form.getAttribute('data-success') || 'Thank you.', false);
            token = null;
            return;
          }
          if (result.status === 429) {
            show('Too many messages. Please try again later.', true);
          } else if (result.body && result.body.error === 'bad_token') {
            token = null;
            show('The form has expired. Please send it again.', true);
          } else if (result.body && result.body.fields) {
            status.hidden = true;
            showFieldErrors(result.body.fields);
          } else {
            show('The message could not be sent. Please try again.', true);
          }
        })
        .catch(function () {
          show('The message could not be sent. Please check your connection and try again.', true);
        })
        .then(function () { button.disabled = false; });
    });

    fetchToken().catch(function () { /* fetched again on submit */ });
  }

  var forms = document.querySelectorAll('form[data-np-contact-form]');
  for (var i = 0; i < forms.length; i++) setup(forms[i]);
})();
`;
