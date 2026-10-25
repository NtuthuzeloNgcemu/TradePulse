/* -----------------------------------------------
   TradePulse - auth page script
----------------------------------------------- */

// ---------- Redirect already-logged-in visitors ----------
// Not on the reset page: a recovery link signs the person in, and they
// still need to set their new password there.
const isResetPage = document.body.dataset.authPage === "reset";
(async () => {
  if (isResetPage) return;
  try {
    const {
      data: { session },
    } = await tpClient.auth.getSession();
    if (session) {
      window.location.href = "dashboard.html";
    }
  } catch (err) {
    // Supabase script failed to load or the check failed - let the person
    // see the login/register form rather than silently doing nothing.
  }
})();

// ---------- Plan param from pricing cards ----------
const planMeta = {
  free: { label: "Free", note: "Every account starts free, with up to 30 trades." },
  pro: { label: "Pro", note: "Pro is R799/mo, charged by PayPal in US dollars. You can subscribe from Account once you're in." },
  desk: { label: "Desk", note: "Desk is R2,499/mo and arranged with us directly. Sign up and we'll take it from there." },
};
// Choosing a plan here only tailors the message: nothing is charged at sign-up

const params = new URLSearchParams(window.location.search);
const selectedPlan = params.get("plan");
const authFormHeader = document.getElementById("authFormHeader");

if (selectedPlan && authFormHeader && planMeta[selectedPlan]) {
  const meta = planMeta[selectedPlan];
  const note = document.createElement("p");
  note.className = "auth-plan-note";
  note.textContent = `${meta.label}. ${meta.note}`;
  authFormHeader.prepend(note);
}

// ---------- Quote carousel ----------
const carousel = document.getElementById("quoteCarousel");
const dotsContainer = document.getElementById("quoteDots");

if (carousel && dotsContainer) {
  const quotes = Array.from(carousel.querySelectorAll(".quote-block"));
  let current = 0;
  let autoTimer;

  quotes.forEach((_, i) => {
    const dot = document.createElement("button");
    dot.className = "quote-dot" + (i === 0 ? " active" : "");
    dot.setAttribute("aria-label", `Go to quote ${i + 1}`);
    dot.addEventListener("click", () => {
      stopAuto();
      goTo(i);
      startAuto();
    });
    dotsContainer.appendChild(dot);
  });

  function goTo(index) {
    quotes[current].hidden = true;
    dotsContainer.children[current].classList.remove("active");
    current = (index + quotes.length) % quotes.length;
    quotes[current].hidden = false;
    quotes[current].style.animation = "none";
    quotes[current].offsetHeight;
    quotes[current].style.animation = "";
    dotsContainer.children[current].classList.add("active");
  }

  function startAuto() {
    autoTimer = window.setInterval(() => goTo(current + 1), 6000);
  }

  function stopAuto() {
    window.clearInterval(autoTimer);
  }

  carousel.addEventListener("mouseenter", stopAuto);
  carousel.addEventListener("mouseleave", startAuto);

  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    startAuto();
  }
}

// ---------- Password show / hide ----------
document.querySelectorAll(".toggle-pw").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const isText = input.type === "text";
    input.type = isText ? "password" : "text";
    btn.setAttribute("aria-label", isText ? "Show password" : "Hide password");
  });
});

// ---------- Password strength (register only) ----------
const pwInput = document.getElementById("password");
const pwStrength = document.getElementById("pwStrength");

if (pwInput && pwStrength) {
  pwInput.addEventListener("input", () => {
    const val = pwInput.value;
    if (!val.length) {
      pwStrength.innerHTML = "";
      return;
    }

    let score = 0;
    if (val.length >= 8) score++;
    if (/[A-Z]/.test(val)) score++;
    if (/[0-9]/.test(val)) score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;

    const levelLabel = ["", "Weak", "Fair", "Good", "Strong"][score] || "";
    const barClass = score <= 1 ? "weak" : score <= 2 ? "fair" : "good";

    const bars = Array.from(
      { length: 4 },
      (_, i) => `<div class="pw-bar ${i < score ? barClass : ""}"></div>`,
    ).join("");

    pwStrength.innerHTML = `<div class="pw-bars">${bars}</div><span class="pw-label">${levelLabel}</span>`;
  });
}

