import { colormapCss } from '../colormap';

export interface ScaleSpec {
  title: string;
  units: string;
  min: number;
  max: number;
  /** CSS colour for a fraction f in [0, 1] of the range. */
  color: (f: number) => string;
  ticks: number[];
  format?: (v: number) => string;
  /** Words under the two ends of the bar, e.g. ['lee', 'windward']. */
  ends?: [string, string];
}

/** Horizontal colour bar with ticks. */
export function renderScale(root: HTMLElement, s: ScaleSpec): void {
  const fmt = s.format ?? String;
  const span = s.max - s.min || 1;
  const stops = Array.from({ length: 11 }, (_, i) => `${s.color(i / 10)} ${i * 10}%`).join(', ');
  const ticks = s.ticks.map((v) => `<span style="left:${((v - s.min) / span) * 100}%">${fmt(v)}</span>`);
  const ends = s.ends ? `<div class="lg-ends"><span>${s.ends[0]}</span><span>${s.ends[1]}</span></div>` : '';
  root.innerHTML = `
    <div class="lg-title">${s.title} <span>${s.units}</span></div>
    <div class="lg-bar" style="background:linear-gradient(90deg, ${stops})"></div>
    <div class="lg-ticks">${ticks.join('')}</div>${ends}`;
}

/** Horizontal wind-speed legend in m s⁻¹. */
export function renderLegend(root: HTMLElement, maxSpeed: number): void {
  const step = maxSpeed <= 20 ? 5 : maxSpeed <= 40 ? 10 : 20;
  const ticks: number[] = [];
  for (let v = 0; v <= maxSpeed + 1e-6; v += step) ticks.push(v);
  renderScale(root, { title: 'Wind speed', units: 'm s⁻¹', min: 0, max: maxSpeed, color: colormapCss, ticks });
}
