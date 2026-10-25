/* -----------------------------------------------
   TradePulse - motion
   A small, dependency-free spring engine.

   Why springs rather than CSS transitions: anything a person can touch
   has to be grabbable mid-flight. A spring always continues from the
   value currently on screen and carries its velocity through a change
   of target, so a gesture can be reversed without a visible jump. A
   fixed-duration transition cannot do that.

   Pure maths (project, rubberband, the solver) is tested in
   tests/motion.test.js. Nothing here touches the DOM except the
   helpers at the end.
----------------------------------------------- */

(function (root) {
  "use strict";

  const hasWindow = typeof window !== "undefined";

  function reduceMotion() {
    return hasWindow && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
  }

  /* ---------- One rAF driver for every spring ----------
     Shared so all motion in a frame is computed against the same clock. */
  const running = new Set();
  let rafId = 0;
  let lastTime = 0;

  function frame(now) {
    // Clamp after a stall (background tab) so nothing is flung across the screen
    const dt = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;
    for (const s of [...running]) s.step(dt);
    rafId = running.size ? requestAnimationFrame(frame) : 0;
  }

  function schedule(spring) {
    running.add(spring);
    if (!rafId && hasWindow) {
      lastTime = performance.now();
      rafId = requestAnimationFrame(frame);
    }
  }

  /**
   * A single scalar spring.
   *
   * Apple describes springs with damping ratio and response rather than
   * mass/stiffness/damping, and Motion exposes the same idea as bounce and
   * duration. Here: zeta = 1 - bounce, omega = 2*PI / duration.
   *   bounce 0    -> critically damped, settles without overshoot (UI default)
   *   bounce ~0.2 -> a little overshoot, for motion that followed a flick
   *
   * Each frame solves the analytic solution from the current value and
   * velocity, which stays stable at any frame rate and makes interruption
   * free: re-targeting mid-flight simply changes `target`.
   *
   * Decompose 2D motion into one Spring per axis. A single spring on a 2D
   * distance desynchronises when the axes carry different velocities.
   */
  class Spring {
    constructor(options = {}) {
      this.value = options.value ?? 0;
      this.velocity = options.velocity ?? 0;
      this.target = this.value;
      this.bounce = options.bounce ?? 0;
      this.duration = options.duration ?? 0.4;
      this.precision = options.precision ?? 0.08;
      this.onUpdate = options.onUpdate || null;
      this.onRest = options.onRest || null;
      this.resting = true;
    }

    /** Jump to a value with no animation (also used as the reduced-motion path). */
    set(value, velocity = 0) {
      running.delete(this);
      this.value = value;
      this.target = value;
      this.velocity = velocity;
      this.resting = true;
      if (this.onUpdate) this.onUpdate(this.value, this.velocity);
      return this;
    }

    /**
     * Animate towards a new target from wherever the value is right now.
     * Pass `velocity` to hand off a gesture's release speed, so there is no
     * seam between dragging and animating.
     */
    to(target, options = {}) {
      if (options.bounce !== undefined) this.bounce = options.bounce;
      if (options.duration !== undefined) this.duration = options.duration;
      if (options.velocity !== undefined) this.velocity = options.velocity;
      this.target = target;

      if (reduceMotion() && !options.force) {
        this.set(target);
        if (this.onRest) this.onRest(this.value);
        return this;
      }
      this.resting = false;
      schedule(this);
      return this;
    }

    step(dt) {
      if (dt <= 0) return this.value;
      const zeta = Math.min(Math.max(1 - this.bounce, 0), 1);
      const omega = (2 * Math.PI) / Math.max(this.duration, 0.0001);
      const x0 = this.value - this.target;
      const v0 = this.velocity;
      let x;
      let v;

      if (zeta >= 1) {
        // Critically damped
        const decay = Math.exp(-omega * dt);
        const a = x0;
        const b = v0 + omega * x0;
        x = (a + b * dt) * decay;
        v = (b - omega * (a + b * dt)) * decay;
      } else {
        // Under-damped: overshoots, then settles
        const wd = omega * Math.sqrt(1 - zeta * zeta);
        const decay = Math.exp(-zeta * omega * dt);
        const a = x0;
        const b = (v0 + zeta * omega * x0) / wd;
        const cos = Math.cos(wd * dt);
        const sin = Math.sin(wd * dt);
        x = decay * (a * cos + b * sin);
        v = decay * ((b * wd - zeta * omega * a) * cos - (a * wd + zeta * omega * b) * sin);
      }

      this.value = this.target + x;
      this.velocity = v;

      if (Math.abs(x) < this.precision && Math.abs(v) < this.precision * 10) {
        this.value = this.target;
        this.velocity = 0;
        this.resting = true;
        running.delete(this);
        if (this.onUpdate) this.onUpdate(this.value, this.velocity);
        if (this.onRest) this.onRest(this.value);
        return this.value;
      }

      if (this.onUpdate) this.onUpdate(this.value, this.velocity);
      return this.value;
    }

    stop() {
      running.delete(this);
      this.velocity = 0;
      this.resting = true;
      return this;
    }
  }

  /**
   * Where a flick would come to rest, so motion can be aimed at where the
   * gesture was going instead of where the finger happened to leave.
   * This is the exponential-decay form used by iOS scrolling, not the
   * textbook v^2/(2a).
   */
  function project(velocity, decelerationRate = 0.998) {
    return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
  }

  /**
   * Progressive resistance past a boundary. A hard stop reads as frozen;
   * resistance reads as "responsive, but there is nothing more here".
   */
  function rubberband(overshoot, dimension, constant = 0.55) {
    if (!dimension) return 0;
    return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
  }

  /**
   * Keeps a short history of pointer samples so a gesture can hand its real
   * release velocity to a spring. The last point alone is too noisy.
   */
  function createVelocityTracker(windowMs = 100) {
    let samples = [];
    return {
      reset() {
        samples = [];
      },
      add(value, time = hasWindow ? performance.now() : Date.now()) {
        samples.push({ value, time });
        const cutoff = time - windowMs;
        while (samples.length > 2 && samples[0].time < cutoff) samples.shift();
      },
      /** Pixels per second over the retained window. */
      velocity() {
        if (samples.length < 2) return 0;
        const first = samples[0];
        const last = samples[samples.length - 1];
        const dt = (last.time - first.time) / 1000;
        if (dt <= 0) return 0;
        return (last.value - first.value) / dt;
      },
    };
  }

  const api = { Spring, project, rubberband, createVelocityTracker, reduceMotion };

  /* ---------- DOM helpers ---------- */
  if (hasWindow) {
    /** Only transform and opacity: the two properties the compositor can animate cheaply. */
    api.write = function write(el, { x = 0, y = 0, scale = 1, opacity = null }) {
      if (!el) return;
      el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)${scale === 1 ? "" : ` scale(${scale.toFixed(4)})`}`;
      if (opacity !== null) el.style.opacity = String(Math.max(0, Math.min(1, opacity)).toFixed(3));
    };

    api.clear = function clear(el) {
      if (!el) return;
      el.style.transform = "";
      el.style.opacity = "";
      el.style.willChange = "";
    };

    /** Hint the compositor just before motion starts, and release it after. */
    api.hint = function hint(el, on) {
      if (el) el.style.willChange = on ? "transform, opacity" : "";
    };

    /**
     * A short, meaningful haptic. Reserved for commits and snaps: over-feedback
     * trains people to ignore all of it.
     */
    api.tap = function tap(pattern = 8) {
      try {
        if (navigator.vibrate && !reduceMotion()) navigator.vibrate(pattern);
      } catch (err) {
        /* unsupported, and not worth reporting */
      }
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TPMotion = api;
})(typeof window !== "undefined" ? window : globalThis);
