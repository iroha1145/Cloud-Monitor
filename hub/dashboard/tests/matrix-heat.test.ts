import assert from "node:assert/strict";
import test from "node:test";
import { createDemoData } from "../src/data.ts";
import {
  matrixHeatLevel,
  matrixHeatPeak,
} from "../src/matrix-heat.ts";

test("heat peak is the actual reported maximum, including amounts below 1", () => {
  assert.equal(matrixHeatPeak(undefined), 0);
  assert.equal(matrixHeatPeak({}), 0);
  assert.equal(matrixHeatPeak({ grok: {}, cursor: { auto: 0 } }), 0);
  assert.equal(
    matrixHeatPeak({
      grok: { "grok-4.6": 260_000_000 },
      cursor: { "cursor-grok-4-x": 17_972_000 },
    }),
    260_000_000,
  );
  assert.equal(
    matrixHeatPeak({
      cursor: { "gemini-3-pro": 0.08, "gpt-5-solotel": 0.42 },
    }),
    0.42,
  );
});

test("absent or non-positive cells stay empty; any positive amount gets a color", () => {
  const peak = 260_000_000;
  assert.equal(matrixHeatLevel(undefined, peak), 0);
  assert.equal(matrixHeatLevel(0, peak), 0);
  assert.equal(matrixHeatLevel(-1, peak), 0);
  assert.equal(matrixHeatLevel(Number.NaN, peak), 0);
  assert.equal(matrixHeatLevel(peak, peak), 4);
  assert.equal(matrixHeatLevel(195_000_000, peak), 3);
  assert.equal(matrixHeatLevel(130_000_000, peak), 2);
  assert.equal(matrixHeatLevel(65_000_000, peak), 1);
  // Live screenshot: 万-scale cells were painted level-0 against a 亿-scale peak.
  assert.equal(matrixHeatLevel(14_295_000, peak), 1);
  assert.equal(matrixHeatLevel(77_000, peak), 1);
  assert.equal(matrixHeatLevel(1, peak), 1);
});

test("costs under one dollar keep a four-stop scale instead of collapsing to empty", () => {
  assert.equal(matrixHeatLevel(0.8, 0.8), 4);
  assert.equal(matrixHeatLevel(0.2, 0.8), 1);
  assert.equal(matrixHeatLevel(0.05, 0.8), 1);
  assert.equal(matrixHeatLevel(0.05, 1), 1);
  assert.equal(matrixHeatLevel(0.01, 0), 1);
});

test("sample client × model matrices color every reported positive cell", () => {
  const data = createDemoData(new Date("2026-09-05T02:00:00Z"));
  for (const period of Object.values(data.periods)) {
    for (const key of ["clientModels", "clientModelCosts"] as const) {
      const source = period[key] || {};
      const peak = matrixHeatPeak(source);
      let colored = 0;
      for (const row of Object.values(source)) {
        for (const value of Object.values(row)) {
          const level = matrixHeatLevel(value, peak);
          if (value > 0) {
            assert.ok(level >= 1, `${key} ${value} / ${peak} -> ${level}`);
            colored += 1;
          } else {
            assert.equal(level, 0);
          }
        }
      }
      assert.ok(colored > 0);
    }
  }
});
