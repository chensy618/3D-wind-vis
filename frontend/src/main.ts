import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import './style.css';
import { niceMax } from './colormap';
import { Domain } from './geo';
import { Annotations, ProbeMarker } from './scene/annotations';
import { CameraRig, createCamera, sideViewFade } from './scene/camera';
import { Highlight } from './scene/highlight';
import { LevelSurface, SurfaceLayer } from './scene/levels';
import { ParticleRenderer } from './scene/particles';
import { buildDomainFrame, buildTerrainMesh } from './scene/terrain';
import { Inspector, ProbeRow } from './ui/inspector';
import { renderLegend } from './ui/legend';
import { renderLevelPicker } from './ui/levels';
import { PointQuery } from './ui/query';
import { Timeline } from './ui/timeline';
import { fitUi } from './ui/fit';
import { renderViewSwitcher } from './ui/viewSwitcher';
import { AdvectionContext, ParticleSystem, SURFACE_LEVEL } from './wind/advection';
import { timeWeights, TimeWeights } from './wind/interpolation';
import { DataIndex, datasetOptions, loadIndex, loadTerrain, loadWind, Terrain, WindField } from './wind/loader';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------------------------------------------------------------- state
/** The default view stands this much further back than the camera's own framing (a little smaller). */
const VIEW_DISTANCE = 1.12;
/** Particle trail length in frames (ParticleSystem default 35; the compare page uses 45). */
const TRAIL_LEN = 50;
/** The steady CFD cases (CFD box, up to 1.5 km, no timeline) sit a little lower in their default view. */
const viewLift = (d: Domain) => (d.scale < 0.5 && data?.wind.times.length === 1 ? 0.09 : 0);

const state = {
  t: 0,
  playing: false,
  rate: 1, // forecast hours per second
  smooth: true, // temporal interpolation between forecast steps
  nParticles: 4000,
  speedFactor: 300, // simulated seconds per real second for particle motion
  exaggeration: 4, // vertical stretch, from the domain size (Domain.viewDefaults)
  showSurface: true,
  levels: [] as number[], // shown level indices, ascending; all of them by default
  surfaceLayer: false, // the dataset's 10 m wind is on show (only when it has u10/v10)
};

interface Loaded {
  wind: WindField;
  terrain: Terrain;
  terrainId: string;
  domain: Domain;
  maxSpeed: number;
  content: THREE.Group;
  terrainMesh: THREE.Mesh;
  /** one level surface per pressure level, shown for the chosen levels */
  surfaces: LevelSurface[];
  /** the flat 10 m surface, when the dataset has u10/v10 */
  surfaceMesh: SurfaceLayer | null;
  annotations: Annotations;
}

let data: Loaded | null = null;
let index: DataIndex | null = null;
let rig: CameraRig | null = null;
let probe: { x: number; y: number } | null = null;
/** A new probe point (click or query): restart the highlight pulse; `focus`: also pan the camera to it. */
let probeNew: { focus: boolean } | null = null;
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
ps.trailLen = TRAIL_LEN;
const marker = new ProbeMarker();
const highlight = new Highlight();
scene.add(particles.group, marker.group, highlight.group);

// ---------------------------------------------------------------- UI
const timeline = new Timeline($('#timeline'), {
  onTime: (t) => setTime(t),
  onPlay: (p) => (state.playing = p),
  onRate: (r) => (state.rate = r),
});
const inspector = new Inspector($('#inspector'), () => {
  probe = null;
  inspector.hide();
  marker.hide();
  highlight.hide();
});
const query = new PointQuery($('#query'), (lat, lon) => {
  if (!data) return;
  probe = { x: data.domain.localX(lon), y: data.domain.localY(lat) };
  probeNew = { focus: true };
  lastProbeT = -1;
});

renderViewSwitcher($('#views'), 'viewer');
fitUi();
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
const onDataChange = () => {
  const q = new URLSearchParams({ data: datasetSel.value });
  history.replaceState(null, '', `?${q}`);
  void load(datasetSel.value);
};
datasetSel.addEventListener('change', onDataChange);

