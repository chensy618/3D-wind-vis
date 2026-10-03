import { colormapCss } from '../colormap';

export interface ProbeRow {
  level: number; // hPa
  height: number; // m
  u: number;
  v: number;
  speed: number;
  belowGround: boolean;
}

export interface ProbeInfo {
  lat: number;
  lon: number;
  terrain: number;
  model: string;
  lead: number;
  selectedLevels: number[]; // indices into rows; empty in all-levels mode
  rows: ProbeRow[];
  maxSpeed: number;
}

/** Meteorological direction the wind blows FROM, degrees. */
export function windFrom(u: number, v: number): number {
  return (Math.atan2(-u, -v) * (180 / Math.PI) + 360) % 360;
}

const f1 = (x: number) => x.toFixed(1);

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
          <dt>Wind speed</dt><dd><b>${f1(sel.speed)} m/s</b></dd>
          <dt>Direction</dt><dd>${Math.round(windFrom(sel.u, sel.v))}° (from)</dd>
        </dl>`
      : '';
    const rows = [...p.rows]
      .map((r, i) => ({ r, i }))
      .sort((a, b) => a.r.level - b.r.level)
      .map(
        ({ r, i }) => `
        <tr class="${p.selectedLevels.includes(i) ? 'sel' : ''} ${r.belowGround ? 'below' : ''}">
          <td>${r.level}</td>
          <td>${Math.round(r.height)}</td>
          <td><span class="sw" style="background:${colormapCss(r.speed / p.maxSpeed)}"></span>${f1(r.speed)}</td>
          <td><span class="arrow" style="transform:rotate(${windFrom(r.u, r.v) + 180}deg)">↑</span>${Math.round(windFrom(r.u, r.v))}°</td>
        </tr>`,
      )
      .join('');
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
        <dt>Lead time</dt><dd>+${f1(p.lead).replace(/\.0$/, '')} h</dd>
      </dl>
      ${sel ? `<h3>${sel.level} hPa</h3>${head}` : ''}
      <h3>Vertical profile</h3>
      <table class="profile">
        <thead><tr><th>hPa</th><th>z (m)</th><th>m/s</th><th>dir</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="note">Grey rows: level lies below the terrain here.</p>`;
  }
}
