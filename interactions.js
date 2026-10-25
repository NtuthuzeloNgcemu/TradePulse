/* -----------------------------------------------
   TradePulse - overlay and drawer interactions
   Built on motion.js. Everything here follows the same rules:
   respond on pointer-down, track the finger 1:1, stay interruptible,
   and hand the release velocity to the spring so there is no seam
   between dragging and animating.
----------------------------------------------- */

(function () {
  "use strict";

  const M = window.TPMotion;
  if (!M) return;

  document.documentElement.classList.add("motion-js");

  const SHEET_QUERY = window.matchMedia("(max-width: 600px)");
  const isSheet = () => SHEET_QUERY.matches;
  const INTERACTIVE = "a[href], button, input, select, textarea, [contenteditable], [data-no-drag]";

  /* =================================================================
     Overlays: a dialog on a wide screen, a sheet on a phone
     ================================================================= */

  /**
   * Takes over presentation for one overlay.
   *
   * Wide screens: the surface scales up from the control that opened it, so
   * the relationship between the two is visible. Phones: it rises from the
   * bottom edge and can be thrown back down.
   *
   * Dismissal always retraces the path it arrived on.
   */
  function presentOverlay({ root, surface, backdrop, trigger, onDismiss }) {
    if (!root || !surface) return null;

    const sheet = isSheet();
    const height = () => surface.getBoundingClientRect().height || window.innerHeight;
    let dismissed = false;

    // Progress runs 0 (gone) to 1 (fully present). The surface reads it as
    // either an offset or a scale; the backdrop reads it as opacity.
    const progress = new M.Spring({ value: 0, precision: 0.002, bounce: 0, duration: 0.34 });

    function paint() {
      const p = progress.value;
      if (sheet) {
        M.write(surface, { y: (1 - p) * height(), opacity: Math.min(1, p * 2) });
      } else {
        M.write(surface, { scale: 0.94 + 0.06 * Math.min(p, 1), opacity: Math.min(1, p * 1.6) });
      }
      if (backdrop) backdrop.style.opacity = String(Math.max(0, Math.min(1, p)).toFixed(3));
    }
    progress.onUpdate = paint;

    // Anchor the surface to whatever opened it, so it grows out of the control
    // rather than arriving from nowhere.
    if (!sheet && trigger && trigger.getBoundingClientRect) {
      const t = trigger.getBoundingClientRect();
      const s = surface.getBoundingClientRect();
      if (t.width && s.width) {
        const ox = ((t.left + t.width / 2 - s.left) / s.width) * 100;
        const oy = ((t.top + t.height / 2 - s.top) / s.height) * 100;
        surface.style.transformOrigin = `${Math.max(-20, Math.min(120, ox)).toFixed(1)}% ${Math.max(-20, Math.min(120, oy)).toFixed(1)}%`;
      }
    }

    progress.onRest = () => {
      if (progress.target !== 1) return;
      root.classList.remove("overlay-materialising");
      M.hint(surface, false);
      // Hand the surface back to the browser once it has settled, so internal
      // scrolling and focus rings behave normally.
      surface.style.transform = "";
      surface.style.opacity = "";
    };

    M.hint(surface, true);
    root.classList.add("overlay-materialising");
    paint();
    progress.to(1, { bounce: sheet ? 0.12 : 0, duration: sheet ? 0.38 : 0.3 });

    function dismiss(velocity = 0) {
      if (dismissed) return;
      dismissed = true;
      M.hint(surface, true);
      root.classList.add("overlay-materialising");
      progress.onRest = () => {
        M.clear(surface);
        if (backdrop) backdrop.style.opacity = "";
        onDismiss();
      };
      // A downward throw on a sheet is a negative progress velocity.
      // Reduced motion is handled inside to(): it snaps and still calls onRest.
      const relative = sheet && velocity ? -velocity / Math.max(height(), 1) : 0;
      progress.to(0, { bounce: 0, duration: 0.28, velocity: relative });
    }

    /* ---------- Drag the sheet down to dismiss ---------- */
    if (sheet) {
      const tracker = M.createVelocityTracker();
      let pointerId = null;
      let startY = 0;
      let startProgress = 1;
      let committed = false;

      surface.addEventListener("pointerdown", (event) => {
        if (pointerId !== null || dismissed) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        // Let the content scroll first; a sheet is only draggable from its top
        const fromHandle = event.target.closest(".sheet-grip");
        if (!fromHandle) {
          if (surface.scrollTop > 0) return;
          if (event.target.closest(INTERACTIVE)) return;
        }
        pointerId = event.pointerId;
        startY = event.clientY;
        startProgress = progress.value;
        committed = false;
        tracker.reset();
        tracker.add(event.clientY, event.timeStamp);
        progress.stop();
      });

      surface.addEventListener("pointermove", (event) => {
        if (event.pointerId !== pointerId) return;
        const dy = event.clientY - startY;
        tracker.add(event.clientY, event.timeStamp);

        // A small threshold first, so a tap is never mistaken for a drag
        if (!committed) {
          if (Math.abs(dy) < 10) return;
          committed = true;
          M.hint(surface, true);
          root.classList.add("overlay-materialising");
          try {
            surface.setPointerCapture(pointerId);
          } catch (err) {
            /* capture is a nicety, not a requirement */
          }
        }
        event.preventDefault();

        const h = Math.max(height(), 1);
        // Past the top there is nothing more to show, so resist instead of following
        const offset = dy >= 0 ? dy : -M.rubberband(-dy, h);
        progress.set(Math.min(1, startProgress - offset / h));
      });

      const release = (event) => {
        if (event.pointerId !== pointerId) return;
        pointerId = null;
        if (!committed) return;
        const velocity = tracker.velocity(); // px/s, positive downward
        const h = Math.max(height(), 1);
        const travelled = (1 - progress.value) * h;
        // Aim at where the throw was going, not where the finger stopped
        const projected = travelled + M.project(velocity);
        if (projected > h * 0.4 || velocity > 700) dismiss(velocity);
        else progress.to(1, { bounce: 0.1, duration: 0.3, velocity: -velocity / h, force: true });
      };
      surface.addEventListener("pointerup", release);
      surface.addEventListener("pointercancel", release);
    }

    return { dismiss, sheet };
  }

  /* =================================================================
     Navigation drawer: grabbable, and closable with a flick
     ================================================================= */
  function attachDrawer({ panel, button, body }) {
    if (!panel) return null;

    const width = () => panel.getBoundingClientRect().width || 244;
    const x = new M.Spring({ value: -width(), precision: 0.3, bounce: 0, duration: 0.34 });
    let open = false;

    function paint() {
      if (!isSheet()) return;
      const w = Math.max(width(), 1);
      M.write(panel, { x: x.value });
      body.style.setProperty("--drawer-progress", String(Math.max(0, Math.min(1, 1 + x.value / w)).toFixed(3)));
    }
    x.onUpdate = paint;
    x.onRest = () => {
      M.hint(panel, false);
      if (x.target < 0) {
        body.classList.remove("sidebar-open");
        body.style.removeProperty("--drawer-progress");
      }
    };

    function setOpen(next, velocity = 0) {
      if (!isSheet()) return;
      open = next;
      M.hint(panel, true);
      if (next) {
        body.classList.add("sidebar-open");
        paint();
      }
      button?.setAttribute("aria-expanded", String(next));
      button?.setAttribute("aria-label", next ? "Close navigation" : "Open navigation");
      // Reduced motion is handled inside to(): it snaps and still calls onRest
      x.to(next ? 0 : -width(), { velocity, bounce: 0, duration: 0.32 });
      if (next) document.querySelector(".sidebar .side-link")?.focus();
      else button?.focus();
    }

    /* ---------- Drag the drawer closed ---------- */
    const tracker = M.createVelocityTracker();
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startValue = 0;
    let committed = false;

    panel.addEventListener("pointerdown", (event) => {
      if (!isSheet() || !open || pointerId !== null) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startValue = x.value;
      committed = false;
      tracker.reset();
      tracker.add(event.clientX, event.timeStamp);
      x.stop();
    });

    panel.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId) return;
      const dx = event.clientX - startX;
      tracker.add(event.clientX, event.timeStamp);
      if (!committed) {
        // Only a horizontal intent becomes a drag; vertical stays a scroll
        if (Math.abs(dx) < 10) return;
        if (Math.abs(dx) < Math.abs(event.clientY - startY)) return; // a vertical intent is a scroll
        committed = true;
        M.hint(panel, true);
        try {
          panel.setPointerCapture(pointerId);
        } catch (err) {
          /* optional */
        }
      }
      event.preventDefault();
      const w = Math.max(width(), 1);
      // There is nothing to reveal past fully open, so it stops at 0
      x.set(Math.max(-w, Math.min(0, startValue + dx)));
      paint();
    });

    const release = (event) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (!committed) return;
      const velocity = tracker.velocity();
      const w = Math.max(width(), 1);
      const projected = x.value + M.project(velocity);
      // The direction of the throw decides, not where the finger stopped
      const shouldOpen = velocity > 300 ? true : velocity < -300 ? false : projected > -w / 2;
      setOpen(shouldOpen, velocity);
    };
    panel.addEventListener("pointerup", release);
    panel.addEventListener("pointercancel", release);

    // Leaving phone width hands layout back to CSS
    SHEET_QUERY.addEventListener("change", (event) => {
      if (!event.matches) {
        x.stop();
        M.clear(panel);
        body.style.removeProperty("--drawer-progress");
      } else {
        x.set(open ? 0 : -width());
        paint();
      }
    });

    return {
      setOpen,
      toggle: () => setOpen(!open),
      get isOpen() {
        return open;
      },
    };
  }

  /* =================================================================
     Scroll edge: the header only separates itself from content that is
     actually underneath it, instead of carrying a permanent divider.
     ================================================================= */
  (function trackScrollEdge() {
    const body = document.body;
    let ticking = false;
    const update = () => {
      ticking = false;
      body.dataset.scrolled = window.scrollY > 4 ? "true" : "false";
    };
    window.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      },
      { passive: true },
    );
    update();
  })();

  window.TPInteractions = { presentOverlay, attachDrawer, isSheet };
})();
