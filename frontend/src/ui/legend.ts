import { colormapCss } from '../colormap';

/** Horizontal wind-speed legend in m s⁻¹. */
export function renderLegend(root: HTMLElement, maxSpeed: number): void {
  const stops = Array.from({ length: 11 }, (_, i) => `${colormapCss(i / 10)} ${i * 10}%`).join(', ');
  const step = maxSpeed <= 20 ? 5 : maxSpeed <= 40 ? 10 : 20;
  const ticks: string[] = [];
  for (let v = 0; v <= maxSpeed + 1e-6; v += step) {
    ticks.push(`<span style="left:${(v / maxSpeed) * 100}%">${v}</span>`);
  }
  root.innerHTML = `
    <div class="lg-title">Wind speed <span>m s⁻¹</span></div>
    <div class="lg-bar" style="background:linear-gradient(90deg, ${stops})"></div>
    <div class="lg-ticks">${ticks.join('')}</div>`;
}
