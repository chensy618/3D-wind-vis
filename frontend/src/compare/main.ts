import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import '../style.css';
import { niceMax } from '../colormap';
import { Domain } from '../geo';
import { Annotations, ProbeMarker } from '../scene/annotations';
import { CameraRig, createCamera } from '../scene/camera';
import { Highlight } from '../scene/highlight';
import { LevelSurface } from '../scene/levels';
import { ParticleRenderer } from '../scene/particles';
import { buildDomainFrame, buildTerrainMesh } from '../scene/terrain';
import { windFrom } from '../ui/inspector';
import { renderLegend } from '../ui/legend';
import { Timeline } from '../ui/timeline';
import { AdvectionContext, ParticleSystem } from '../wind/advection';
import { timeWeights, TimeWeights } from '../wind/interpolation';
import { loadIndex, loadTerrain, loadWind, loadWindManifest, Terrain, WindField } from '../wind/loader';

/**
 * Forecast vs WindINR: two linked 3D views over the CFD box. Left, a forecast model's raw output
 * (`<driver>-cfdbox`: each point takes its nearest native grid point, so no terrain effects);
 * right, WindINR driven by the same forecast (`windinr-<driver>`). Time, level and camera are
 * shared, and both use one wind-speed colour scale.
 */

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

/**
 * Particles per view. The raw forecast gets far fewer: one or two native grid points cover the
 * box, so it is drawn sparse next to the dense WindINR field. Its particles also live longer,
 * so they visibly glide across the level (horizontal wind only) instead of popping in and out.
 */
const N_PARTICLES_RAW = 300;
const N_PARTICLES_INR = 4000;
const LIFE_RAW = { min: 8, span: 6 }; // seconds; WindINR keeps the default 2-6 s
/** WindINR particles rise and sink with this many times w (display only; values shown are true w). */
const W_BOOST = 3;
/**
 * Slow (blue) particles near the summits fade out gently here; judged by horizontal motion,
 * since the boosted w would otherwise keep them counted as moving. The main viewer keeps the
 * ParticleSystem defaults.
 */
const STILL_FADE = { stillTime: 0.05, fadeOut: 0.25, horizontal: true };
/** Trail length in frames here (the main viewer keeps the default 35). */
const TRAIL_LEN = 45;

const state = {
  t: 0,
  playing: false,
  rate: 1, // forecast hours per second
  level: 1, // index into the shared levels (default 150 m)
  /** all levels stacked instead of the one chosen level */
  all: false,
  showSurface: true,
  speedFactor: 300,
  exaggeration: 4,
};

/** A forecast with both datasets: its raw output on the CFD box and WindINR driven by it. */
interface Pair {
  driver: string;
  raw: string;
  inr: string;
  label: string;
}

/** One of the two views: its own renderer, scene, camera and particles. */
class Pane {
  readonly renderer: THREE.WebGLRenderer;
  readonly labels = new CSS2DRenderer();
  readonly scene = new THREE.Scene();
  readonly ps = new ParticleSystem();
  readonly particles = new ParticleRenderer();
  readonly marker = new ProbeMarker();
  readonly highlight = new Highlight();
  private readonly popup: CSS2DObject;
  readonly canvas: HTMLCanvasElement;
  rig: CameraRig | null = null;
  wind: WindField | null = null;
  private content: THREE.Group | null = null;
  private terrainMesh: THREE.Mesh | null = null;
  private surfaces: LevelSurface[] = [];
  private annotations: Annotations | null = null;