/**
 * Flow speed (on a new domain) and vertical exaggeration suited to the domain size
 * (Domain.viewDefaults). Data that end low over a wide domain, like the synthetic field (1.5 km
 * over 52 km), are stretched a little further, up to ×6; the forecasts (×4), CFD and WindINR
 * (×1.5) keep their domain value.
 */
function applyViewDefaults(domain: Domain, wind: WindField, newDomain: boolean): void {
  const d = domain.viewDefaults;
  if (newDomain) state.speedFactor = d.flowSpeed;
  const topKm = (wind.manifest.variables.height.max + 500) / 1000;
  state.exaggeration = Math.max(d.exaggeration, Math.min(6, (0.25 * Math.max(domain.width, domain.depth)) / topKm));
}

// ---------------------------------------------------------------- helpers
function currentTw(): TimeWeights {
  return timeWeights(data!.wind.times, state.t, state.smooth);
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
    vertical: true, // particles move with w whenever the dataset has it (WindINR, CFD)
  };
}

function resetParticles(): void {
  if (!data) return;
  ps.reset(state.nParticles, layerIndices(), advCtx());
}

/** Level indices to advect: the shown pressure levels, plus the 10 m layer when it is on. */
function layerIndices(): number[] {
  return state.surfaceLayer ? [...state.levels, SURFACE_LEVEL] : state.levels;
}

/** Accent the level tags of the levels on show. */
function syncLevelTags(): void {
  if (!data) return;
  data.annotations.highlight(data.wind.levels.map((_, i) => state.levels.includes(i)));
}

function setTime(t: number): void {
  state.t = t;
  timeline.setTime(t);
  surfaceDirty = true;
}

/** Full name and maker per model, for the one-line description under the title. */
const MODEL_SOURCES: Record<string, string> = {
  FCN3: 'FourCastNet3, NVIDIA',
  GraphCast: 'GraphCast, Google DeepMind',
  Aurora: 'Aurora, Microsoft',
  Synthetic: 'Analytic test field',
};

/**
 * One line under the title (the model name is already beside it): the forecast model's full name
 * and maker; for WindINR its CFD training and the forecast it downscales; for a CFD case its inflow; otherwise the
 * description's first clause.
 */
function shortDescription(m: WindField['manifest']): string {
  const [name, driver] = m.model.split(' × ');
  const known = MODEL_SOURCES[name.split(' ')[0]];
  if (known) return known;
  // WindINR does not forecast: trained on CFD runs, it then downscales the coarse forecast per lead time
  if (driver) {
    const by = MODEL_SOURCES[driver]?.split(', ')[0] ?? driver;
    return `CFD-trained downscaling of ${by} over the Senja domain`;
  }
  const inflow = m.description.match(/inflow from \S+ \((\w+)\) at ([\d.]+ m\/s)/);
  if (inflow) return `Steady RANS, inflow from ${inflow[1]} at ${inflow[2]}`;
  return m.description.match(/^(.*?)(?:[:;]\s|\.\s|$)/)![1];
}

function meanHeights(w: WindField): number[] {
  return w.levels.map((_, i) => w.meanHeight(i, 0));
}

