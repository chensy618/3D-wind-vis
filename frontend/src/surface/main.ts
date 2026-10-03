import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import '../style.css';
import { colormapCss, colormapLinear, divergingCss, divergingLinear, niceMax } from '../colormap';
import { Domain } from '../geo';
import { CameraRig, createCamera } from '../scene/camera';
import { ParticleRenderer } from '../scene/particles';
import { buildTerrainMesh, terrainColor } from '../scene/terrain';
import { windFrom } from '../ui/inspector';
import { renderScale, ScaleSpec } from '../ui/legend';
import { timeWeights } from '../wind/interpolation';
import { loadIndex, loadTerrain, loadWind, loadWindManifest, Terrain, WindField } from '../wind/loader';
import { SurfaceParams, SurfaceWindModel } from './model';
import { ArrowField, ArrowPoint, GridKind, GridOverlay, TenMetreMarker } from './overlays';
import { Cell, nearest, SurfaceParticles, WindLayer } from './particles';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

type Overlay = 'w' | 'speed' | 'terrain';

// ---------------------------------------------------------------- state
/**
 * Terrain-response settings, fixed here rather than on the page:
 * layerDepth: stable lid 800 m above the highest summit (shallower = more air
 *   pushed around the mountains, deeper = more goes over them);
 * shelter: up to 60 % less wind right behind steep upwind terrain.
 */
const params: SurfaceParams = { layerDepth: 800, shelter: 0.6 };
const view = {
  overlay: 'w' as Overlay,
  /** add the terrain response to the model's wind */
  terrainAdjust: true,
  /** grid that sets the particles (one per cell) and the grid lines */
  grid: 'native' as GridKind,
  gridLines: false,
  speedFactor: 300,
  exaggeration: 2.5,
  arrows: false,
};

/** A wind model that provides a 10 m wind field. */
interface ModelEntry {
  id: string;
  name: string;
  /** spacing of its own lat/lon grid, degrees */
  deg: number;
}
/** The selected model's forecast and its clock. */
const source = { models: [] as ModelEntry[], model: null as ModelEntry | null, wind: null as WindField | null, t: 0, playing: false };

/** One model grid cell clipped to the domain, with its grid point (x, y) and mean terrain slope. */
interface NativeCell extends Cell {
  lat: number;
  lon: number;
  x: number;
  y: number;
  hx: number;
  hy: number;
}

interface Loaded {
  terrain: Terrain;
  domain: Domain;
  model: SurfaceWindModel;
  mesh: THREE.Mesh;
  north: CSS2DObject;
  /** one cell per terrain grid point */
  gridCells: Cell[];
  /** the model's grid cells, and the model cell of each terrain grid point */
  nativeCells: NativeCell[];
  cellOf: Int32Array;
}

/** The 10 m wind on show, on the terrain grid; blocky (one value per model cell) without terrain adjustment. */
interface Shown extends WindLayer {
  speed: Float32Array;
}

let data: Loaded | null = null;
let shown: Shown | null = null;
let rig: CameraRig | null = null;
let probe: { x: number; y: number } | null = null;
let dirty = true;
let wScale = 2;
let maxSpeed = 20;

// ---------------------------------------------------------------- renderer & scene
const canvas = $<HTMLCanvasElement>('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const labels = new CSS2DRenderer();
labels.domElement.className = 'labels';
$('#app').appendChild(labels.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1320);
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x1a2230, 1.4));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
sun.position.set(-40, 25, 30);
scene.add(sun);

const particles = new ParticleRenderer();
const ps = new SurfaceParticles();
const grid = new GridOverlay();
const arrows = new ArrowField();
const tenMarker = new TenMetreMarker();
scene.add(particles.group, grid.group, arrows.group, tenMarker.group);

// ---------------------------------------------------------------- helpers
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8];
const f1 = (x: number) => x.toFixed(1);

