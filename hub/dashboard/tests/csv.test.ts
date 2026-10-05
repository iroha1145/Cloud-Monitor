import assert from "node:assert/strict";
import test from "node:test";
import { escapeCsv, rowsToCsv } from "../src/lib/csv.ts";

test("numeric negatives stay numeric instead of formula-escaped text", () => {
  assert.equal(escapeCsv(-0.45), "-0.45");
  assert.equal(escapeCsv(12), "12");
  assert.equal(escapeCsv("=cmd"), `"'=cmd"`);
  assert.equal(escapeCsv("-0.45"), `"'-0.45"`);
});

test("exports start with a BOM, join rows with CRLF and keep missing cells empty", () => {
  assert.equal(
    rowsToCsv([
      ["模型", "费用"],
      ['a "quoted", name', -1.5],
      ["=SUM(A1)", null],
    ]),
    '\ufeff"模型","费用"\r\n"a ""quoted"", name",-1.5\r\n"\'=SUM(A1)",""',
  );
});