// ---------- Form helpers ----------
function setError(input, errorEl, message) {
  if (input) input.classList.toggle("is-error", Boolean(message));
  if (errorEl) errorEl.textContent = message || "";
}

// ---------- Login form ----------
const loginForm = document.getElementById("loginForm");

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = document.getElementById("email");
    const password = document.getElementById("password");
    const emailError = document.getElementById("emailError");
    const passwordError = document.getElementById("passwordError");
    const formError = document.getElementById("loginFormError");

    setError(email, emailError, "");
    setError(password, passwordError, "");
    if (formError) formError.textContent = "";

    let valid = true;

    if (!email.value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
      setError(email, emailError, "Enter a valid email address.");
      valid = false;
    }
    if (!password.value) {
      setError(password, passwordError, "Enter your password.");
      valid = false;
    }

    if (!valid) return;

    const btn = loginForm.querySelector(".auth-submit");
    const originalLabel = btn.textContent;
    btn.textContent = "Logging in...";
    btn.disabled = true;

    try {
      const { error } = await tpClient.auth.signInWithPassword({
        email: email.value.trim(),
        password: password.value,
      });

      if (error) {
        btn.textContent = originalLabel;
        btn.disabled = false;

        const message = error.message.toLowerCase();
        if (message.includes("email not confirmed")) {
          if (formError) {
            formError.textContent = "Confirm your email first. Check your inbox for the confirmation link.";
          }
        } else if (message.includes("invalid login credentials")) {
          if (formError) formError.textContent = "Incorrect email or password.";
        } else if (formError) {
          formError.textContent = error.message;
        }
        return;
      }

      window.location.href = "dashboard.html";
    } catch (err) {
      btn.textContent = originalLabel;
      btn.disabled = false;
      if (formError) {
        formError.textContent = "Couldn't reach TradePulse right now. Check your connection and try again.";
      }
    }
  });
}

// ---------- Register form ----------
const registerForm = document.getElementById("registerForm");

if (registerForm) {
  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const firstName = document.getElementById("firstName");
    const lastName = document.getElementById("lastName");
    const email = document.getElementById("email");
    const password = document.getElementById("password");
    const traderType = document.getElementById("traderType");
    const terms = document.getElementById("terms");
    const firstNameError = document.getElementById("firstNameError");
    const emailError = document.getElementById("emailError");
    const termsError = document.getElementById("termsError");
    const passwordError = document.getElementById("passwordError");
    const formError = document.getElementById("registerFormError");

    setError(firstName, firstNameError, "");
    setError(email, emailError, "");
    setError(password, passwordError, "");
    if (termsError) termsError.textContent = "";
    if (formError) formError.textContent = "";

    let valid = true;

    if (!firstName.value.trim()) {
      setError(firstName, firstNameError, "Enter your first name.");
      valid = false;
    }
    if (!email.value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
      setError(email, emailError, "Enter a valid email address.");
      valid = false;
    }
    if (!password.value || password.value.length < 8) {
      setError(password, passwordError, "Use at least 8 characters.");
      valid = false;
    }
    if (!terms.checked) {
      if (termsError) termsError.textContent = "You must agree to continue.";
      valid = false;
    }

    if (!valid) return;

    const btn = registerForm.querySelector(".auth-submit");
    const originalLabel = btn.textContent;
    btn.textContent = "Creating your account...";
    btn.disabled = true;

    try {
      const { data, error } = await tpClient.auth.signUp({
        email: email.value.trim(),
        password: password.value,
        options: {
          data: {
            first_name: firstName.value.trim(),
            last_name: lastName.value.trim(),
            trader_type: traderType.value,
            interested_plan: planMeta[selectedPlan] ? selectedPlan : null,
          },
        },
      });

      if (error) {
        btn.textContent = originalLabel;
        btn.disabled = false;

        const message = error.message.toLowerCase();
        if (message.includes("already registered") || message.includes("already exists")) {
          if (formError) {
            formError.textContent = "An account with this email already exists. Try logging in instead.";
          }
        } else if (formError) {
          formError.textContent = error.message;
        }
        return;
      }

      if (data.session) {
        // Email confirmation is off for this project, so signUp already returned a session
        window.location.href = "dashboard.html";
        return;
      }

      // Email confirmation required: swap the form for the code entry screen.
      // A code is used rather than only a link because a link has to land on a
      // URL Supabase is configured to allow, which is one more thing to get
      // wrong; a code works wherever the person already is.
      const confirmEmailAddress = document.getElementById("confirmEmailAddress");
      const formWrap = document.getElementById("registerFormWrap");
      const notice = document.getElementById("confirmEmailNotice");
      pendingEmail = email.value.trim();
      if (confirmEmailAddress) confirmEmailAddress.textContent = pendingEmail;
      if (formWrap) formWrap.hidden = true;
      if (notice) notice.hidden = false;
      document.getElementById("otpCode")?.focus();
    } catch (err) {
      btn.textContent = originalLabel;
      btn.disabled = false;
      if (formError) {
        formError.textContent = "Couldn't reach TradePulse right now. Check your connection and try again.";
      }
    }
  });
}