/** Smallest "nice" value at or above v, for the vertical-wind colour scale. */
function niceScale(v: number): number {
  for (const s of [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 15, 20]) if (s >= v) return s;
  return Math.ceil(v / 5) * 5;
}

function ctx() {
  const d = data!;
  const coarse = view.grid === 'native';
  return {
    wind: shown!,
    cells: coarse ? d.nativeCells : d.gridCells,
    terrain: d.terrain,
    domain: d.domain,
    speedFactor: view.speedFactor,
    exaggeration: view.exaggeration,
    // few particles get long trails; one per 200 m cell gets short ones
    trailLen: coarse ? 40 : 3,
  };
}

function resetParticles(): void {
  if (!data || !shown) return;
  particles.setHeadSize(view.grid === 'native' ? 9 : 2);
  ps.reset(ctx());
}

function buildGrid(): void {
  grid.group.visible = view.gridLines;
  if (data && source.model && view.gridLines) {
    grid.build(view.grid, source.model.deg, source.model.name, data.model, data.terrain, data.domain, view.exaggeration);
  }
}

/** Grid menu labels and the particle count line under it. */
function updateGridInfo(): void {
  if (!data || !source.model) return;
  const m = source.model;
  // full cell size: the largest extent in each direction (edge cells are clipped by the domain)
  const fmt = (km: number) => (km < 10 ? km.toFixed(1) : Math.round(km).toString());
  const w = Math.max(...data.nativeCells.map((c) => c.x1 - c.x0));
  const h = Math.max(...data.nativeCells.map((c) => c.y1 - c.y0));
  $('#grid-native').textContent = `${m.name} (${m.deg}°)`;
  $('#grid-terrain').textContent = `Terrain (${Math.round((data.model.dx * 1000) / 50) * 50} m)`;
  const n = view.grid === 'native' ? data.nativeCells.length : data.gridCells.length;
  const size = view.grid === 'native' ? `~${fmt(w)} × ${fmt(h)} km` : `${Math.round(data.model.dx * 1000)} m`;
  $('#grid-info').textContent = `${n.toLocaleString('en')} cells of ${size}: one particle each`;
}

function buildArrows(): void {
  arrows.group.visible = view.arrows;
  if (!data || !shown || !view.arrows) return;
  const { model, terrain, domain, nativeCells } = data;
  const s = shown;
  let points: ArrowPoint[];
  let spacing: number;
  if (view.grid === 'native') {
    // one arrow per model grid point
    points = nativeCells.map((c) => ({ x: c.x, y: c.y, u: nearest(s.u, s, c.x, c.y), v: nearest(s.v, s, c.x, c.y) }));
    spacing = 0.8 * Math.min(...nativeCells.map((c) => Math.min(c.x1 - c.x0, c.y1 - c.y0)));
  } else {
    const stride = Math.max(1, Math.round(1.6 / Math.min(model.dx, model.dy))); // ~1.6 km apart
    points = [];
    for (let j = stride >> 1; j < model.ny; j += stride) {
      for (let i = stride >> 1; i < model.nx; i += stride) {
        const k = j * model.nx + i;
        points.push({ x: i * model.dx, y: j * model.dy, u: s.u[k], v: s.v[k] });
      }
    }
    spacing = stride * Math.min(model.dx, model.dy);
  }
  arrows.build(points, spacing, terrain, domain, view.exaggeration, maxSpeed, view.overlay === 'speed');
}

function placeTenMarker(): void {
  if (data && probe) tenMarker.set(data.terrain, data.domain, probe.x, probe.y, view.exaggeration);
  else tenMarker.hide();
}

/** Mark the active button of a segmented control. */
function setSeg(root: HTMLElement, attr: string, value: string): void {
  root.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset[attr] === value));
}