  constructor(
    readonly root: HTMLElement,
    private readonly nParticles: number,
    life?: { min: number; span: number },
  ) {
    if (life) this.ps.life = life;
    this.ps.stillFade = STILL_FADE;
    this.ps.trailLen = TRAIL_LEN;
    this.canvas = root.querySelector('canvas')!;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.labels.domElement.className = 'labels';
    root.appendChild(this.labels.domElement);
    this.scene.background = new THREE.Color(0x0b1320);
    this.scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x1a2230, 1.4));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
    sun.position.set(-40, 25, 30);
    const pop = document.createElement('div');
    pop.innerHTML = '<div class="cmp-pop"></div>';
    this.popup = new CSS2DObject(pop);
    this.popup.center.set(0.5, 1);
    this.popup.visible = false;
    this.scene.add(sun, this.particles.group, this.marker.group, this.highlight.group, this.popup);
  }

  showPopup(x: number, y: number, z: number, html: string): void {
    this.popup.position.set(x, y, z);
    this.popup.element.firstElementChild!.innerHTML = html;
    this.popup.visible = true;
  }

  hideProbe(): void {
    this.popup.visible = false;
    this.marker.hide();
    this.highlight.hide();
  }

  /** Terrain or shown level surface under a click (NDC), as a local point, or null. */
  pick(ndc: THREE.Vector2, domain: Domain): { x: number; y: number } | null {
    if (!this.rig || !this.terrainMesh) return null;
    raycaster.setFromCamera(ndc, this.rig.camera);
    const targets: THREE.Object3D[] = [...this.surfaces.map((s) => s.mesh).filter((m) => m.visible), this.terrainMesh];
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const p = domain.fromScene(hit.point);
    return domain.contains(p.x, p.y) ? p : null;
  }

  /** Name of the dataset on show, with its grid resolution on a second line when given. */
  setTag(name: string, resolution = ''): void {
    const tag = this.root.querySelector('.cmp-tag')!;
    tag.textContent = name;
    if (!resolution) return;
    const res = document.createElement('span');
    res.className = 'cmp-res';
    res.textContent = resolution;
    tag.appendChild(res);
  }

  setData(wind: WindField, terrain: Terrain, domain: Domain): void {
    if (this.content) {
      this.annotations?.dispose();
      this.content.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      this.scene.remove(this.content);
    }
    this.wind = wind;
    this.content = new THREE.Group();
    this.terrainMesh = buildTerrainMesh(terrain, domain);
    this.surfaces = wind.levels.map(() => new LevelSurface(wind, domain));
    this.annotations = new Annotations(domain);
    this.content.add(this.terrainMesh, ...this.surfaces.map((s) => s.mesh), this.annotations.group);
    this.scene.add(this.content);
    if (!this.rig) this.rig = createCamera(this.canvas, domain);
    else this.rig.setDomain(domain);
  }

  /** Rebuild what depends on the vertical exaggeration. */
  applyExaggeration(domain: Domain): void {
    if (!this.wind || !this.content || !this.terrainMesh || !this.annotations) return;
    const w = this.wind;
    this.terrainMesh.scale.y = state.exaggeration;
    const top = w.manifest.variables.height.max + 500;
    this.content.getObjectByName('domain-frame')?.removeFromParent();
    this.content.add(buildDomainFrame(domain, (top / 1000) * state.exaggeration));
    const heights = w.levels.map((_, i) => w.meanHeight(i, 0));
    this.annotations.build(w.levels, heights, state.exaggeration, top, w.manifest.level_units);
    this.annotations.highlight(w.levels.map((_, i) => isShown(i)));
  }

  ctx(terrain: Terrain, domain: Domain, tw: TimeWeights): AdvectionContext {
    return {
      wind: this.wind!,
      terrain,
      domain,
      tw,
      speedFactor: state.speedFactor,
      exaggeration: state.exaggeration,
      vertical: true, // WindINR moves with its w; the raw forecast has none
      wBoost: W_BOOST,
    };
  }

  resetParticles(terrain: Terrain, domain: Domain, tw: TimeWeights): void {
    if (!this.wind) return;
    const levels = this.wind.levels.map((_, i) => i).filter(isShown);
    this.ps.reset(this.nParticles, levels, this.ctx(terrain, domain, tw));
    this.annotations?.highlight(this.wind.levels.map((_, i) => isShown(i)));
  }

  /**
   * All-levels mode: the stacked surfaces show from the side and fade out as the view tilts up
   * (see sideViewFade); `f` scales their opacity, 0 hides them.
   */
  fadeSurfaces(f: number): void {
    if (!state.all) {
      // one chosen level: always shown (at full material opacity)
      for (const s of this.surfaces) (s.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
      return;
    }
    this.surfaces.forEach((s, i) => {
      const on = state.showSurface && isShown(i) && f > 0.01;
      s.mesh.visible = on;
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = f;
    });
  }

  updateSurfaces(terrain: Terrain, tw: TimeWeights, maxSpeed: number): void {
    this.surfaces.forEach((s, i) => {
      // a surface per level on show; fainter when all levels are stacked
      const show = state.showSurface && isShown(i);
      s.mesh.visible = show;
      if (show) s.update(i, tw, terrain, state.exaggeration, maxSpeed, state.all ? 0.18 : 0.35);
    });
  }

  resize(): void {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.rig?.resize(w, h);
  }

  render(): void {
    if (!this.rig) return;
    this.renderer.render(this.scene, this.rig.camera);
    this.labels.render(this.scene, this.rig.camera);
  }
}

