import assert from "node:assert/strict";
import test from "node:test";
import { usd } from "../src/money.ts";

test("negative USD keeps the sign outside the dollar", () => {
  assert.equal(usd(-0.45), "-$0.45");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(1234.5), "$1,234.50");
  assert.equal(usd(null), "未提供");
});

test("rounded zero has no negative sign and unavailable amounts stay unknown", () => {
  assert.equal(usd(-0.004), "$0.00");
  assert.equal(usd(-0), "$0.00");
  assert.equal(usd(-0.005), "-$0.01");
  assert.equal(usd(Number.NaN), "未提供");
  assert.equal(usd(Number.POSITIVE_INFINITY), "未提供");
});