/** The wind model's grid cells (centred on multiples of `deg`) clipped to the domain. */
function buildNativeCells(domain: Domain, model: SurfaceWindModel, deg: number): { cells: NativeCell[]; cellOf: Int32Array } {
  const half = deg / 2;
  const lats: number[] = [];
  const lons: number[] = [];
  for (let lat = Math.ceil((domain.latMin - half) / deg) * deg; lat - half < domain.latMax; lat += deg) lats.push(lat);
  for (let lon = Math.ceil((domain.lonMin - half) / deg) * deg; lon - half < domain.lonMax; lon += deg) lons.push(lon);
  const cells: NativeCell[] = [];
  for (const lat of lats) {
    for (const lon of lons) {
      const x0 = Math.max(0, domain.localX(lon - half));
      const x1 = Math.min(domain.width, domain.localX(lon + half));
      const y0 = Math.max(0, domain.localY(lat - half));
      const y1 = Math.min(domain.depth, domain.localY(lat + half));
      const x = Math.min(Math.max(domain.localX(lon), x0), x1);
      const y = Math.min(Math.max(domain.localY(lat), y0), y1);
      cells.push({ lat, lon, x0, x1, y0, y1, x, y, hx: 0, hy: 0 });
    }
  }
  // assign every terrain grid point to its cell, and average the terrain slope per cell
  const cellOf = new Int32Array(model.nx * model.ny);
  const count = new Float64Array(cells.length);
  for (let j = 0; j < model.ny; j++) {
    const ci = Math.min(lats.length - 1, Math.max(0, Math.round((domain.lat(j * model.dy) - lats[0]) / deg)));
    for (let i = 0; i < model.nx; i++) {
      const cj = Math.min(lons.length - 1, Math.max(0, Math.round((domain.lon(i * model.dx) - lons[0]) / deg)));
      const c = ci * lons.length + cj;
      const k = j * model.nx + i;
      cellOf[k] = c;
      cells[c].hx += model.hx[k];
      cells[c].hy += model.hy[k];
      count[c]++;
    }
  }
  cells.forEach((c, i) => {
    c.hx /= count[i] || 1;
    c.hy /= count[i] || 1;
  });
  return { cells, cellOf };
}

/** One cell per terrain grid point, centred on it. */
function buildGridCells(model: SurfaceWindModel, domain: Domain): Cell[] {
  const cells: Cell[] = [];
  for (let j = 0; j < model.ny; j++) {
    for (let i = 0; i < model.nx; i++) {
      const x = i * model.dx;
      const y = j * model.dy;
      cells.push({
        x0: Math.max(0, x - model.dx / 2),
        x1: Math.min(domain.width, x + model.dx / 2),
        y0: Math.max(0, y - model.dy / 2),
        y1: Math.min(domain.depth, y + model.dy / 2),
      });
    }
  }
  return cells;
}

// ---------------------------------------------------------------- controls
function bindRange(id: string, fmt: (v: number) => string, apply: (v: number) => void): void {
  const inp = $<HTMLInputElement>(`#${id}`);
  const out = $(`#${id}-out`);
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    out.textContent = fmt(v);
    apply(v);
  });
  out.textContent = fmt(parseFloat(inp.value));
}

bindRange('flow-speed', (v) => `×${v}`, (v) => (view.speedFactor = v));
bindRange('exaggeration', (v) => `×${v}`, (v) => {
  view.exaggeration = v;
  if (!data) return;
  data.mesh.scale.y = v;
  resetParticles();
  buildGrid();
  buildArrows();
  placeTenMarker();
});

