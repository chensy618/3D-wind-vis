import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import './style.css';
import { niceMax } from './colormap';
import { Domain } from './geo';
import { Annotations, ProbeMarker } from './scene/annotations';
import { CameraRig, createCamera } from './scene/camera';
import { LevelSurface } from './scene/levels';
import { ParticleRenderer } from './scene/particles';
import { buildDomainFrame, buildTerrainMesh } from './scene/terrain';
import { Inspector, ProbeRow } from './ui/inspector';
import { renderLegend } from './ui/legend';
import { LevelMode, LevelSelector } from './ui/levels';
import { Timeline } from './ui/timeline';
import { AdvectionContext, ParticleSystem } from './wind/advection';
import { timeWeights, TimeWeights } from './wind/interpolation';
import { loadIndex, loadTerrain, loadWind, Terrain, WindField } from './wind/loader';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------------------------------------------------------------- state
const state = {
  t: 0,
  playing: false,
  rate: 1, // forecast hours per second
  smooth: true, // temporal interpolation between forecast steps
  mode: 'single' as LevelMode,
  level: 2,
  nParticles: 4000,
  speedFactor: 300, // simulated seconds per real second for particle motion
  exaggeration: 4,
  showSurface: true,
};

interface Loaded {
  wind: WindField;
  terrain: Terrain;
  domain: Domain;
  maxSpeed: number;
  content: THREE.Group;
  terrainMesh: THREE.Mesh;
  surface: LevelSurface;
  annotations: Annotations;
}

let data: Loaded | null = null;
let rig: CameraRig | null = null;
let probe: { x: number; y: number } | null = null;
let surfaceDirty = true;
let lastProbeT = -1;

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
sun.position.set(-40, 25, 30); // low Arctic sun from the south-west
scene.add(sun);

const particles = new ParticleRenderer();
const ps = new ParticleSystem();
const marker = new ProbeMarker();
scene.add(particles.group, marker.group);

// ---------------------------------------------------------------- UI
const timeline = new Timeline($('#timeline'), {
  onTime: (t) => setTime(t),
  onPlay: (p) => (state.playing = p),
  onRate: (r) => (state.rate = r),
});
const levelSel = new LevelSelector($('#levels'), (mode, level) => {
  state.mode = mode;
  state.level = level;
  resetParticles();
  surfaceDirty = true;
  lastProbeT = -1;
});
const inspector = new Inspector($('#inspector'), () => {
  probe = null;
  inspector.hide();
  marker.hide();
});

function bindRange(id: string, fmt: (v: number) => string, apply: (v: number) => void): void {
  const inp = $<HTMLInputElement>(`#${id}`);
  const out = $(`#${id}-out`);
  const upd = () => {
    const v = parseFloat(inp.value);
    out.textContent = fmt(v);
    apply(v);
  };
  inp.addEventListener('input', upd);
  out.textContent = fmt(parseFloat(inp.value));
}

bindRange('n-particles', (v) => v.toLocaleString('en'), (v) => {
  state.nParticles = v;
  resetParticles();
});
bindRange('flow-speed', (v) => `×${v}`, (v) => (state.speedFactor = v));
bindRange('exaggeration', (v) => `×${v}`, (v) => {
  state.exaggeration = v;
  applyExaggeration();
});
$<HTMLInputElement>('#show-surface').addEventListener('change', (e) => {
  state.showSurface = (e.target as HTMLInputElement).checked;
  surfaceDirty = true;
});
$<HTMLInputElement>('#smooth').addEventListener('change', (e) => {
  state.smooth = (e.target as HTMLInputElement).checked;
  surfaceDirty = true;
  lastProbeT = -1;
});
$('#reset-camera').addEventListener('click', () => rig?.reset());

const datasetSel = $<HTMLSelectElement>('#dataset');
const terrainSel = $<HTMLSelectElement>('#terrain');
const onDataChange = () => {
  const q = new URLSearchParams({ data: datasetSel.value, terrain: terrainSel.value });
  history.replaceState(null, '', `?${q}`);
  void load(datasetSel.value, terrainSel.value);
};
datasetSel.addEventListener('change', onDataChange);
terrainSel.addEventListener('change', onDataChange);

