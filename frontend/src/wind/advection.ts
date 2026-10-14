import { CellBounds, Domain } from '../geo';
import { TimeWeights } from './interpolation';
import { Terrain, WindField } from './loader';

/** Number of stored positions per particle (trail length in frames). */
export const TRAIL = 35;

/** Particles stay this far (m) above the terrain; otherwise the level is below ground. */
const GROUND_CLEARANCE = 30;
/** With vertical motion, the lowest a particle may sink (m above ground): the 10 m wind's height. */
const FLOOR_AGL = 10;
/**
 * Near the mountain tops (within NEAR_GROUND_M of the ground, where the ground is above
 * SUMMIT_FRAC of the highest terrain), a particle that moves less than STILL_FRAC of the
 * domain size per real second draws no visible tail (it has climbed into the slow air at the
 * ground). After STILL_TIME (s) of that it fades out over FADE_OUT (s), instead of sitting
 * there as a lone dot. Slow particles elsewhere (e.g. a lee wake) are left alone.
 * WindINR × forecast needs this most: its 500 m ceiling leaves almost no wind on higher summits.
 */
const NEAR_GROUND_M = 150;
const SUMMIT_FRAC = 0.5;
const STILL_FRAC = 0.02;
const STILL_TIME = 0.1;
const FADE_OUT = 0.15;

export interface AdvectionContext {
  wind: WindField;
  terrain: Terrain;
  domain: Domain;
  tw: TimeWeights;
  /** simulated seconds per real second (visual flow speed, decoupled from forecast time) */
  speedFactor: number;
  exaggeration: number;
  /** move particles with the vertical wind w too (datasets that have it, e.g. WindINR) */
  vertical: boolean;
}

/**
 * Wind (u, v, w) at height z (m ASL) above a point, linear in height through the 10 m wind
 * (ground + 10 m) and the levels above the ground there, held constant beyond the ends.
 * For datasets with w on fixed-height levels.
 */
function sampleColumn(ctx: AdvectionContext, lat: number, lon: number, z: number, ground: number, out: Float32Array): void {
  const { wind, tw } = ctx;
  // walk up the column, (z0, u0, v0, w0) the last point below z (NaN: none yet)
  let z0 = NaN;
  let u0 = 0, v0 = 0, w0 = 0;
  if (wind.u10 && wind.v10) {
    z0 = ground + FLOOR_AGL;
    u0 = wind.sampleSurface(wind.u10, tw, lat, lon);
    v0 = wind.sampleSurface(wind.v10, tw, lat, lon);
    w0 = wind.w10 ? wind.sampleSurface(wind.w10, tw, lat, lon) : 0;
  }
  for (let k = 0; k < wind.nl; k++) {
    const zk = wind.sample(wind.height, tw, k, lat, lon);
    if (zk <= ground + FLOOR_AGL) continue; // the level is inside the terrain here
    const uk = wind.sample(wind.u, tw, k, lat, lon);
    const vk = wind.sample(wind.v, tw, k, lat, lon);
    const wk = wind.sample(wind.w!, tw, k, lat, lon);
    if (z <= zk) {
      const a = Number.isNaN(z0) ? 1 : Math.min(1, Math.max(0, (z - z0) / (zk - z0)));
      out[0] = u0 + a * (uk - u0);
      out[1] = v0 + a * (vk - v0);
      out[2] = w0 + a * (wk - w0);
      return;
    }
    z0 = zk;
    u0 = uk;
    v0 = vk;
    w0 = wk;
  }
  out[0] = u0; // above the top level: its wind
  out[1] = v0;
  out[2] = w0;
}

/**
 * Particle state in local km coordinates.  P(t + dt) = P(t) + V(P) dt with
 * V = (u, v, 0) for the multi-level (u, v) models: the vertical position is the
 * geopotential height of the particle's level at its current location. With `vertical` and a
 * dataset that has w, V = (u, v, w): a particle starts on its level, then rises and sinks
 * freely, never lower than FLOOR_AGL above the ground.
 */
