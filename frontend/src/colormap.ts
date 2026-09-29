/** Sequential wind-speed colormap (calm blue -> teal -> yellow -> orange -> red). */
const STOPS: [number, number, number][] = [
  [0x2c, 0x7b, 0xb6],
  [0x00, 0xa6, 0xca],
  [0x00, 0xcc, 0xbc],
  [0x90, 0xeb, 0x9d],
  [0xff, 0xff, 0x8c],
  [0xf9, 0xd0, 0x57],
  [0xf2, 0x9e, 0x2e],
  [0xe7, 0x68, 0x18],
  [0xd7, 0x19, 0x1c],
];

/** Writes linear-ish RGB in [0,1] for t in [0,1] into out[o..o+2]. */
export function colormap(t: number, out: Float32Array | number[], o = 0): void {
  if (!(t > 0)) t = 0;
  else if (t > 1) t = 1;
  const f = t * (STOPS.length - 1);
  const i = Math.min(Math.floor(f), STOPS.length - 2);
  const a = f - i;
  const c0 = STOPS[i];
  const c1 = STOPS[i + 1];
  out[o] = (c0[0] + (c1[0] - c0[0]) * a) / 255;
  out[o + 1] = (c0[1] + (c1[1] - c0[1]) * a) / 255;
  out[o + 2] = (c0[2] + (c1[2] - c0[2]) * a) / 255;
}

export function colormapCss(t: number): string {
  const c = [0, 0, 0];
  colormap(t, c);
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

/** A "nice" upper bound for the legend, multiple of 5 m/s. */
export function niceMax(v: number): number {
  return Math.max(10, Math.ceil(v / 5) * 5);
}

/** Same as `colormap` but in linear RGB, as three.js expects for vertex colors. */
export function colormapLinear(t: number, out: Float32Array | number[], o = 0): void {
  colormap(t, out, o);
  for (let k = 0; k < 3; k++) out[o + k] = srgbToLinear(out[o + k]);
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