// ---------------------------------------------------------------- helpers
function currentTw(): TimeWeights {
  return timeWeights(data!.wind.times, state.t, state.smooth);
}

function activeLevels(): number[] {
  if (!data) return [];
  return state.mode === 'multi' ? data.wind.levels.map((_, i) => i) : [state.level];
}

function advCtx(): AdvectionContext {
  const d = data!;
  return {
    wind: d.wind,
    terrain: d.terrain,
    domain: d.domain,
    tw: currentTw(),
    speedFactor: state.speedFactor,
    exaggeration: state.exaggeration,
  };
}

function resetParticles(): void {
  if (!data) return;
  const n = state.mode === 'multi' ? state.nParticles : Math.round(state.nParticles / 2);
  ps.reset(n, activeLevels(), advCtx());
  const active = data.wind.levels.map((_, i) => activeLevels().includes(i));
  data.annotations.highlight(active);
}

function setTime(t: number): void {
  state.t = t;
  timeline.setTime(t);
  surfaceDirty = true;
}

function meanHeights(w: WindField): number[] {
  return w.levels.map((_, i) => w.meanHeight(i, 0));
}

function applyExaggeration(): void {
  if (!data) return;
  data.terrainMesh.scale.y = state.exaggeration;
  const w = data.wind;
  const top = w.manifest.variables.height.max + 500;
  data.content.getObjectByName('domain-frame')?.removeFromParent();
  data.content.add(buildDomainFrame(data.domain, (top / 1000) * state.exaggeration));
  data.annotations.build(w.levels, meanHeights(w), state.exaggeration, top);
  resetParticles();
  surfaceDirty = true;
  lastProbeT = -1;
}

function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
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

