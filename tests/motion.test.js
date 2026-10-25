// The maths behind the motion system. No DOM, so it runs in Node.
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../motion.js");

// Advance a spring by whole frames, as the rAF driver would.
function run(spring, seconds, fps = 60) {
  const dt = 1 / fps;
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) spring.step(dt);
  return spring;
}

test("a critically damped spring settles on target without overshooting", () => {
  let maxValue = 0;
  const s = new M.Spring({ value: 0, bounce: 0, duration: 0.4, onUpdate: (v) => (maxValue = Math.max(maxValue, v)) });
  s.to(100, { force: true });
  run(s, 1.5);
  assert.equal(s.value, 100);
  assert.equal(s.resting, true);
  assert.ok(maxValue <= 100.01, `overshot to ${maxValue}`);
});

test("bounce overshoots, and still settles", () => {
  let maxValue = 0;
  const s = new M.Spring({ value: 0, bounce: 0.35, duration: 0.4, onUpdate: (v) => (maxValue = Math.max(maxValue, v)) });
  s.to(100, { force: true });
  run(s, 3);
  assert.ok(maxValue > 100, "expected overshoot");
  assert.equal(s.value, 100);
});

test("re-targeting mid-flight continues from the on-screen value, with no jump", () => {
  const s = new M.Spring({ value: 0, bounce: 0, duration: 0.4 });
  s.to(300, { force: true });
  run(s, 0.12);
  const interrupted = s.value;
  const speed = s.velocity;
  assert.ok(interrupted > 0 && interrupted < 300, `expected mid-flight, got ${interrupted}`);
  assert.ok(speed > 0);

  s.to(0, { force: true }); // reverse, as a grabbed element would
  assert.equal(s.value, interrupted, "value must not jump on re-target");
  assert.equal(s.velocity, speed, "velocity must carry through the reversal");
  run(s, 2);
  assert.equal(s.value, 0);
});

test("a handed-off release velocity is used, so drag and animation have no seam", () => {
  const slow = new M.Spring({ value: 0, bounce: 0, duration: 0.4 }).to(100, { velocity: 0, force: true });
  const fast = new M.Spring({ value: 0, bounce: 0, duration: 0.4 }).to(100, { velocity: 2000, force: true });
  run(slow, 0.1);
  run(fast, 0.1);
  assert.ok(fast.value > slow.value, "a thrown element should be further along");
});

test("set() stops motion and holds the value", () => {
  const s = new M.Spring({ value: 0, duration: 0.4 });
  s.to(500, { force: true });
  run(s, 0.1);
  s.set(42);
  assert.equal(s.value, 42);
  assert.equal(s.target, 42);
  assert.equal(s.velocity, 0);
  run(s, 1);
  assert.equal(s.value, 42, "a set value must not drift");
});

test("the solver is stable at low frame rates and across a long stall", () => {
  for (const fps of [120, 60, 30, 10]) {
    const s = new M.Spring({ value: 0, bounce: 0.2, duration: 0.4 });
    s.to(100, { force: true });
    run(s, 3, fps);
    assert.equal(s.value, 100, `fps ${fps}`);
  }
  const s = new M.Spring({ value: 0, duration: 0.4 });
  s.to(100, { force: true });
  s.step(5); // one enormous frame
  assert.ok(Number.isFinite(s.value) && Math.abs(s.value - 100) < 1);
});

test("momentum projection uses the exponential-decay form", () => {
  // 1000 px/s with the standard rate lands about half a screen away
  assert.equal(Math.round(M.project(1000)), 499);
  assert.equal(M.project(0), 0);
  assert.ok(M.project(-1000) < 0, "direction is preserved");
  assert.ok(Math.abs(M.project(1000, 0.99)) < Math.abs(M.project(1000, 0.998)), "lower rate = shorter throw");
  // Not the textbook v^2/(2a) form: projection is linear in velocity
  assert.ok(Math.abs(M.project(2000) - 2 * M.project(1000)) < 0.001);
});

test("rubberbanding resists more the further past the edge you pull", () => {
  const dim = 400;
  const small = M.rubberband(20, dim);
  const large = M.rubberband(200, dim);
  assert.ok(small < 20, "always less than the raw overshoot");
  assert.ok(large < 200);
  assert.ok(large > small, "still moves, just less");
  assert.ok(large / 200 < small / 20, "resistance increases with distance");
  assert.equal(M.rubberband(50, 0), 0);
  assert.ok(M.rubberband(-50, dim) < 0, "works in both directions");
});

test("velocity tracker reports px/s from recent samples only", () => {
  const t = M.createVelocityTracker(100);
  t.add(0, 1000);
  t.add(100, 1100); // 100px in 100ms
  assert.equal(Math.round(t.velocity()), 1000);

  // Older samples fall out of the window, so a stop is seen as a stop
  t.add(100, 1200);
  t.add(100, 1250);
  assert.ok(Math.abs(t.velocity()) < 500);

  const empty = M.createVelocityTracker();
  assert.equal(empty.velocity(), 0, "a single sample is not a velocity");
});
