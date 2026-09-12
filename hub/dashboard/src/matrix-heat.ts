/** Discrete heat levels used by the client × model matrix. */
export type MatrixHeatLevel = 0 | 1 | 2 | 3 | 4;

export function matrixHeatPeak(
  source: Record<string, Record<string, number>> | undefined,
): number {
  return Object.values(source || {})
    .flatMap((row) => Object.values(row))
    .reduce((peak, value) => Math.max(peak, value), 0);
}

/**
 * Map a reported cell onto the 5-stop heat scale.
 *
 * Level 0 is reserved for absent or non-positive amounts so it can share the
 * empty-cell treatment. Any positive amount stays at least level 1; otherwise a
 * linear `floor(value / peak * 4)` paints everything under 25% of the peak as
 * empty, which is the live "has a number, no color" bug.
 */
export function matrixHeatLevel(
  value: number | undefined,
  peak: number,
): MatrixHeatLevel {
  if (value === undefined || !(value > 0)) return 0;
  if (!(peak > 0)) return 1;
  return Math.max(
    1,
    Math.min(4, Math.floor((value / peak) * 4)),
  ) as MatrixHeatLevel;
}
