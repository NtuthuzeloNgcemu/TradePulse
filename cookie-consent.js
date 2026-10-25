/* -----------------------------------------------
   TradePulse - cookie consent
   Included on every page so consent is captured
   regardless of which page a visitor lands on first.
----------------------------------------------- */

const cookieBanner = document.querySelector("#cookieBanner");
const cookieKey = "tp_cookie_consent";

if (cookieBanner) {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (window.localStorage.getItem(cookieKey)) {
    cookieBanner.classList.add("hidden");
  } else {
    window.setTimeout(
      () => cookieBanner.classList.remove("hidden"),
      prefersReducedMotion ? 0 : 900,
    );
  }

  document.querySelector("#cookieAccept")?.addEventListener("click", () => {
    window.localStorage.setItem(cookieKey, "accepted");
    cookieBanner.classList.add("hidden");
  });

  document.querySelector("#cookieDecline")?.addEventListener("click", () => {
    window.localStorage.setItem(cookieKey, "declined");
    cookieBanner.classList.add("hidden");
  });
}
