import { colormapCss } from '../colormap';

export interface ProbeRow {
  level: number; // in ProbeInfo.levelUnit
  height: number; // m
  u: number;
  v: number;
  /** vertical wind, positive up, when the dataset has it */
  w?: number;
  speed: number;
  belowGround: boolean;
}

export interface ProbeInfo {
  lat: number;
  lon: number;
  terrain: number;
  model: string;
  lead: number;
  /** a steady CFD solution rather than a forecast: no lead time */
  steady: boolean;
  levelUnit: string; // 'hPa' or 'm AGL'
  selectedLevels: number[]; // indices into rows; empty in all-levels mode
  rows: ProbeRow[];
  /** 10 m above ground, when the dataset has a surface wind */
  surface?: ProbeRow | null;
  maxSpeed: number;
}

/** Meteorological direction the wind blows FROM, degrees. */
export function windFrom(u: number, v: number): number {
  return (Math.atan2(-u, -v) * (180 / Math.PI) + 360) % 360;
}

/**
 * Quadrant name and the angle into it, clockwise from its first edge (N, E, S or W):
 * e.g. 242° -> "SW 62°"; the four cardinal directions are just "N", "E", "S", "W".
 */
export function quadrant(deg: number): string {
  const d = Math.round(((deg % 360) + 360) % 360) % 360;
  if (d % 90 === 0) return ['N', 'E', 'S', 'W'][d / 90];
  return `${['NE', 'SE', 'SW', 'NW'][Math.floor(d / 90)]} ${d % 90}°`;
}

/** "SW 62° ↗": quadrant direction the wind comes from, and a small arrow pointing where it blows (north up). */
export function windFromLabel(u: number, v: number): string {
  const from = windFrom(u, v);
  return (
    `${quadrant(from)} <svg class="dir-arrow" viewBox="0 0 16 26" style="transform:rotate(${from + 180}deg)" aria-hidden="true">` +
    '<path class="shaft" d="M6.4 7.2H9.6L8.55 24.6Q8 25.2 7.45 24.6Z"/><path class="head" d="M8 1.2 13 8.4 8 6.6 3 8.4Z"/></svg>'
  );
}

const f1 = (x: number) => x.toFixed(1);
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`;

/** Point-inspection panel with a vertical profile of all levels. */
export class Inspector {
  constructor(
    private root: HTMLElement,
    onClose: () => void,
  ) {
    root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act="close"]')) onClose();
    });
  }

  hide(): void {
    this.root.hidden = true;
  }

  show(p: ProbeInfo): void {
    this.root.hidden = false;
    // details for the chosen level when there is exactly one; the profile highlights all chosen
    const sel = p.selectedLevels.length === 1 ? p.rows[p.selectedLevels[0]] : null;
    const head = sel
      ? `<dl class="kv">
          <dt>Height</dt><dd>${Math.round(sel.height).toLocaleString('en')} m</dd>
          <dt>U</dt><dd>${f1(sel.u)} m/s</dd>
          <dt>V</dt><dd>${f1(sel.v)} m/s</dd>
          ${sel.w !== undefined ? `<dt>W</dt><dd>${sel.w.toFixed(2)} m/s ${sel.w >= 0 ? '(rising)' : '(sinking)'}</dd>` : ''}
          <dt>Wind speed</dt><dd><b>${f1(sel.speed)} m/s</b></dd>
          <dt>Direction</dt><dd>${Math.round(windFrom(sel.u, sel.v))}° (from)</dd>
        </dl>`
      : '';
    const hasW = p.rows.some((r) => r.w !== undefined);
    // W (signed, 1 decimal) for datasets with vertical wind; inside the terrain there is none
    const wCell = (r: ProbeRow) => (hasW ? `<td>${r.w === undefined || r.belowGround ? '—' : signed(r.w)}</td>` : '');
    const row = (r: ProbeRow, label: string, cls: string) => `
        <tr class="${cls}">
          <td>${label}</td>
          <td>${Math.round(r.height)}</td>
          <td><span class="sw" style="background:${colormapCss(r.speed / p.maxSpeed)}"></span>${f1(r.speed)}</td>
          ${wCell(r)}
          <td><span class="arrow" style="transform:rotate(${windFrom(r.u, r.v) + 180}deg)">↑</span>${Math.round(windFrom(r.u, r.v))}°</td>
        </tr>`;
    const rows = [...p.rows]
      .map((r, i) => ({ r, i }))
      .sort((a, b) => b.r.height - a.r.height)
      .map(({ r, i }) => row(r, String(r.level), `${p.selectedLevels.includes(i) ? 'sel' : ''} ${r.belowGround ? 'below' : ''}`))
      .join('') + (p.surface ? row(p.surface, '10 m AGL', 'surf') : '');
    this.root.innerHTML = `
      <div class="insp-head">
        <h2>Point inspection</h2>
        <button data-act="close" aria-label="Close">×</button>
      </div>
      <dl class="kv">
        <dt>Latitude</dt><dd>${p.lat.toFixed(3)}° N</dd>
        <dt>Longitude</dt><dd>${p.lon.toFixed(3)}° E</dd>
        <dt>Terrain</dt><dd>${Math.round(p.terrain)} m</dd>
        <dt>Model</dt><dd>${p.model}</dd>
        ${p.steady ? '' : `<dt>Lead time</dt><dd>+${f1(p.lead).replace(/\.0$/, '')} h</dd>`}
      </dl>
      ${sel ? `<h3>${sel.level} ${p.levelUnit}</h3>${head}` : ''}
      <h3>Vertical profile</h3>
      <table class="profile">
        <thead><tr><th>${p.levelUnit}</th><th>z (m)</th><th>m/s</th>${hasW ? '<th>w</th>' : ''}<th>dir</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">Grey rows: level lies below the terrain here.</p>`;
  }
}
