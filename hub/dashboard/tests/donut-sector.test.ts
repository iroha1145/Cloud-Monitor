import assert from "node:assert/strict";
import test from "node:test";
import { sector } from "../src/lib/donut-sector.ts";

const c = 104, R = 97, r = 73;

test("an empty share draws nothing and a whole ring draws both edges", () => {
  assert.equal(sector(c, R, r, 0.2, 0.2, 3, 4), "");
  const ring = sector(c, R, r, 0, 1, 3, 4);
  assert.equal(ring.match(/M/g)?.length, 2, "outer and inner circle");
});

test("a share thinner than the gap disappears instead of drawing a sliver", () => {
  const tiny = 2 / (2 * Math.PI * R); // 2px of arc against a 3px gap
  assert.equal(sector(c, R, r, 0, tiny, 3, 4), "");
});

test("neighbouring sectors leave the same gap at the inner and outer edge", () => {
  // The first point of a sector sits on its leading side, offset by half the
  // gap from the radius at its start angle (the top for turn 0).
  const start = sector(c, R, r, 0, 0.25, 4, 0).match(/^M([\d.]+) ([\d.]+)/);
  assert.ok(start);
  assert.equal(Number(start[1]), c + 2, "half of the 4px gap right of the top radius");
});