// ---------- Forgot password (login page) ----------
const forgotToggle = document.getElementById("forgotToggle");
const resetRequestForm = document.getElementById("resetRequestForm");

function resetRedirectUrl() {
  // Only pass a redirect when the page is served over http(s); otherwise
  // Supabase falls back to the project's Site URL.
  if (!/^https?:$/.test(window.location.protocol)) return undefined;
  return new URL("reset-password.html", window.location.href).href;
}

forgotToggle?.addEventListener("click", () => {
  const open = resetRequestForm.hidden;
  resetRequestForm.hidden = !open;
  forgotToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    const loginEmail = document.getElementById("email")?.value.trim();
    const resetEmail = document.getElementById("resetEmail");
    if (loginEmail && !resetEmail.value) resetEmail.value = loginEmail;
    resetEmail.focus();
  }
});

resetRequestForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("resetEmail");
  const emailError = document.getElementById("resetEmailError");
  const status = document.getElementById("resetStatus");
  setError(email, emailError, "");
  status.textContent = "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
    setError(email, emailError, "Enter a valid email address.");
    return;
  }
  const btn = resetRequestForm.querySelector(".auth-submit");
  btn.disabled = true;
  btn.textContent = "Sending...";
  try {
    const { error } = await tpClient.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: resetRedirectUrl() });
    // Same message either way, so the form doesn't reveal which emails have accounts
    status.textContent = error && /rate|limit/i.test(error.message)
      ? "Too many requests. Wait a minute and try again."
      : "If an account exists for that email, a reset link is on its way. Check your inbox.";
  } catch (err) {
    status.textContent = "Couldn't reach TradePulse right now. Check your connection and try again.";
  }
  btn.disabled = false;
  btn.textContent = "Send reset link";
});

// ---------- Set a new password (reset page) ----------
const newPasswordForm = document.getElementById("newPasswordForm");
if (newPasswordForm) {
  const expired = document.getElementById("resetExpired");
  const showForm = (ok) => {
    newPasswordForm.hidden = !ok;
    if (expired) expired.hidden = ok;
  };

  // supabase-js reads the recovery token from the link and signs the person in
  tpClient.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY" || (session && event === "SIGNED_IN")) showForm(true);
  });
  setTimeout(async () => {
    const { data } = await tpClient.auth.getSession();
    showForm(Boolean(data.session));
  }, 800);

  newPasswordForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pw = document.getElementById("newPassword");
    const confirm = document.getElementById("confirmPassword");
    const pwError = document.getElementById("newPasswordError");
    const formError = document.getElementById("newPasswordFormError");
    setError(pw, pwError, "");
    formError.textContent = "";
    if (pw.value.length < 8) return setError(pw, pwError, "Use at least 8 characters.");
    if (pw.value !== confirm.value) return setError(confirm, pwError, "The two passwords don't match.");

    const btn = newPasswordForm.querySelector(".auth-submit");
    btn.disabled = true;
    btn.textContent = "Saving...";
    const { error } = await tpClient.auth.updateUser({ password: pw.value });
    if (error) {
      formError.textContent = error.message;
      btn.disabled = false;
      btn.textContent = "Set new password";
      return;
    }
    window.location.href = "dashboard.html";
  });
}