function rebuildView(): void {
  if (!data) return;
  data.terrainMesh.scale.y = state.exaggeration;
  const w = data.wind;
  const top = w.manifest.variables.height.max + 500;
  data.content.getObjectByName('domain-frame')?.removeFromParent();
  data.content.add(buildDomainFrame(data.domain, (top / 1000) * state.exaggeration));
  data.annotations.build(w.levels, meanHeights(w), state.exaggeration, top, w.manifest.level_units);
  resetParticles();
  surfaceDirty = true;
  lastProbeT = -1;
  syncLevelTags();
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

async function load(datasetId: string): Promise<void> {
  // the dataset's own terrain when it pins one (it was built on that box), otherwise the default
  const terrainId = index?.datasets.find((d) => d.id === datasetId)?.terrain ?? 'terrain';
  setLoading('Loading wind field and terrain…');
  $('#error').hidden = true;
  try {
    const [wind, terrain] = await Promise.all([loadWind(datasetId), loadTerrain(terrainId)]);
    const domain = Domain.fromGrid(terrain.grid);
    const newDomain = data?.terrainId !== terrainId;

    if (data) {
      data.annotations.dispose();
      disposeGroup(data.content);
      scene.remove(data.content);
    }
    const content = new THREE.Group();
    const terrainMesh = buildTerrainMesh(terrain, domain);
    const surfaces = wind.levels.map(() => new LevelSurface(wind, domain));
    const surfaceMesh = wind.u10 && wind.v10 ? new SurfaceLayer(terrain, domain) : null;
    const annotations = new Annotations(domain);
    content.add(terrainMesh, ...surfaces.map((s) => s.mesh), ...(surfaceMesh ? [surfaceMesh.mesh] : []), annotations.group);
    scene.add(content);

    data = {
      wind,
      terrain,
      terrainId,
      domain,
      maxSpeed: niceMax(wind.manifest.variables.wind_speed.max),
      content,
      terrainMesh,
      surfaces,
      surfaceMesh,
      annotations,
    };

    if (!rig) {
      rig = createCamera(canvas, domain, VIEW_DISTANCE, viewLift);
      resize();
    } else if (newDomain) {
      rig.setDomain(domain);
    }

    const m = wind.manifest;
    $('#model-name').textContent = m.model;
    const desc = $('#model-desc');
    desc.textContent = shortDescription(m);
    desc.title = m.description; // the full text on hover when shortened
    $('#init-time').textContent = /^\d{4}-/.test(m.init_time) ? `init ${m.init_time.replace('T', ' ')}:00 UTC` : '';
    // without the file name or the ", resampled" note
    $('#terrain-src').textContent = terrain.manifest.source.replace(/\s*\([^)]*\.tif\)/i, '').replace(/,\s*resampled$/i, '');
    renderLegend($('#legend'), data.maxSpeed);

    const has10m = !!(wind.u10 && wind.v10);
    state.levels = m.levels.map((_, i) => i);
    state.surfaceLayer = has10m; // every layer starts on, the 10 m one too when the dataset has it
    renderLevelPicker(
      $('#levels'),
      m.levels,
      meanHeights(wind),
      (selected, surface) => {
        state.levels = selected;
        state.surfaceLayer = surface;
        syncLevelTags();
        resetParticles();
        surfaceDirty = true;
        lastProbeT = -1;
      },
      m.level_units,
      { available: has10m, checked: state.surfaceLayer },
    );

    // a steady CFD solution has a single frame and no forecast clock
    $('#timeline').hidden = m.times.length === 1;
    timeline.setData(m.times, m.init_time);
    setTime(Math.min(Math.max(state.t, m.times[0]), m.times[m.times.length - 1]));
    applyViewDefaults(domain, wind, newDomain);
    rebuildView();
    query.setBounds(domain);
    // probe coordinates are local to the old domain
    if (probe && (newDomain || !domain.contains(probe.x, probe.y))) {
      probe = null;
      inspector.hide();
      marker.hide();
      highlight.hide();
    }
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
  const targets: THREE.Object3D[] = [...data.surfaces.map((s) => s.mesh).filter((m) => m.visible), data.terrainMesh];
  const hit = raycaster.intersectObjects(targets, false)[0];
  if (!hit) return;
  const p = data.domain.fromScene(hit.point);
  if (!data.domain.contains(p.x, p.y)) return;
  probe = p;
  probeNew = { focus: false };
  lastProbeT = -1;
});

