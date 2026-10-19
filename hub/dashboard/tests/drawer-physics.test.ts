import test from 'node:test';
import assert from 'node:assert/strict';
import { DRAWER_FEEL, drawerAtRest, drawerForce, drawerStops, moveHand, nearestStop, nextDrawerStop, predictStop, pushToStop, stepDrawer, type DrawerBody, type DrawerStop, type DrawerStops } from '../src/lib/drawer-physics.ts';

/** Runs a free panel at 60fps until it rests; returns where, when and how far it swung. */
function release(stops: DrawerStops, x: number, v: number, dt = 1 / 60) {
  const body: DrawerBody = { x, v, hand: null };
  let t = 0, low = x, high = x, near: number | null = null;
  const goal = () => stops[predictStop(x, v, stops)];
  const target = goal();
  while (t < 6 && !drawerAtRest(body, stops)) {
    stepDrawer(body, stops, dt); t += dt;
    low = Math.min(low, body.x); high = Math.max(high, body.x);
    if (near === null && Math.abs(body.x - target) < 2) near = t;
  }
  return { stop: nearestStop(body.x, stops), t, low, high, near: near ?? t };
}

/** The stops of a 566px menu (84px tab bar closed), as on a 390 × 844 phone. */
const PHONE = drawerStops(566, 84);

test('the stops split the travel of a fixed-height panel', () => {
  assert.deepEqual(PHONE, { open: 0, half: 241, closed: 482 });
  assert.deepEqual(drawerStops(60, 84), { open: 0, half: 0, closed: 0 });
  assert.equal(nearestStop(120, PHONE), 'open');
  assert.equal(nearestStop(122, PHONE), 'half');
  assert.equal(nearestStop(400, PHONE), 'closed');
});

test('the magnets are Feel\'s magnetic drawer: a weak reach and a strong click within 22px', () => {
  const at = (u: number) => -drawerForce(PHONE.half + u, 0, PHONE);
  assert.ok(Math.abs(at(30) - DRAWER_FEEL.reach * 30) < 1e-9, 'only the reach beyond the click radius');
  assert.ok(at(10) > DRAWER_FEEL.reach * 10 * 10, 'the click dominates close in');
  assert.ok(at(-10) < 0 && at(10) > 0, 'both sides pull towards the stop');
  assert.equal(Math.abs(drawerForce(PHONE.half, 0, PHONE)), 0);
});

test('a tap pushes the panel to the next stop at every phone height, quickly and with a small swing', () => {
  for (const height of [300, 366, 420, 566, 820]) {
    const stops = drawerStops(height, 84);
    for (const [from, to] of [['closed', 'half'], ['half', 'open'], ['open', 'closed'], ['closed', 'open'], ['open', 'half'], ['half', 'closed']] as [DrawerStop, DrawerStop][]) {
      const push = pushToStop(stops[from], 0, to, stops);
      // Exactly the push that coasts the distance on damping alone.
      assert.ok(Math.abs(push - (stops[to] - stops[from]) * DRAWER_FEEL.damping) < 1e-6, `${height} ${from}→${to} push ${push}`);
      const run = release(stops, stops[from], push);
      assert.equal(run.stop, to, `${height} ${from}→${to}`);
      assert.ok(run.near < 0.3, `${height} ${from}→${to} within 2px after ${run.near}s`);
      assert.ok(run.t < 0.7, `${height} ${from}→${to} at rest after ${run.t}s`);
      const swing = stops[to] > stops[from] ? run.high - stops[to] : stops[to] - run.low;
      assert.ok(swing < 10, `${height} ${from}→${to} swings ${swing}px past the stop`);
    }
  }
});

test('a push from a moving panel replaces its velocity, so a tap can reverse a closing panel', () => {
  const closing = { x: 300, v: 2500 };
  const push = pushToStop(closing.x, closing.v, 'half', PHONE);
  assert.equal(release(PHONE, closing.x, closing.v + push).stop, 'half');
  assert.equal(pushToStop(PHONE.half, 0, 'half', PHONE), 0);
});