$('#res-seg').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-model]');
  if (b) void setModel(b.dataset.model!);
});
$<HTMLInputElement>('#terrain-adjust').addEventListener('change', (e) => {
  view.terrainAdjust = (e.target as HTMLInputElement).checked;
  dirty = true;
});
$('#overlay-seg').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-ov]');
  if (!b) return;
  view.overlay = b.dataset.ov as Overlay;
  setSeg($('#overlay-seg'), 'ov', view.overlay);
  recolorTerrain();
  updateLegend();
  buildArrows();
});
$<HTMLSelectElement>('#grid').addEventListener('change', (e) => {
  view.grid = (e.target as HTMLSelectElement).value as GridKind;
  updateGridInfo();
  buildGrid();
  buildArrows();
  resetParticles();
});
$<HTMLInputElement>('#grid-lines').addEventListener('change', (e) => {
  view.gridLines = (e.target as HTMLInputElement).checked;
  buildGrid();
});
$<HTMLInputElement>('#show-arrows').addEventListener('change', (e) => {
  view.arrows = (e.target as HTMLInputElement).checked;
  buildArrows();
});
$('#reset-camera').addEventListener('click', () => rig?.reset());

// ---------------------------------------------------------------- FCN3 10 m wind
const timeInp = $<HTMLInputElement>('#data-time');
const playBtn = $<HTMLButtonElement>('#data-play');

function setTimeLabel(): void {
  const w = source.wind;
  if (!w) return;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})/.exec(w.manifest.init_time);
  const valid = m ? new Date(Date.parse(`${m[1]}T${m[2]}:00:00Z`) + source.t * 3600e3).toISOString().slice(5, 16).replace('T', ' ') : '';
  $('#data-time-out').textContent = `T+${source.t.toFixed(1).replace(/\.0$/, '')} h${valid ? ` · ${valid} UTC` : ''}`;
}

/** Load a model's 10 m wind. `rebuild` is false before the terrain has loaded. */
async function setModel(id: string, rebuild = true): Promise<void> {
  const entry = source.models.find((m) => m.id === id);
  if (!entry) return;
  setPlaying(false);
  setLoading(`Loading ${entry.name}…`);
  try {
    const w = await loadWind(id);
    source.model = entry;
    source.wind = w;
    setSeg($('#res-seg'), 'model', id);
    timeInp.min = String(w.times[0]);
    timeInp.max = String(w.times[w.times.length - 1]);
    source.t = Math.min(Math.max(source.t, w.times[0]), w.times[w.times.length - 1]);
    timeInp.value = String(source.t);
    setTimeLabel();
    if (rebuild && data) {
      const { cells, cellOf } = buildNativeCells(data.domain, data.model, entry.deg);
      data.nativeCells = cells;
      data.cellOf = cellOf;
      updateGridInfo();
      buildGrid();
      recompute();
      dirty = false;
      resetParticles();
    }
  } catch (err) {
    showError(`Could not load ${entry.name}: ${(err as Error).message}`);
  } finally {
    setLoading(null);
  }
}

function setPlaying(p: boolean): void {
  source.playing = p;
  playBtn.textContent = p ? '❚❚' : '▶';
  playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
}

timeInp.addEventListener('input', () => {
  setPlaying(false);
  source.t = parseFloat(timeInp.value);
  setTimeLabel();
  dirty = true;
});
playBtn.addEventListener('click', () => setPlaying(!source.playing));

/** Advance the forecast clock while playing (2 forecast hours per second, at most 10 updates/s). */
let playAcc = 0;
function advancePlayback(dt: number): void {
  const w = source.wind;
  if (!source.playing || !w) return;
  playAcc += dt;
  if (playAcc < 0.1) return;
  let t = source.t + playAcc * 2;
  playAcc = 0;
  if (t > w.times[w.times.length - 1]) t = w.times[0];
  source.t = t;
  timeInp.value = String(t);
  setTimeLabel();
  dirty = true;
}

/**
 * The 10 m wind to show at the current time. Without terrain adjustment every
 * terrain grid point takes the model's value for its cell, and w uses the cell's
 * mean slope. With it, the model wind is interpolated to the terrain grid and
 * goes through the terrain response.
 */