export class ParticleSystem {
  n = 0;
  x = new Float32Array(0);
  y = new Float32Array(0);
  heightM = new Float32Array(0);
  speed = new Float32Array(0);
  level = new Uint8Array(0);
  age = new Float32Array(0);
  maxAge = new Float32Array(0);
  alive = new Uint8Array(0);
  /** time (s) a particle has moved too slowly to draw a tail */
  still = new Float32Array(0);
  /** Model grid cells: when set, particle i belongs to cell[i] and always respawns inside it. */
  cells: CellBounds[] | null = null;
  cell = new Int32Array(0);
  /** History in scene coords: trail[(p * TRAIL + k) * 3], k = 0 is the newest. */
  trail = new Float32Array(0);
  private uvw = new Float32Array(3);

  /**
   * `n` particles spread over the domain, or, with `cells`, one particle per cell and level
   * (a coarse model shows as few particles as it has grid points).
   */
  reset(n: number, levels: number[], ctx: AdvectionContext, cells: CellBounds[] | null = null): void {
    this.cells = cells;
    if (cells) n = cells.length * levels.length;
    this.n = n;
    this.cell = new Int32Array(n);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.heightM = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.level = new Uint8Array(n);
    this.age = new Float32Array(n);
    this.maxAge = new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.still = new Float32Array(n);
    this.trail = new Float32Array(n * TRAIL * 3);
    for (let i = 0; i < n; i++) {
      this.level[i] = levels[i % levels.length];
      this.cell[i] = Math.floor(i / levels.length);
      this.respawn(i, ctx);
      this.age[i] = Math.random() * this.maxAge[i]; // desynchronise lifetimes
    }
  }

  /** Is the particle's level above ground here? Returns the level height or NaN. */
  private validHeight(i: number, x: number, y: number, ctx: AdvectionContext): number {
    const { domain, wind, terrain, tw } = ctx;
    const lat = domain.lat(y);
    const lon = domain.lon(x);
    const h = wind.sample(wind.height, tw, this.level[i], lat, lon);
    return h > terrain.at(lat, lon) + GROUND_CLEARANCE ? h : NaN;
  }

  respawn(i: number, ctx: AdvectionContext): void {
    const { domain } = ctx;
    this.age[i] = 0;
    this.still[i] = 0;
    this.maxAge[i] = 2 + Math.random() * 4; // seconds
    const c = this.cells?.[this.cell[i]];
    for (let tries = 0; tries < 30; tries++) {
      const x = c ? c.x0 + Math.random() * (c.x1 - c.x0) : Math.random() * domain.width;
      const y = c ? c.y0 + Math.random() * (c.y1 - c.y0) : Math.random() * domain.depth;
      const h = this.validHeight(i, x, y, ctx);
      if (!Number.isNaN(h)) {
        this.x[i] = x;
        this.y[i] = y;
        this.heightM[i] = h;
        this.alive[i] = 1;
        this.fillTrail(i, ctx);
        return;
      }
    }
    this.alive[i] = 0; // level entirely below ground here; try again next frame
  }

  private fillTrail(i: number, ctx: AdvectionContext): void {
    const X = ctx.domain.sceneX(this.x[i]);
    const Y = (this.heightM[i] / 1000) * ctx.exaggeration;
    const Z = ctx.domain.sceneZ(this.y[i]);
    const base = i * TRAIL * 3;
    for (let k = 0; k < TRAIL; k++) {
      this.trail[base + k * 3] = X;
      this.trail[base + k * 3 + 1] = Y;
      this.trail[base + k * 3 + 2] = Z;
    }
  }

  /**
   * Track how long particle i, at height `z` (m) over ground `ground` (m), has sat near a
   * mountain top moving slower than STILL_FRAC of the domain per second (`kmPerSec`, in
   * scene km, vertical exaggerated), and once that passes STILL_TIME fade it
   * out within FADE_OUT. Its lifetime is rescaled so the fade continues from its current
   * brightness (the renderer fades by min(1, 3·age, 4·(1 − age/maxAge))).
   */
  private checkStill(i: number, kmPerSec: number, dtReal: number, z: number, ground: number, ctx: AdvectionContext): void {
    const { domain, terrain } = ctx;
    const nearTop = z - ground < NEAR_GROUND_M && ground > SUMMIT_FRAC * terrain.manifest.max;
    const slow = nearTop && kmPerSec < STILL_FRAC * Math.max(domain.width, domain.depth);
    this.still[i] = slow ? this.still[i] + dtReal : 0;
    const left = this.maxAge[i] - this.age[i];
    if (this.still[i] < STILL_TIME || left <= FADE_OUT) return;
    const f = Math.max(0.05, Math.min(1, this.age[i] * 3, (left / this.maxAge[i]) * 4));
    this.maxAge[i] = (4 * FADE_OUT) / f;
    this.age[i] = this.maxAge[i] - FADE_OUT;
  }

