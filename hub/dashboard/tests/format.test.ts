import assert from "node:assert/strict";
import test from "node:test";
import { compact, count, full, pct } from "../src/lib/format.ts";

test("compact rolls 10000 万 over to 1 亿 instead of showing 10000.0 万", () => {
  assert.equal(compact(99_999_449), "9999.9 万");
  assert.equal(compact(99_999_450), "9999.9 万");
  assert.equal(compact(99_999_499), "9999.9 万");
  assert.equal(compact(99_999_500), "1.00 亿");
  assert.equal(compact(99_999_999), "1.00 亿");
  assert.equal(compact(100_000_000), "1.00 亿");
});

test("compact formats each magnitude band", () => {
  assert.equal(compact(0), "0");
  assert.equal(compact(9_999), "9,999");
  assert.equal(compact(10_000), "1.0 万");
  assert.equal(compact(123_456_789), "1.23 亿");
});

test("count, full and pct keep their empty-value contract", () => {
  assert.equal(count(1_234_567), "1,234,567");
  assert.equal(full(12_000), "12,000");
  assert.equal(full(null), "未提供");
  assert.equal(pct(0.281), "28.1%");
  assert.equal(pct(null), "未提供");
});
