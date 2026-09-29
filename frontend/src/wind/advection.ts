import { Domain } from '../geo';
import { TimeWeights } from './interpolation';
import { Terrain, WindField } from './loader';

/** Number of stored positions per particle (trail length in frames). */
export const TRAIL = 12;

/** Particles stay this far (m) above the terrain; otherwise the level is below ground. */
const GROUND_CLEARANCE = 30;

export interface AdvectionContext {
  wind: WindField;
  terrain: Terrain;
  domain: Domain;
  tw: TimeWeights;
  /** simulated seconds per real second (visual flow speed, decoupled from forecast time) */
  speedFactor: number;
  exaggeration: number;
}

/**
 * Particle state in local km coordinates.  P(t + dt) = P(t) + V(P) dt with
 * V = (u, v, 0) for the multi-level (u, v) models. The vertical position is the
 * geopotential height of the particle's level at its current location.
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
  /** History in scene coords: trail[(p * TRAIL + k) * 3], k = 0 is the newest. */
  trail = new Float32Array(0);

  reset(n: number, levels: number[], ctx: AdvectionContext): void {
    this.n = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.heightM = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.level = new Uint8Array(n);
    this.age = new Float32Array(n);
    this.maxAge = new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.trail = new Float32Array(n * TRAIL * 3);
    for (let i = 0; i < n; i++) {
      this.level[i] = levels[i % levels.length];
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
    this.maxAge[i] = 2 + Math.random() * 4; // seconds
    for (let tries = 0; tries < 30; tries++) {
      const x = Math.random() * domain.width;
      const y = Math.random() * domain.depth;
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

  step(dtReal: number, ctx: AdvectionContext): void {
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
}
