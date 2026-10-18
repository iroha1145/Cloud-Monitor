import test from 'node:test';
import assert from 'node:assert/strict';
import { cardAvoidance, cornerPosition, itemRepulsion, navigationBounds, projectedCorner, springStep, SLOT_SPRING } from '../src/lib/feel-physics.ts';

test('navigation keeps 16px from the edges and projects throw momentum to a corner', () => {
  assert.deepEqual(navigationBounds(320, 240, 216, 500), { left: 16, top: 16, right: 88, bottom: 16 });
  const b = navigationBounds(1280, 900, 216, 500);
  // 70ms of the release velocity decides the corner (game-manage).
  assert.equal(projectedCorner(450, 100, 2000, 3000, b), 'bottom-right');
  assert.equal(projectedCorner(450, 100, 1000, 0, b), 'top-left');
  assert.deepEqual(cornerPosition('bottom-right', b), { x: 1048, y: 384 });
  assert.equal(projectedCorner(450, 100, 0, 0, b), 'top-left');
});
test('Feel spring settles after a high velocity release and survives delayed frames', () => {
  let x = 0, v = 4000;
  for (let i = 0; i < 180; i++) [x, v] = springStep(x, v, 400, i % 5 === 0 ? .2 : 1 / 60);
  assert.ok(Math.abs(x - 400) < .01);
  assert.ok(Math.abs(v) < .1);
});
test('the slot spring (mass 1, k 260, c 28) settles without a visible overshoot', () => {
  let x = 0, v = 0, peak = 0;
  for (let i = 0; i < 120; i++) { [x, v] = springStep(x, v, 100, 1 / 60, ...SLOT_SPRING); peak = Math.max(peak, x); }
  assert.ok(Math.abs(x - 100) < .05);
  assert.ok(peak < 101, `peak ${peak}`);
});
test('wide panels clear the docked menu by shrinking inside their original slot', () => {
  const card = { left: 300, right: 1240, top: 100, bottom: 400, width: 940, height: 300 };
  const menu = { left: 1044, right: 1268, top: 12, bottom: 525, width: 224, height: 513 };
  const result = cardAvoidance(card, menu, { left: 0, right: 1280 });
  assert.equal(result.inset, 0); assert.equal(result.loss, 212); assert.equal(result.covered, false);
  assert.equal(card.right - result.loss, menu.left - 16);
  assert.equal((card.width - result.loss) + result.inset + (result.loss - result.inset), card.width);
  const restored = cardAvoidance(card, { ...menu, left: 12, right: 236 }, { left: 0, right: 1280 }, result.side);
  assert.equal(restored.loss, 0); assert.equal(restored.inset, 0);
});
test('narrow cards retain their readable width and never lose more than a third', () => {
  const menu = { left: 1044, right: 1268, top: 12, bottom: 525, width: 224, height: 513 };
  for (const width of [240, 272, 300, 450, 940]) {
    const card = { left: 1240 - width, right: 1240, top: 100, bottom: 400, width, height: 300 };
    const target = cardAvoidance(card, menu, { left: 0, right: 1280 });
    assert.ok(width - target.loss >= Math.min(272, width)); assert.ok(target.loss <= width / 3);
  }
});

test('mobile cards clear a sheet when free vertical space permits, without horizontal movement or shrinking', async () => {
  const { mobileCardAvoidance } = await import('../src/lib/feel-physics.ts');
  const card = { left: 16, right: 374, top: 200, bottom: 500, width: 358, height: 300 };
  const sheet = { left: 0, right: 390, top: 490, bottom: 844, width: 390, height: 354 };
  const response = mobileCardAvoidance(card, sheet, 66, 120);
  assert.equal(response.y, -26); assert.equal(response.clear, true);
  assert.equal(card.bottom + response.y, sheet.top - 16);
  assert.deepEqual(card, { left: 16, right: 374, top: 200, bottom: 500, width: 358, height: 300 });
  assert.equal(mobileCardAvoidance(card, null, 66, 120).y, 0);
});
test('mobile repulsion respects preceding controls, top safety and partially visible long cards', async () => {
  const { mobileCardAvoidance } = await import('../src/lib/feel-physics.ts');
  const sheet = { left: 0, right: 390, top: 490, bottom: 844, width: 390, height: 354 };
  const card = { left: 16, right: 374, top: 200, bottom: 760, width: 358, height: 560 };
  const constrained = mobileCardAvoidance(card, sheet, 66, 190);
  assert.equal(constrained.y, -2); assert.equal(constrained.clear, false);
  assert.ok(card.top + constrained.y >= 190 + 8);
  const top = mobileCardAvoidance({ ...card, top: 70, bottom: 246, height: 176 }, { ...sheet, top: 224 }, 66, null);
  assert.equal(top.y, -4);
  const long = { ...card, top: -300, bottom: 760, height: 1060 };
  const visible = mobileCardAvoidance(long, sheet, 12, null);
  assert.equal(visible.y, -32); assert.ok(long.bottom + visible.y >= 12 + 64);
  assert.equal(mobileCardAvoidance({ ...card, top: 550 }, sheet, 66, null).y, 0);
});

test('inner records react before touching the menu and return to rest beyond their own neighborhood', () => {
  const item = { left: 200, right: 400, top: 200, bottom: 240, width: 200, height: 40 };
  const menu = { left: 416, right: 640, top: 180, bottom: 500, width: 224, height: 320 };
  const row = itemRepulsion(item, menu, 'row'), cell = itemRepulsion(item, menu, 'cell');
  assert.ok(row.x < -5 && row.x >= -7); assert.equal(row.y, 0);
  assert.ok(cell.x < 0 && cell.x >= -1.8); assert.equal(cell.y, 0);
  assert.ok(row.scale >= .988 && row.scale < 1); assert.ok(cell.scale >= .985 && cell.scale < 1);
  const middle = { ...menu, left: 500, right: 724 };
  assert.ok(itemRepulsion(item, middle, 'row').x < 0);
  assert.deepEqual(itemRepulsion(item, middle, 'cell'), { x: 0, y: 0, scale: 1 });
  assert.deepEqual(itemRepulsion(item, { ...menu, left: 544, right: 768 }, 'row'), { x: 0, y: 0, scale: 1 });
  assert.deepEqual(itemRepulsion(item, null, 'row'), { x: 0, y: 0, scale: 1 });
  // A row stacked with others steps sideways only, even below the menu.
  assert.equal(itemRepulsion({ ...item, top: 520, bottom: 560 }, menu, 'row').y, 0);
  assert.deepEqual(item, { left: 200, right: 400, top: 200, bottom: 240, width: 200, height: 40 });
});

test('mobile inner records move upward within a small bound and ignore content behind the sheet', () => {
  const item = { left: 20, right: 370, top: 420, bottom: 480, width: 350, height: 60 };
  const sheet = { left: 0, right: 390, top: 500, bottom: 844, width: 390, height: 344 };
  for (const kind of ['row', 'cell'] as const) {
    const response = itemRepulsion(item, sheet, kind, true);
    assert.equal(response.x, 0); assert.ok(response.y < 0 && response.y >= (kind === 'row' ? -7 : -1.8));
    assert.deepEqual(itemRepulsion({ ...item, top: 520, bottom: 580 }, sheet, kind, true), { x: 0, y: 0, scale: 1 });
  }
});