/* ---------- Confirming the account with the emailed code ---------- */
// The address the code was sent to. Kept in memory only: it is already on
// screen, and it should not outlive the tab.
let pendingEmail = "";

(function otpConfirmation() {
  const form = document.getElementById("otpForm");
  if (!form) return;

  const input = document.getElementById("otpCode");
  const errorEl = document.getElementById("otpError");
  const submit = document.getElementById("otpSubmit");
  const resend = document.getElementById("otpResend");
  const resendStatus = document.getElementById("otpResendStatus");

  // Typing or pasting anything that isn't a digit is a mistake, not an entry.
  input?.addEventListener("input", () => {
    const cleaned = input.value.replace(/\D/g, "").slice(0, 6);
    if (cleaned !== input.value) input.value = cleaned;
    if (errorEl) errorEl.textContent = "";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = (input?.value || "").trim();

    if (!/^[0-9]{6}$/.test(token)) {
      if (errorEl) errorEl.textContent = "Enter the six-digit code from the email.";
      input?.focus();
      return;
    }
    if (!pendingEmail) {
      if (errorEl) errorEl.textContent = "Start again from the registration form so we know which address to confirm.";
      return;
    }

    const original = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Confirming\u2026";
    if (errorEl) errorEl.textContent = "";

    try {
      // The reference documents type "email" for a signup code. Older
      // projects answer to "signup", so a rejected type is retried once
      // rather than shown to the person as a failure.
      let { data, error } = await tpClient.auth.verifyOtp({ email: pendingEmail, token, type: "email" });
      if (error && /type|invalid/i.test(error.message || "")) {
        ({ data, error } = await tpClient.auth.verifyOtp({ email: pendingEmail, token, type: "signup" }));
      }

      if (error) {
        const message = (error.message || "").toLowerCase();
        if (errorEl) {
          // Supabase answers a wrong code and an expired one with the same
          // message ("Token has expired or is invalid"), so neither is
          // claimed as the cause. Saying "expired" to someone who mistyped
          // sends them to request a code they did not need.
          errorEl.textContent = /expired|invalid|token/.test(message)
            ? "That code didn't work. It may have been mistyped, or it may have expired \u2014 check the email, or send a new code below."
            : error.message;
        }
        submit.disabled = false;
        submit.textContent = original;
        input?.select();
        return;
      }

      // Verifying a signup code signs the person in, so there is no reason
      // to send them to the login page to type a password again.
      if (data?.session) {
        window.location.href = "dashboard.html";
        return;
      }
      window.location.href = "login.html";
    } catch (err) {
      if (errorEl) errorEl.textContent = "Couldn't reach TradePulse. Check your connection and try again.";
      submit.disabled = false;
      submit.textContent = original;
    }
  });

  resend?.addEventListener("click", async () => {
    if (!pendingEmail) return;
    resend.disabled = true;
    if (resendStatus) {
      resendStatus.classList.remove("is-ok");
      resendStatus.textContent = "Sending\u2026";
    }
    try {
      const { error } = await tpClient.auth.resend({ type: "signup", email: pendingEmail });
      if (resendStatus) {
        if (error) {
          resendStatus.textContent = /rate|limit|seconds/i.test(error.message || "")
            ? "A code was sent recently. Wait a minute before asking for another."
            : error.message;
        } else {
          resendStatus.classList.add("is-ok");
          resendStatus.textContent = "Sent. It can take a minute to arrive.";
        }
      }
    } catch (err) {
      if (resendStatus) resendStatus.textContent = "Couldn't reach TradePulse.";
    } finally {
      // Supabase rate-limits resends, so the button stays off for a while
      // rather than inviting a burst that will be refused.
      setTimeout(() => { resend.disabled = false; }, 60000);
    }
  });
})();
