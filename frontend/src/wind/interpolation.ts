/**
 * Grid interpolation shared by all models.
 *
 * Fields are flat Float32Arrays in C order; `offset` points to the start of a
 * (ny, nx) slice. Fractional indices outside the grid are clamped to the edge.
 */

export function bilinear(
  data: Float32Array,
  offset: number,
  ny: number,
  nx: number,
  fy: number,
  fx: number,
): number {
  if (fy < 0) fy = 0;
  else if (fy > ny - 1) fy = ny - 1;
  if (fx < 0) fx = 0;
  else if (fx > nx - 1) fx = nx - 1;
  const j0 = Math.min(Math.floor(fy), ny - 2);
  const i0 = Math.min(Math.floor(fx), nx - 2);
  const ty = fy - j0;
  const tx = fx - i0;
  const r0 = offset + j0 * nx + i0;
  const r1 = r0 + nx;
  const a = data[r0] + (data[r0 + 1] - data[r0]) * tx;
  const b = data[r1] + (data[r1 + 1] - data[r1]) * tx;
  return a + (b - a) * ty;
}

/** Weights for sampling between forecast frames. */
export interface TimeWeights {
  i0: number;
  i1: number;
  alpha: number; // V(t) = (1 - alpha) V_i0 + alpha V_i1
}

/**
 * @param times  forecast lead times (hours, ascending)
 * @param t      requested lead time (hours)
 * @param smooth false -> switch directly between frames (nearest earlier frame)
 */
export function timeWeights(times: number[], t: number, smooth: boolean): TimeWeights {
  const n = times.length;
  if (n === 1 || t <= times[0]) return { i0: 0, i1: 0, alpha: 0 };
  if (t >= times[n - 1]) return { i0: n - 1, i1: n - 1, alpha: 0 };
  let i = 0;
  while (i < n - 2 && t >= times[i + 1]) i++;
  if (!smooth) return { i0: i, i1: i, alpha: 0 };
  return { i0: i, i1: i + 1, alpha: (t - times[i]) / (times[i + 1] - times[i]) };
}

/**
 * Bilinear in space, linear in time. `sliceSize` = ny * nx and `frameSize` =
 * nLevels * sliceSize for (time, level, y, x) arrays.
 */
export function sampleSpaceTime(
  data: Float32Array,
  tw: TimeWeights,
  level: number,
  ny: number,
  nx: number,
  nLevels: number,
  fy: number,
  fx: number,
): number {
  const slice = ny * nx;
  const o0 = (tw.i0 * nLevels + level) * slice;
  const a = bilinear(data, o0, ny, nx, fy, fx);
  if (tw.alpha === 0 || tw.i0 === tw.i1) return a;
  const o1 = (tw.i1 * nLevels + level) * slice;
  const b = bilinear(data, o1, ny, nx, fy, fx);
  return a + (b - a) * tw.alpha;
}