function computeShown(): Shown | null {
  const w = source.wind;
  if (!w || !w.u10 || !w.v10 || !data) return null;
  const tw = timeWeights(w.times, source.t, true);
  const { model, terrain, nativeCells, cellOf } = data;
  const n = model.nx * model.ny;
  const base = { nx: model.nx, ny: model.ny, dx: model.dx, dy: model.dy };

  if (!view.terrainAdjust) {
    const out: Shown = { ...base, u: new Float32Array(n), v: new Float32Array(n), w: new Float32Array(n), speed: new Float32Array(n) };
    const cu = nativeCells.map((c) => w.sampleSurface(w.u10!, tw, c.lat, c.lon));
    const cv = nativeCells.map((c) => w.sampleSurface(w.v10!, tw, c.lat, c.lon));
    for (let k = 0; k < n; k++) {
      const c = cellOf[k];
      out.u[k] = cu[c];
      out.v[k] = cv[c];
      out.w[k] = cu[c] * nativeCells[c].hx + cv[c] * nativeCells[c].hy;
      out.speed[k] = Math.hypot(cu[c], cv[c]);
    }
    return out;
  }

  // the model's 10 m wind interpolated to every terrain grid point, then the terrain response
  const { lat, lon } = terrain.manifest;
  const bu = new Float32Array(n);
  const bv = new Float32Array(n);
  for (let j = 0; j < model.ny; j++) {
    for (let i = 0; i < model.nx; i++) {
      bu[j * model.nx + i] = w.sampleSurface(w.u10, tw, lat[j], lon[i]);
      bv[j * model.nx + i] = w.sampleSurface(w.v10, tw, lat[j], lon[i]);
    }
  }
  model.update(params, { u: bu, v: bv });
  return { ...base, u: model.u, v: model.v, w: model.w, speed: model.speed };
}

// ---------------------------------------------------------------- derived views
function recolorTerrain(): void {
  if (!data || !shown) return;
  // the wind is on the terrain grid, so vertex k is grid point k
  const { mesh, terrain } = data;
  const s = shown;
  const attr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
  const col = attr.array as Float32Array;
  const base = [0, 0, 0];
  const ov = [0, 0, 0];
  for (let k = 0; k < terrain.elevation.length; k++) {
    const h = terrain.elevation[k];
    terrainColor(h, base);
    let a = 0; // overlay weight; vertical wind fades into the terrain colours near zero
    if (view.overlay === 'w' && h >= 0.5) {
      const t = s.w[k] / wScale;
      divergingLinear(t, ov);
      a = Math.min(1, Math.abs(t) * 1.6);
    } else if (view.overlay === 'speed') {
      colormapLinear(s.speed[k] / maxSpeed, ov);
      a = 1;
    }
    for (let q = 0; q < 3; q++) col[k * 3 + q] = base[q] + (ov[q] - base[q]) * a;
  }
  attr.needsUpdate = true;
}

function updateLegend(): void {
  const el = $('#legend');
  let spec: ScaleSpec | null = null;
  if (view.overlay === 'w') {
    spec = {
      title: 'Vertical wind at 10 m',
      units: 'm s⁻¹',
      min: -wScale,
      max: wScale,
      color: (f) => divergingCss(f * 2 - 1),
      ticks: [-wScale, 0, wScale],
      format: (v) => (v > 0 ? `+${v}` : `${v}`).replace('-', '−'),
      ends: ['sinking · lee slope', 'rising · windward slope'],
    };
  } else if (view.overlay === 'speed') {
    const step = maxSpeed <= 20 ? 5 : 10;
    const ticks: number[] = [];
    for (let v = 0; v <= maxSpeed + 1e-6; v += step) ticks.push(v);
    spec = { title: '10 m wind speed', units: 'm s⁻¹', min: 0, max: maxSpeed, color: colormapCss, ticks };
  }
  el.hidden = !spec;
  if (spec) renderScale(el, spec);
}

