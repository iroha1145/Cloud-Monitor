import assert from "node:assert/strict";
import test from "node:test";
import { escapeCsv } from "../src/lib/csv.ts";

test("numeric negatives stay numeric instead of formula-escaped text", () => {
  assert.equal(escapeCsv(-0.45), "-0.45");
  assert.equal(escapeCsv(12), "12");
  assert.equal(escapeCsv("=cmd"), `"'=cmd"`);
  assert.equal(escapeCsv("-0.45"), `"-0.45"`);
});