/** A model grid's resolution from the manifest's native_deg: degrees and its east-west × north-south size in km here. */
function resolution(wind: WindField, domain: Domain): string {
  const deg = wind.manifest.native_deg;
  if (!deg) return '';
  const ns = deg * 111.32; // km
  const lat = (domain.latMin + domain.latMax) / 2;
  const ew = ns * Math.cos((lat * Math.PI) / 180); // meridians converge towards the pole
  const km = (x: number) => (x < 10 ? x.toFixed(1) : Math.round(x).toString());
  return `${deg}° ≈ ${km(ew)} × ${km(ns)} km (E–W = ${km(ns)} km × cos ${lat.toFixed(1)}°)`;
}

/** Is level i on show (the chosen one, or every level in all-levels mode)? */
function isShown(i: number): boolean {
  return state.all || i === state.level;
}

const raycaster = new THREE.Raycaster();
const paneRaw = new Pane($('#pane-raw'), N_PARTICLES_RAW, LIFE_RAW);
const paneInr = new Pane($('#pane-inr'), N_PARTICLES_INR);
const panes = [paneRaw, paneInr];

let pairs: Pair[] = [];
let shared: { terrain: Terrain; terrainId: string; domain: Domain; maxSpeed: number } | null = null;
let surfaceDirty = true;

// ---------------------------------------------------------------- linked cameras
/** The pane the user last touched drives both cameras. */
let master: Pane = paneRaw;
for (const p of panes) {
  for (const ev of ['pointerdown', 'wheel', 'touchstart'] as const) {
    p.canvas.addEventListener(ev, () => (master = p), { passive: true });
  }
}

/** All-levels surfaces: fully shown below this camera elevation (deg), gone above SIDE_VIEW_HIDE. */
const SIDE_VIEW_SHOW = 8;
const SIDE_VIEW_HIDE = 16;

/** 1 for a side view, 0 for the default oblique view (~22°) or looking down, smooth in between. */
function sideViewFade(): number {
  const r = master.rig;
  if (!r) return 0;
  const d = r.camera.position.clone().sub(r.controls.target);
  const elev = (Math.asin(Math.min(1, Math.max(-1, d.y / (d.length() || 1)))) * 180) / Math.PI;
  const t = Math.min(1, Math.max(0, (SIDE_VIEW_HIDE - elev) / (SIDE_VIEW_HIDE - SIDE_VIEW_SHOW)));
  return t * t * (3 - 2 * t);
}

function syncCameras(): void {
  const m = master.rig;
  if (!m) return;
  m.controls.update();
  for (const p of panes) {
    if (p === master || !p.rig) continue;
    p.rig.camera.position.copy(m.camera.position);
    p.rig.camera.quaternion.copy(m.camera.quaternion);
    p.rig.controls.target.copy(m.controls.target);
  }
}

// ---------------------------------------------------------------- controls
const timeline = new Timeline($('#timeline'), {
  onTime: (t) => setTime(t),
  onPlay: (p) => (state.playing = p),
  onRate: (r) => (state.rate = r),
});

function setTime(t: number): void {
  state.t = t;
  timeline.setTime(t);
  surfaceDirty = true;
  probeDirty = true;
}

function currentTw(): TimeWeights {
  return timeWeights(paneInr.wind!.times, state.t, true);
}

function resetParticles(): void {
  if (!shared || !paneInr.wind) return;
  const tw = currentTw();
  for (const p of panes) p.resetParticles(shared.terrain, shared.domain, tw);
}

const levelsEl = $('#levels');
function renderLevels(levels: number[], unit: string): void {
  const btn = (i: string, on: boolean, text: string, title: string) =>
    `<button data-i="${i}" class="${on ? 'on' : ''}" role="radio" aria-checked="${on}" title="${title}">${text}</button>`;
  levelsEl.innerHTML =
    levels.map((lv, i) => btn(String(i), !state.all && i === state.level, `${lv} ${unit.split(' ')[0]}`, `${lv} ${unit}`)).join('') +
    btn('all', state.all, 'All levels', 'All levels stacked');
}
levelsEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-i]');
  if (!b) return;
  state.all = b.dataset.i === 'all';
  if (!state.all) state.level = Number(b.dataset.i);
  levelsEl.querySelectorAll('button').forEach((x) => {
    const on = x === b;
    x.classList.toggle('on', on);
    x.setAttribute('aria-checked', String(on));
  });
  resetParticles();
  surfaceDirty = true;
  probeDirty = true;
});