function updateProbe(): void {
  const el = $('#probe');
  if (!probe || !data || !shown) {
    el.hidden = true;
    return;
  }
  const { model, domain, terrain } = data;
  const s = shown;
  const { x, y } = probe;
  const u = nearest(s.u, s, x, y);
  const v = nearest(s.v, s, x, y);
  const w = nearest(s.w, s, x, y);
  const dir = windFrom(u, v);
  const elev = terrain.at(domain.lat(y), domain.lon(x));
  let kind = 'Flat or open water';
  let turnTxt = '—';
  if (view.terrainAdjust) {
    const shelter = nearest(model.shelterF, s, x, y);
    const ratio = nearest(model.ratio, s, x, y);
    let turn = dir - windFrom(nearest(model.bgU, s, x, y), nearest(model.bgV, s, x, y));
    turn = ((turn + 540) % 360) - 180;
    turnTxt = Math.abs(turn) < 1 ? 'none' : `${Math.abs(Math.round(turn))}° ${turn > 0 ? 'clockwise' : 'anticlockwise'}`;
    if (elev > 0.5) {
      if (w > 0.15 * wScale) kind = 'Windward slope: air is forced up';
      else if (w < -0.15 * wScale) kind = 'Lee slope: air sinks downhill';
      else if (shelter < 0.8) kind = 'Sheltered behind upwind terrain';
      else if (ratio > 1.1) kind = 'Exposed: the wind speeds up here';
      else kind = 'Little vertical motion here';
    } else if (shelter < 0.8) kind = 'Water in the lee of land: sheltered';
  } else {
    kind = `${source.model?.name ?? 'Model'} as it is: one wind per ${source.model?.deg}° grid cell`;
  }
  el.hidden = false;
  el.innerHTML = `
    <div class="insp-head"><h2>Point · ${Math.round(Math.max(elev, 0))} m</h2><button data-act="close" aria-label="Close">×</button></div>
    <div class="kind">${kind}</div>
    <dl class="kv">
      <dt>10 m wind</dt><dd>${f1(Math.hypot(u, v))} m/s from ${compass(dir)}</dd>
      <dt>Turned by terrain</dt><dd>${turnTxt}</dd>
      <dt>Vertical wind</dt><dd style="color:${divergingCss(w / wScale)}">${w >= 0 ? '+' : '−'}${f1(Math.abs(w))} m/s</dd>
    </dl>`;
}
$('#probe').addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('[data-act="close"]')) return;
  probe = null;
  updateProbe();
  placeTenMarker();
});

function recompute(): void {
  if (!data) return;
  shown = computeShown();
  if (!shown) return;
  // colour scales come from the terrain-adjusted field, so the raw model shares them
  // and its weak vertical wind is not stretched to look strong
  if (view.terrainAdjust) {
    const { model } = data;
    const absW: number[] = [];
    let top = 0;
    for (let k = 0; k < shown.w.length; k++) {
      if (model.h[k] > 1) absW.push(Math.abs(shown.w[k]));
      if (shown.speed[k] > top) top = shown.speed[k];
    }
    absW.sort((a, b) => a - b);
    wScale = niceScale(absW.length ? absW[Math.floor(0.95 * (absW.length - 1))] : 1);
    maxSpeed = niceMax(top);
  }
  recolorTerrain();
  updateLegend();
  updateProbe();
  buildArrows();
}

// ---------------------------------------------------------------- loading
function setLoading(msg: string | null): void {
  const el = $('#loading');
  el.hidden = msg == null;
  if (msg) el.querySelector('span')!.textContent = msg;
}

function showError(msg: string): void {
  const el = $('#error');
  el.hidden = false;
  el.textContent = msg;
}