async function load(datasetId: string, terrainId: string): Promise<void> {
  setLoading('Loading wind field and terrain…');
  $('#error').hidden = true;
  try {
    const [wind, terrain] = await Promise.all([loadWind(datasetId), loadTerrain(terrainId)]);
    const domain = Domain.fromGrid(terrain.grid);

    if (data) {
      data.annotations.dispose();
      disposeGroup(data.content);
      scene.remove(data.content);
    }
    const content = new THREE.Group();
    const terrainMesh = buildTerrainMesh(terrain, domain);
    const surface = new LevelSurface(wind, domain);
    const annotations = new Annotations(domain);
    content.add(terrainMesh, surface.mesh, annotations.group);
    scene.add(content);

    data = {
      wind,
      terrain,
      domain,
      maxSpeed: niceMax(wind.manifest.variables.wind_speed.max),
      content,
      terrainMesh,
      surface,
      annotations,
    };

    if (!rig) {
      rig = createCamera(canvas, domain);
      resize();
    }

    const m = wind.manifest;
    $('#model-name').textContent = m.model;
    $('#model-desc').textContent = m.description;
    $('#init-time').textContent = /^\d{4}-/.test(m.init_time) ? `init ${m.init_time.replace('T', ' ')}:00 UTC` : '';
    $('#terrain-src').textContent = terrain.manifest.source;
    renderLegend($('#legend'), data.maxSpeed);

    state.level = Math.min(state.level, m.levels.length - 1);
    levelSel.setLevels(m.levels, meanHeights(wind), state.level);
    timeline.setData(m.times, m.init_time);
    setTime(Math.min(Math.max(state.t, m.times[0]), m.times[m.times.length - 1]));
    applyExaggeration();
    if (probe && !domain.contains(probe.x, probe.y)) inspector.hide();
    setLoading(null);
  } catch (err) {
    console.error(err);
    setLoading(null);
    showError(`Could not load data: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- point inspection
const raycaster = new THREE.Raycaster();
let downAt: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || !data || !rig) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 4) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, rig.camera);
  const targets: THREE.Object3D[] = [data.terrainMesh];
  if (data.surface.mesh.visible) targets.unshift(data.surface.mesh);
  const hit = raycaster.intersectObjects(targets, false)[0];
  if (!hit) return;
  const p = data.domain.fromScene(hit.point);
  if (!data.domain.contains(p.x, p.y)) return;
  probe = p;
  lastProbeT = -1;
});

function updateProbe(): void {
  if (!probe || !data) return;
  const { wind, terrain, domain } = data;
  const tw = currentTw();
  const lat = domain.lat(probe.y);
  const lon = domain.lon(probe.x);
  const ground = terrain.at(lat, lon);
  const rows: ProbeRow[] = wind.levels.map((level, i) => {
    const u = wind.sample(wind.u, tw, i, lat, lon);
    const v = wind.sample(wind.v, tw, i, lat, lon);
    const height = wind.sample(wind.height, tw, i, lat, lon);
    return { level, height, u, v, speed: Math.hypot(u, v), belowGround: height <= ground };
  });
  inspector.show({
    lat,
    lon,
    terrain: ground,
    model: wind.manifest.model,
    lead: state.t,
    selectedLevel: state.mode === 'single' ? state.level : null,
    rows,
    maxSpeed: data.maxSpeed,
  });
  const ex = state.exaggeration;
  marker.set(
    domain.sceneX(probe.x),
    domain.sceneZ(probe.y),
    (ground / 1000) * ex,
    rows.filter((r) => !r.belowGround).map((r) => (r.height / 1000) * ex),
  );
}

/** Explain empty levels, e.g. 1000 hPa inside a deep low lies below sea level. */
function updateNotice(): void {
  const el = $('#notice');
  let alive = 0;
  for (let i = 0; i < ps.n; i++) alive += ps.alive[i];
  if (!data || ps.n === 0 || alive > 0 || state.mode !== 'single') {
    el.hidden = true;
    return;
  }
  const p = data.wind.levels[state.level];
  el.hidden = false;
  el.textContent = `${p} hPa lies below the terrain everywhere in this domain at T+${Math.round(state.t)} h ` +
    `(surface pressure < ${p} hPa), so there is no wind to show at this level.`;
}

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

const clock = new THREE.Clock();
let fpsAcc = 0;
let fpsN = 0;
function frame(): void {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (data && rig) {
    const times = data.wind.times;
    if (state.playing) {
      let t = state.t + dt * state.rate;
      if (t > times[times.length - 1]) t = times[0];
      setTime(t);
    }
    const ctx = advCtx();
    ps.step(dt, ctx);
    particles.update(ps, data.maxSpeed);

    const showSurface = state.showSurface && state.mode === 'single';
    data.surface.mesh.visible = showSurface;
    if (showSurface && surfaceDirty) {
      data.surface.update(state.level, ctx.tw, data.terrain, state.exaggeration, data.maxSpeed, 0.35);
    }
    surfaceDirty = false;
    if (probe && Math.abs(state.t - lastProbeT) > 0.05) {
      updateProbe();
      lastProbeT = state.t;
    }
    rig.controls.update();
    renderer.render(scene, rig.camera);
    labels.render(scene, rig.camera);
  }
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 1) {
    $('#fps').textContent = `${Math.round(fpsN / fpsAcc)} fps · ${ps.n.toLocaleString('en')} particles`;
    fpsAcc = 0;
    fpsN = 0;
    updateNotice();
  }
}

// ---------------------------------------------------------------- start
async function start(): Promise<void> {
  try {
    const index = await loadIndex();
    if (!index.datasets.length) throw new Error('no datasets in data/index.json');
    datasetSel.innerHTML = index.datasets.map((d) => `<option value="${d.id}">${d.label}</option>`).join('');
    terrainSel.innerHTML = index.terrains.map((d) => `<option value="${d.id}">${d.label}</option>`).join('');
    const q = new URLSearchParams(location.search);
    const pick = (list: { id: string }[], want: string | null, prefer: string) =>
      list.find((d) => d.id === want)?.id ?? list.find((d) => d.id === prefer)?.id ?? list[0].id;
    datasetSel.value = pick(index.datasets, q.get('data'), 'fcn3');
    terrainSel.value = pick(index.terrains, q.get('terrain'), 'terrain');
    await load(datasetSel.value, terrainSel.value);
  } catch (err) {
    setLoading(null);
    showError(`Could not start: ${(err as Error).message}`);
  }
  frame();
}

void start();
