import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseDrawerStop, DRAWER_STOPS, nextDrawerStop, resistDrawerProgress, stepDrawerSpring, unresistDrawerProgress } from '../src/lib/drawer-physics.ts';

test('drawer boundary resistance grows smoothly and limits extreme over-pulls', () => {
  const travel = 350;
  const pull = (px: number) => (resistDrawerProgress(1 + px / travel, travel) - 1) * travel;
  assert.equal(resistDrawerProgress(0.4, travel), 0.4);
  assert.ok(pull(40) > 0 && pull(40) < 40);
  assert.ok(pull(80) - pull(40) < pull(40), 'each extra finger movement has less effect');
  assert.ok(pull(10000) <= 40.00001);
  assert.ok(resistDrawerProgress(-100, travel) * travel >= -8.00001);
  assert.ok((resistDrawerProgress(100, travel, 8) - 1) * travel <= 8.00001, 'tall drawers retain viewport headroom');
});

test('catching a stretched surface continues from where it is drawn', () => {
  const travel = 400;
  for (const raw of [-0.3, -0.01, 0.2, 0.5, 1, 1.05, 1.2]) {
    const shown = resistDrawerProgress(raw, travel);
    // Within a twentieth of a pixel, including the deepest over-pulls.
    assert.ok(Math.abs(resistDrawerProgress(unresistDrawerProgress(shown, travel), travel) - shown) * travel < 0.05, `raw ${raw}`);
  }
});

test('a tap springs from rest: a gentle first frame, past the stop and back', () => {
  let x = 0, v = 0, peak = 0;
  const frames: number[] = [];
  for (let i = 0; i < 90; i++) { [x, v] = stepDrawerSpring(x, v, 1, 1 / 60); frames.push(x); peak = Math.max(peak, x); }
  assert.ok(frames[0] < 0.05, `first frame ${frames[0]}`);
  assert.ok(frames[9] > 0.85, `after 167ms ${frames[9]}`);
  assert.ok(peak > 1.02 && peak < 1.12, `peak ${peak}`);
  assert.ok(Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01);
});

test('the half stop holds a slow release and a flick passes it', () => {
  assert.equal(chooseDrawerStop(0.45, 0), 'half');
  assert.equal(chooseDrawerStop(0.2, 0), 'closed');
  assert.equal(chooseDrawerStop(0.2, 5), 'open');
  assert.equal(chooseDrawerStop(0.8, -5), 'closed');
  assert.equal(chooseDrawerStop(0.6, -1), 'half');
  assert.equal(chooseDrawerStop(1.1, 0), 'open');
  assert.deepEqual(['closed', 'half', 'open'].map(stop => DRAWER_STOPS[stop as keyof typeof DRAWER_STOPS]), [0, 0.5, 1]);
});

test('taps on the grip step closed, half, open, then close', () => {
  assert.equal(nextDrawerStop('closed'), 'half');
  assert.equal(nextDrawerStop('half'), 'open');
  assert.equal(nextDrawerStop('open'), 'closed');
});