async function load(terrainId: string): Promise<void> {
  setLoading('Loading terrain…');
  $('#error').hidden = true;
  try {
    const terrain = await loadTerrain(terrainId);
    const domain = Domain.fromGrid(terrain.grid);
    const model = new SurfaceWindModel(terrain, domain);

    if (data) {
      scene.remove(data.mesh);
      data.mesh.geometry.dispose();
      (data.mesh.material as THREE.Material).dispose();
      data.north.element.remove();
      scene.remove(data.north);
    }
    const mesh = buildTerrainMesh(terrain, domain);
    mesh.scale.y = view.exaggeration;
    // push the terrain back in depth so lines 10 m above it are not hidden by it
    Object.assign(mesh.material as THREE.MeshStandardMaterial, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
    scene.add(mesh);
    const north = new CSS2DObject(Object.assign(document.createElement('div'), { className: 'label3d north', textContent: 'N ↑' }));
    north.position.set(0, 0, -domain.depth / 2 - 2);
    scene.add(north);

    const { cells: nativeCells, cellOf } = buildNativeCells(domain, model, source.model!.deg);
    data = { terrain, domain, model, mesh, north, gridCells: buildGridCells(model, domain), nativeCells, cellOf };
    updateGridInfo();
    if (!rig) {
      rig = createCamera(canvas, domain);
      resize();
    }
    probe = null;
    placeTenMarker();
    buildGrid();
    recompute();
    dirty = false;
    resetParticles();
    setLoading(null);
  } catch (err) {
    console.error(err);
    setLoading(null);
    showError(`Could not load data: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- picking
const raycaster = new THREE.Raycaster();
let downAt: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || !data || !rig) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 4) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, rig.camera);
  const hit = raycaster.intersectObject(data.mesh, false)[0];
  if (!hit) return;
  const p = data.domain.fromScene(hit.point);
  if (!data.domain.contains(p.x, p.y)) return;
  probe = p;
  updateProbe();
  placeTenMarker();
});

// ---------------------------------------------------------------- loop
function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  labels.setSize(w, h);
  rig?.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

const white = (_i: number, out: Float32Array) => {
  out[0] = out[1] = out[2] = 0.92;
};

const clock = new THREE.Clock();
function frame(): void {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (data && rig) {
    advancePlayback(dt);
    if (dirty) {
      recompute();
      dirty = false;
    }
    if (shown) {
      ps.step(dt, ctx());
      particles.update(ps, maxSpeed, white);
    }
    rig.controls.update();
    renderer.render(scene, rig.camera);
    labels.render(scene, rig.camera);
  }
}

// ---------------------------------------------------------------- start
async function start(): Promise<void> {
  try {
    const index = await loadIndex();
    // every dataset with a 10 m wind field is a model to choose from
    const manifests = await Promise.all(index.datasets.map((d) => loadWindManifest(d.id).catch(() => null)));
    source.models = index.datasets.flatMap((d, i) => {
      const m = manifests[i];
      return m?.surface?.u10 ? [{ id: d.id, name: m.model, deg: m.native_deg ?? 0.25 }] : [];
    });
    if (!source.models.length) throw new Error('no dataset with a 10 m wind field; run FCN3 and convert_fcn3.py (see README)');
    $('#res-seg').innerHTML = source.models
      .map((m) => `<button data-model="${m.id}" title="${m.name}, ${m.deg}° grid">${m.name} ${m.deg}°</button>`)
      .join('');
    await setModel(source.models[0].id, false);
    const terrainSel = $<HTMLSelectElement>('#terrain');
    terrainSel.innerHTML = index.terrains.map((d) => `<option value="${d.id}">${d.label}</option>`).join('');
    const q = new URLSearchParams(location.search);
    terrainSel.value = index.terrains.find((d) => d.id === q.get('terrain'))?.id ?? index.terrains[0].id;
    terrainSel.addEventListener('change', () => {
      history.replaceState(null, '', `?terrain=${terrainSel.value}`);
      void load(terrainSel.value);
    });
    await load(terrainSel.value);
  } catch (err) {
    setLoading(null);
    showError(`Could not start: ${(err as Error).message}`);
  }
  frame();
}

void start();