  step(dtReal: number, ctx: AdvectionContext): void {
    if (ctx.vertical && ctx.wind.w) {
      this.step3d(dtReal, ctx);
      return;
    }
    const { domain, wind, tw } = ctx;
    const dtKm = (dtReal * ctx.speedFactor) / 1000; // (m/s) * s -> km
    const tr = this.trail;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) {
        this.respawn(i, ctx);
        continue;
      }
      this.age[i] += dtReal;
      const lev = this.level[i];
      const lat = domain.lat(this.y[i]);
      const lon = domain.lon(this.x[i]);
      const u = wind.sample(wind.u, tw, lev, lat, lon);
      const v = wind.sample(wind.v, tw, lev, lat, lon);
      this.speed[i] = Math.sqrt(u * u + v * v);
      this.checkStill(i, (this.speed[i] * ctx.speedFactor) / 1000, dtReal, this.heightM[i], ctx.terrain.at(lat, lon), ctx);
      const nx = this.x[i] + u * dtKm;
      const ny = this.y[i] + v * dtKm;
      if (this.age[i] > this.maxAge[i] || !domain.contains(nx, ny)) {
        this.respawn(i, ctx);
        continue;
      }
      const h = this.validHeight(i, nx, ny, ctx);
      if (Number.isNaN(h)) {
        this.respawn(i, ctx); // flowed into terrain / masked region
        continue;
      }
      this.x[i] = nx;
      this.y[i] = ny;
      this.heightM[i] = h;
      // shift history and write the new head
      const base = i * TRAIL * 3;
      tr.copyWithin(base + 3, base, base + (TRAIL - 1) * 3);
      tr[base] = domain.sceneX(nx);
      tr[base + 1] = (h / 1000) * ctx.exaggeration;
      tr[base + 2] = domain.sceneZ(ny);
    }
  }
  /** P(t + dt) = P(t) + (u, v, w) dt, the height free and kept FLOOR_AGL above the ground. */
  private step3d(dtReal: number, ctx: AdvectionContext): void {
    const { domain, terrain } = ctx;
    const dt = dtReal * ctx.speedFactor; // simulated seconds
    const tr = this.trail;
    const uvw = this.uvw;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) {
        this.respawn(i, ctx);
        continue;
      }
      this.age[i] += dtReal;
      const lat = domain.lat(this.y[i]);
      const lon = domain.lon(this.x[i]);
      sampleColumn(ctx, lat, lon, this.heightM[i], terrain.at(lat, lon), uvw);
      this.speed[i] = Math.sqrt(uvw[0] * uvw[0] + uvw[1] * uvw[1]);
      const nx = this.x[i] + (uvw[0] * dt) / 1000;
      const ny = this.y[i] + (uvw[1] * dt) / 1000;
      if (this.age[i] > this.maxAge[i] || !domain.contains(nx, ny)) {
        this.respawn(i, ctx);
        continue;
      }
      const floor = terrain.at(domain.lat(ny), domain.lon(nx)) + FLOOR_AGL;
      // no higher than the top level: above it there is no data, only its wind held constant
      const ceiling = ctx.wind.manifest.variables.height.max;
      const h = Math.min(Math.max(this.heightM[i] + uvw[2] * dt, floor), Math.max(ceiling, floor));
      // the motion actually made (held at the floor: no sinking), vertical as drawn
      const rise = ((h - this.heightM[i]) / 1000) * ctx.exaggeration;
      const run = Math.hypot(nx - this.x[i], ny - this.y[i]);
      if (dtReal > 0) this.checkStill(i, Math.hypot(run, rise) / dtReal, dtReal, h, floor - FLOOR_AGL, ctx);
      this.x[i] = nx;
      this.y[i] = ny;
      this.heightM[i] = h;
      const base = i * TRAIL * 3;
      tr.copyWithin(base + 3, base, base + (TRAIL - 1) * 3);
      tr[base] = domain.sceneX(nx);
      tr[base + 1] = (h / 1000) * ctx.exaggeration;
      tr[base + 2] = domain.sceneZ(ny);
    }
  }
}