test('a still release rests on the nearest stop and only real momentum passes one', () => {
  for (const [x, stop] of [[200, 'half'], [300, 'half'], [360, 'half'], [420, 'closed'], [110, 'open'], [-30, 'open'], [520, 'closed']] as [number, DrawerStop][]) {
    assert.equal(release(PHONE, x, 0).stop, stop, `still at ${x}`);
  }
  // Damping takes about v / 22 px of coasting: a quick upward flick from the
  // closed stop stays there, the same flick let go just past half reaches open.
  assert.equal(release(PHONE, PHONE.closed, -1400).stop, 'closed');
  assert.equal(release(PHONE, PHONE.half - 40, -3000).stop, 'open');
  assert.equal(release(PHONE, PHONE.half + 40, 3000).stop, 'closed');
  assert.equal(predictStop(PHONE.half - 40, -3000, PHONE), 'open');
});

test('walls push back without holding on, and pressing in is damped', () => {
  const over = release(PHONE, -30, 0);
  assert.equal(over.stop, 'open');
  assert.ok(over.high < 60, `a 30px over-pull rebounds ${over.high}px`);
  const under = release(PHONE, PHONE.closed + 30, 0);
  assert.equal(under.stop, 'closed');
  // Thrown hard at the open stop, the panel presses at most a few tens of px in.
  const thrown = release(PHONE, 100, -4000);
  assert.equal(thrown.stop, 'open');
  assert.ok(thrown.low > -45, `pressed ${thrown.low}px past the wall`);
});

test('a finger leads the panel through a spring and the magnets are felt under it', () => {
  const hold = (handX: number) => {
    const body: DrawerBody = { x: handX, v: 0, hand: { x: handX, v: 0, t: 0 } };
    for (let i = 0; i < 120; i++) stepDrawer(body, PHONE, 1 / 60);
    return body.x;
  };
  // Far from a stop the panel sits within the reach's small pull of the finger.
  assert.ok(Math.abs(hold(360) - 360) < 5);
  // Ten px from the half stop the click draws it most of the way in.
  const near = hold(PHONE.half + 10);
  assert.ok(near < PHONE.half + 6 && near > PHONE.half, `held at ${near}`);
  // Past the open stop the wall lets it travel about a third of the finger.
  const pulled = hold(-60);
  assert.ok(pulled < -10 && pulled > -30, `over-pulled to ${pulled}`);
  assert.equal(drawerAtRest({ x: PHONE.half, v: 0, hand: { x: PHONE.half, v: 0, t: 0 } }, PHONE), false);
});

test('the hand keeps 35% of its old velocity', () => {
  const hand = moveHand({ x: 100, v: 1000, t: 0 }, 90, 10);
  assert.equal(hand.x, 90); assert.equal(hand.t, 10);
  assert.ok(Math.abs(hand.v - (1000 * 0.35 - 1000 * 0.65)) < 1e-9);
  assert.equal(moveHand(hand, 80, 10).v, hand.v, 'two samples at one instant keep the velocity');
});

test('slow frames neither explode nor change the path: every frame runs the same 240Hz sub-steps', () => {
  for (const [from, to] of [['closed', 'open'], ['open', 'half']] as [DrawerStop, DrawerStop][]) {
    const push = pushToStop(PHONE[from], 0, to, PHONE);
    const fast: DrawerBody = { x: PHONE[from], v: push, hand: null }, slow: DrawerBody = { ...fast };
    for (let frame = 0; frame < 30; frame++) {
      for (let i = 0; i < 4; i++) stepDrawer(fast, PHONE, 1 / 120);
      stepDrawer(slow, PHONE, 1 / 30);
      assert.ok(Math.abs(fast.x - slow.x) < 1e-6, `${from}→${to} frame ${frame}: ${fast.x} vs ${slow.x}`);
    }
    assert.equal(release(PHONE, PHONE[from], push, 1 / 30).stop, to);
  }
});

test('taps on the grip step closed, half, open, then close', () => {
  assert.equal(nextDrawerStop('closed'), 'half');
  assert.equal(nextDrawerStop('half'), 'open');
  assert.equal(nextDrawerStop('open'), 'closed');
});
