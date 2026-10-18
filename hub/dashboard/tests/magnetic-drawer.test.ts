import test from 'node:test';
import assert from 'node:assert/strict';
import { MagneticDrawer, magneticStops } from '../src/lib/magnetic-drawer.ts';

const stops = [0, 257, 514];
function settle(body: MagneticDrawer) { for (let i = 0; i < 720 && !body.settled(); i++) body.step(1 / 120); assert.ok(body.settled()); return body.rest(); }

test('free magnetic motion matches samples from Feel runtime/feel.js', () => {
  // Generated from the upstream Body + magnets with the magnetic preset.
  // This guards the force law and RK4 integration, rather than a target spring.
  const samples = [
    [1, 413.80311659212504, -767.9757203322141],
    [6, 395.65025323505654, 91.16390967945972],
    [12, 413.82359162366316, 215.67109037144525],
    [30, 464.8560803872419, 119.14584608913842],
    [60, 515.5470334336368, -59.90434169560436],
  ];
  const body = new MagneticDrawer(stops, 430); body.v = -1200;
  for (let frame = 1; frame <= 60; frame++) {
    body.step(1 / 60); const expected = samples.find(sample => sample[0] === frame);
    if (expected) { assert.ok(Math.abs(body.x - expected[1]) < 1e-8); assert.ok(Math.abs(body.v - expected[2]) < 1e-8); }
  }
});

test('each handle tap uses one impulse that lands in its requested magnet', () => {
  const body = new MagneticDrawer(stops);
  for (const stop of [257, 0, 514, 0, 257, 514]) {
    const x = body.x; body.kickTo(stop); assert.equal(body.x, x); assert.notEqual(body.v, 0);
    assert.equal(settle(body), stop); body.snap();
  }
});

test('the hand pulls with a spring, reverses direction and retains real release velocity', () => {
  const body = new MagneticDrawer(stops); body.grab(514, 0); body.move(350, 16);
  assert.equal(body.x, 514); // Moving the hand never assigns the body's position.
  body.step(1 / 60); assert.ok(body.x < 514 && body.x > 350); assert.ok(body.v < 0);
  body.move(490, 32); body.step(1 / 60); body.step(1 / 60);
  assert.ok(body.v > 0);
  const velocity = body.v, position = body.x; body.release();
  assert.equal(body.v, velocity); assert.equal(body.x, position); assert.equal(body.hand, null);
  assert.equal(settle(body), 514);
});

test('a moving drawer can be caught without resetting position or velocity', () => {
  const body = new MagneticDrawer(stops); body.kickTo(0); body.step(.04);
  const state = { x: body.x, v: body.v }; assert.ok(state.v < 0);
  body.grab(body.x, 40); assert.deepEqual({ x: body.x, v: body.v }, state);
  body.move(body.x + 80, 60); body.step(.04); body.release();
  assert.ok(Number.isFinite(body.x) && Number.isFinite(body.v)); assert.ok(stops.includes(settle(body)));
});

test('a tap can reopen a closing drawer in every part of its release', () => {
  for (const elapsed of [.005, .01, .02, .04, .06, .1, .2]) {
    const body = new MagneticDrawer(stops, 0); body.kickTo(514); body.step(elapsed);
    const position = body.x; body.kickTo(257); assert.equal(body.x, position);
    assert.equal(settle(body), 257);
  }
});

test('end walls return overshoot and releases choose magnets from actual momentum', () => {
  const slow = new MagneticDrawer(stops, 350), fast = new MagneticDrawer(stops, 350); fast.v = -6000;
  assert.equal(settle(slow), 257); assert.equal(settle(fast), 0);
  const wall = new MagneticDrawer(stops, -35); wall.v = -300;
  assert.ok(wall.force(wall.x, wall.v) > 0); assert.equal(settle(wall), 0);
});

test('three stops fit the visible bar and resizing preserves motion progress', () => {
  assert.deepEqual(magneticStops(620, 106), [0, 257, 514]);
  assert.deepEqual(magneticStops(374, 106), [0, 134, 268]);
  const body = new MagneticDrawer(stops, 300); body.v = -400; body.grab(310, 10);
  body.resize([0, 134, 268]);
  assert.ok(Math.abs(body.x / 268 - 300 / 514) < 1e-12); assert.ok(Math.abs(body.v / 268 + 400 / 514) < 1e-12);
  assert.ok(Math.abs(body.hand!.x / 268 - 310 / 514) < 1e-12);
});