const flowInp = $<HTMLInputElement>('#flow-speed');
const showFlow = () => ($('#flow-speed-out').textContent = `×${state.speedFactor}`);
flowInp.addEventListener('input', () => {
  state.speedFactor = Number(flowInp.value);
  showFlow();
});
$<HTMLInputElement>('#show-surface').addEventListener('change', (e) => {
  state.showSurface = (e.target as HTMLInputElement).checked;
  surfaceDirty = true;
});
$('#reset-camera').addEventListener('click', () => panes.forEach((p) => p.rig?.reset()));

const modelSel = $<HTMLSelectElement>('#model');
modelSel.addEventListener('change', () => {
  history.replaceState(null, '', `?model=${modelSel.value}`);
  void load(modelSel.value);
});

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

async function load(driver: string): Promise<void> {
  const pair = pairs.find((p) => p.driver === driver);
  if (!pair) return;
  setLoading(`Loading ${pair.label}…`);
  $('#error').hidden = true;
  try {
    const [raw, inr] = await Promise.all([loadWind(pair.raw), loadWind(pair.inr)]);
    const terrainId = inr.manifest.terrain ?? raw.manifest.terrain ?? 'terrain';
    if (!shared || shared.terrainId !== terrainId) {
      const terrain = await loadTerrain(terrainId);
      shared = { terrain, terrainId, domain: Domain.fromGrid(terrain.grid), maxSpeed: 0 };
      state.speedFactor = shared.domain.viewDefaults.flowSpeed;
      state.exaggeration = shared.domain.viewDefaults.exaggeration;
      flowInp.value = String(state.speedFactor);
      showFlow();
    }
    // one colour scale for both, so equal colours mean equal speeds
    shared.maxSpeed = niceMax(Math.max(raw.manifest.variables.wind_speed.max, inr.manifest.variables.wind_speed.max));
    const { terrain, domain } = shared;
    paneRaw.setData(raw, terrain, domain);
    paneInr.setData(inr, terrain, domain);
    paneRaw.setTag(`${pair.label} raw output`, resolution(raw, domain));
    const tr = inr.manifest.training;
    paneInr.setTag(
      inr.manifest.model,
      tr ? `Terrain ${tr.terrain_m} m · CFD ${tr.cfd_m} m` : '',
    );
    for (const p of panes) {
      p.resize();
      p.applyExaggeration(domain);
    }
    const m = inr.manifest;
    state.level = Math.min(state.level, m.levels.length - 1);
    renderLevels(m.levels, m.level_units ?? 'hPa');
    timeline.setData(m.times, m.init_time);
    setTime(Math.min(Math.max(state.t, m.times[0]), m.times[m.times.length - 1]));
    renderLegend($('#legend'), shared.maxSpeed);
    resetParticles();
    surfaceDirty = true;
    probeDirty = true;
    setLoading(null);
  } catch (err) {
    console.error(err);
    setLoading(null);
    showError(`Could not load ${pair.label}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- point inspection
/** The clicked point (local km), marked in both views, each with a small popup of its own wind. */
let probe: { x: number; y: number } | null = null;
let probeNew = false;
let probeDirty = false;

for (const p of panes) {
  let downAt: { x: number; y: number } | null = null;
  p.canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
  p.canvas.addEventListener('pointerup', (e) => {
    if (!downAt || !shared) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 4) return; // a drag, not a click
    const r = p.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    probe = p.pick(ndc, shared.domain); // a click beside the terrain closes the popups
    probeNew = probe != null;
    probeDirty = true;
  });
}

/**
 * Popup text: wind (speed, from-direction, and w where the data has it) at the chosen level,
 * or one line per level above the ground, top first, in all-levels mode.
 */
function popupHtml(wind: WindField, tw: TimeWeights, lat: number, lon: number, ground: number): string {
  const unit = wind.manifest.level_units ?? 'hPa';
  const line = (k: number, withW: boolean) => {
    const head = `<span class="k">${wind.levels[k]} ${unit}</span>`;
    if (wind.sample(wind.height, tw, k, lat, lon) <= ground) return `${head} · below terrain`;
    const u = wind.sample(wind.u, tw, k, lat, lon);
    const v = wind.sample(wind.v, tw, k, lat, lon);
    const w = withW && wind.w ? wind.sample(wind.w, tw, k, lat, lon) : null;
    const ws = w == null ? '' : ` · <span class="k">w</span> ${w >= 0 ? '+' : '−'}${Math.abs(w).toFixed(1)}`;
    return `${head} · <b>${Math.hypot(u, v).toFixed(1)} m/s</b> from ${Math.round(windFrom(u, v))}°${ws}`;
  };
  if (!state.all) return line(state.level, true);
  return wind.levels
    .map((_, k) => k)
    .filter((k) => wind.sample(wind.height, tw, k, lat, lon) > ground)
    .sort((a, b) => wind.sample(wind.height, tw, b, lat, lon) - wind.sample(wind.height, tw, a, lat, lon))
    .map((k) => line(k, true))
    .join('<br>') || `<span class="k">all levels</span> · below terrain`;
}

/** Place the marker and popup in both views at the probe point. */
function updateProbe(): void {
  if (!probe || !shared || !paneRaw.wind || !paneInr.wind) {
    for (const p of panes) p.hideProbe();
    return;
  }
  const { terrain, domain } = shared;
  const inr = paneInr.wind;
  const tw = currentTw();
  const lat = domain.lat(probe.y);
  const lon = domain.lon(probe.x);
  const ground = terrain.at(lat, lon);
  const ex = state.exaggeration;
  const X = domain.sceneX(probe.x);
  const Z = domain.sceneZ(probe.y);
  const gy = (ground / 1000) * ex;
  const heights = inr.levels.map((_, k) => inr.sample(inr.height, tw, k, lat, lon));
  const ys = heights.filter((h) => h > ground).map((h) => (h / 1000) * ex);
  // popup at the chosen level (all levels: the top one), or on the ground where it is inside the terrain
  const popH = state.all ? Math.max(...heights) : heights[state.level];
  const popY = (Math.max(popH, ground) / 1000) * ex;
  for (const p of panes) {
    p.marker.set(X, Z, gy, ys, 0.5 * domain.scale);
    p.highlight.set(X, gy, Z, probeNew, domain.scale);
    p.showPopup(X, popY, Z, popupHtml(p.wind!, tw, lat, lon, ground));
  }
  probeNew = false;
}

function highlightTick(dt: number): void {
  for (const p of panes) p.highlight.update(dt);
}

// ---------------------------------------------------------------- loop
const ro = new ResizeObserver(() => panes.forEach((p) => p.resize()));
panes.forEach((p) => ro.observe(p.root));

const clock = new THREE.Clock();
function frame(): void {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (shared && paneInr.wind && paneRaw.wind) {
    const times = paneInr.wind.times;
    if (state.playing) {
      let t = state.t + dt * state.rate;
      if (t > times[times.length - 1]) t = times[0];
      setTime(t);
    }
    const tw = currentTw();
    for (const p of panes) {
      p.ps.step(dt, p.ctx(shared.terrain, shared.domain, tw));
      p.particles.update(p.ps, shared.maxSpeed);
      if (surfaceDirty) p.updateSurfaces(shared.terrain, tw, shared.maxSpeed);
    }
    surfaceDirty = false;
    if (probeDirty) {
      probeDirty = false;
      updateProbe();
    }
    highlightTick(dt);
    syncCameras();
    const fade = sideViewFade();
    for (const p of panes) p.fadeSurfaces(fade);
    panes.forEach((p) => p.render());
  }
}

// ---------------------------------------------------------------- start
async function start(): Promise<void> {
  try {
    const index = await loadIndex();
    const ids = new Set(index.datasets.map((d) => d.id));
    // every forecast that has both its raw output on the CFD box and a WindINR run
    const drivers = index.datasets
      .filter((d) => d.id.startsWith('windinr-') && ids.has(`${d.id.slice(8)}-cfdbox`))
      .map((d) => d.id.slice(8));
    const manifests = await Promise.all(drivers.map((d) => loadWindManifest(`windinr-${d}`)));
    // "WindINR × FCN3" -> "FCN3"
    const name = (model: string) => model.replace(/^WindINR\s*×\s*/, '');
    pairs = drivers.map((d, i) => ({ driver: d, raw: `${d}-cfdbox`, inr: `windinr-${d}`, label: name(manifests[i].model) }));
    if (!pairs.length) throw new Error('no forecast with both <driver>-cfdbox and windinr-<driver> datasets');
    modelSel.innerHTML = pairs.map((p) => `<option value="${p.driver}">${p.label}</option>`).join('');
    const want = new URLSearchParams(location.search).get('model');
    modelSel.value = pairs.find((p) => p.driver === want)?.driver ?? pairs.find((p) => p.driver === 'fcn3')?.driver ?? pairs[0].driver;
    await load(modelSel.value);
  } catch (err) {
    setLoading(null);
    showError(`Could not start: ${(err as Error).message}`);
  }
  frame();
}

void start();
