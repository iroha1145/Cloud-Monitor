import assert from "node:assert/strict";
import test from "node:test";
import { usd } from "../src/money.ts";

test("negative USD keeps the sign outside the dollar", () => {
  assert.equal(usd(-0.45), "-$0.45");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(1234.5), "$1,234.50");
  assert.equal(usd(null), "未提供");
});
