import { RegularGrid } from '../geo';
import { bilinear, sampleSpaceTime, TimeWeights } from './interpolation';

/** Common Wind Schema (see preprocessing/common_schema.py). */
export interface WindManifest {
  schema: string;
  model: string;
  init_time: string;
  description: string;
  shape: [number, number, number, number]; // time, level, lat, lon
  times: number[];
  levels: number[];
  lat: number[];
  lon: number[];
  variables: Record<string, { file: string; units: string; min: number; max: number }>;
  /** Spacing (degrees) of the model's own lat/lon grid, when known. */
  native_deg?: number;
  /** Optional surface fields (u10, v10), laid out (time, lat, lon). */
  surface?: Record<string, { file: string; units: string; min: number; max: number }>;
}

export interface TerrainManifest {
  source: string;
  shape: [number, number];
  lat: number[];
  lon: number[];
  file: string;
  min: number;
  max: number;
}

export interface DatasetEntry {
  id: string;
  label: string;
}

export interface DataIndex {
  datasets: DatasetEntry[];
  terrains: DatasetEntry[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url} (${r.status})`);
  return (await r.json()) as T;
}

async function fetchF32(url: string, expected: number): Promise<Float32Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url} (${r.status})`);
  const arr = new Float32Array(await r.arrayBuffer());
  if (arr.length !== expected) throw new Error(`${url}: expected ${expected} values, got ${arr.length}`);
  return arr;
}

export function loadIndex(base = 'data'): Promise<DataIndex> {
  return fetchJson<DataIndex>(`${base}/index.json`);
}

export class WindField {
  readonly nt: number;
  readonly nl: number;
  readonly ny: number;
  readonly nx: number;
  readonly grid: RegularGrid;

  constructor(
    readonly manifest: WindManifest,
    readonly u: Float32Array,
    readonly v: Float32Array,
    readonly height: Float32Array,
    readonly speed: Float32Array,
    /** 10 m wind (time, lat, lon), when the model provides it */
    readonly u10: Float32Array | null = null,
    readonly v10: Float32Array | null = null,
  ) {
    [this.nt, this.nl, this.ny, this.nx] = manifest.shape;
    this.grid = new RegularGrid(manifest.lat, manifest.lon);
  }

  get times(): number[] {
    return this.manifest.times;
  }

  get levels(): number[] {
    return this.manifest.levels;
  }

  sample(field: Float32Array, tw: TimeWeights, level: number, lat: number, lon: number): number {
    return sampleSpaceTime(field, tw, level, this.ny, this.nx, this.nl, this.grid.fy(lat), this.grid.fx(lon));
  }

  /** Sample a (time, lat, lon) surface field. */
  sampleSurface(field: Float32Array, tw: TimeWeights, lat: number, lon: number): number {
    return sampleSpaceTime(field, tw, 0, this.ny, this.nx, 1, this.grid.fy(lat), this.grid.fx(lon));
  }

  /** Mean geopotential height of a level at a frame (m). */
  meanHeight(level: number, frame = 0): number {
    const n = this.ny * this.nx;
    const o = (frame * this.nl + level) * n;
    let s = 0;
    for (let i = 0; i < n; i++) s += this.height[o + i];
    return s / n;
  }
}

export function loadWindManifest(id: string, base = 'data'): Promise<WindManifest> {
  return fetchJson<WindManifest>(`${base}/${id}/manifest.json`);
}

export async function loadWind(id: string, base = 'data'): Promise<WindField> {
  const dir = `${base}/${id}`;
  const m = await loadWindManifest(id, base);
  const n = m.shape.reduce((a, b) => a * b, 1);
  const [u, v, h, s] = await Promise.all(
    ['u', 'v', 'height', 'wind_speed'].map((k) => fetchF32(`${dir}/${m.variables[k].file}`, n)),
  );
  const sf = m.surface;
  const [u10, v10] =
    sf?.u10 && sf?.v10
      ? await Promise.all([sf.u10, sf.v10].map((x) => fetchF32(`${dir}/${x.file}`, m.shape[0] * m.shape[2] * m.shape[3])))
      : [null, null];
  return new WindField(m, u, v, h, s, u10, v10);
}

export class Terrain {
  readonly ny: number;
  readonly nx: number;
  readonly grid: RegularGrid;

  constructor(
    readonly manifest: TerrainManifest,
    readonly elevation: Float32Array,
  ) {
    [this.ny, this.nx] = manifest.shape;
    this.grid = new RegularGrid(manifest.lat, manifest.lon);
  }

  /** Elevation (m) at lat/lon, bilinear. */
  at(lat: number, lon: number): number {
    return bilinear(this.elevation, 0, this.ny, this.nx, this.grid.fy(lat), this.grid.fx(lon));
  }
}

export async function loadTerrain(id: string, base = 'data'): Promise<Terrain> {
  const dir = `${base}/${id}`;
  const m = await fetchJson<TerrainManifest>(`${dir}/manifest.json`);
  const elev = await fetchF32(`${dir}/${m.file}`, m.shape[0] * m.shape[1]);
  return new Terrain(m, elev);
}