/** The 10 m above-ground wind (u10/v10, and w10 when the dataset has it) for the profile. */
function surfaceRow(wind: WindField, tw: TimeWeights, lat: number, lon: number, ground: number): ProbeRow {
  const u = wind.sampleSurface(wind.u10!, tw, lat, lon);
  const v = wind.sampleSurface(wind.v10!, tw, lat, lon);
  const w = wind.w10 ? wind.sampleSurface(wind.w10, tw, lat, lon) : undefined;
  return { level: 0, height: ground + 10, u, v, w, speed: Math.hypot(u, v), belowGround: false };
}

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
    const w = wind.w ? wind.sample(wind.w, tw, i, lat, lon) : undefined;
    return { level, height, u, v, w, speed: Math.hypot(u, v), belowGround: height <= ground };
  });
  inspector.show({
    lat,
    lon,
    terrain: ground,
    model: wind.manifest.model,
    lead: state.t,
    steady: wind.times.length === 1,
    levelUnit: wind.manifest.level_units ?? 'hPa',
    selectedLevels: state.levels.length === data.wind.levels.length ? [] : state.levels,
    rows,
    surface: wind.u10 && wind.v10 ? surfaceRow(wind, tw, lat, lon, ground) : null,
    maxSpeed: data.maxSpeed,
  });
  const ex = state.exaggeration;
  const X = domain.sceneX(probe.x);
  const Z = domain.sceneZ(probe.y);
  const groundY = (ground / 1000) * ex;
  marker.set(X, Z, groundY, rows.filter((r) => !r.belowGround).map((r) => (r.height / 1000) * ex), 0.5 * domain.scale);
  highlight.set(X, groundY, Z, probeNew != null, domain.scale);
  if (probeNew?.focus) rig?.focus(new THREE.Vector3(X, groundY, Z));
  probeNew = null;
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

    // one translucent surface per layer on show; seen through all n of them, the stack is as
    // opaque as one surface at 0.35 (1 - (1 - a)^n = 0.35), so a side view stays see-through
    const nLayers = state.levels.length + (state.surfaceLayer ? 1 : 0);
    const opacity = 1 - Math.pow(1 - 0.35, 1 / Math.max(1, nLayers));
    data.surfaces.forEach((s, i) => {
      const show = state.showSurface && state.levels.includes(i);
      s.mesh.visible = show;
      if (show && surfaceDirty) s.update(i, ctx.tw, data!.terrain, state.exaggeration, data!.maxSpeed, opacity);
    });
    const sl = data.surfaceMesh;
    if (sl) {
      const show = state.showSurface && state.surfaceLayer;
      sl.mesh.visible = show;
      if (show && surfaceDirty) sl.update(data.wind, ctx.tw, data!.terrain, state.exaggeration, data!.maxSpeed, opacity);
    }
    // several layers: their surfaces show from the side and fade out as the view tilts up, as on
    // the compare page, so an oblique or top view shows the particles alone; one layer always shows
    const fade = nLayers > 1 ? sideViewFade(rig) : 1;
    for (const mesh of [...data.surfaces.map((s) => s.mesh), ...(sl ? [sl.mesh] : [])]) {
      if (!mesh.visible) continue;
      (mesh.material as THREE.MeshBasicMaterial).opacity = fade;
      mesh.visible = fade > 0.01;
    }
    surfaceDirty = false;
    if (probe && Math.abs(state.t - lastProbeT) > 0.05) {
      updateProbe();
      lastProbeT = state.t;
    }
    highlight.update(dt);
    rig.tick(dt);
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
  }
}

// ---------------------------------------------------------------- start
async function start(): Promise<void> {
  try {
    index = await loadIndex();
    if (!index.datasets.length) throw new Error('no datasets in data/index.json');
    datasetSel.innerHTML = datasetOptions(index.datasets);
    const q = new URLSearchParams(location.search);
    const pick = (list: { id: string }[], want: string | null, prefer: string) =>
      list.find((d) => d.id === want)?.id ?? list.find((d) => d.id === prefer)?.id ?? list[0].id;
    datasetSel.value = pick(index.datasets, q.get('data'), 'fcn3');
    history.replaceState(null, '', `?data=${datasetSel.value}`); // also drops a legacy ?terrain=
    await load(datasetSel.value);
  } catch (err) {
    setLoading(null);
    showError(`Could not start: ${(err as Error).message}`);
  }
  frame();
}

void start();
