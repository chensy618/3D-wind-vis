import { Domain } from '../geo';
import { Terrain } from '../wind/loader';
import { AGL_M } from './overlays';

/** A rectangle of the domain (local km) that owns one particle: one grid cell. */
export interface Cell {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** The 10 m wind shown, on the terrain grid (blocky when it stands for coarser cells). */
export interface WindLayer {
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  nx: number;
  ny: number;
  /** grid spacing, km */
  dx: number;
  dy: number;
}

export interface SurfaceContext {
  wind: WindLayer;
  /** one particle per cell */
  cells: Cell[];
  terrain: Terrain;
  domain: Domain;
  /** simulated seconds per real second */
  speedFactor: number;
  exaggeration: number;
  /** stored positions per particle (trail length) */
  trailLen: number;
}

/** Wind at the grid point nearest to (x, y): no smoothing between grid points. */
export function nearest(field: Float32Array, wind: WindLayer, x: number, y: number): number {
  const i = Math.min(Math.max(Math.round(x / wind.dx), 0), wind.nx - 1);
  const j = Math.min(Math.max(Math.round(y / wind.dy), 0), wind.ny - 1);
  return field[j * wind.nx + i];
}

/**
 * One particle per grid cell, 10 m above the ground. A particle always respawns
 * inside its own cell and moves with the wind of the grid point it is nearest
 * to, so particle density and motion both show the grid's resolution. Following
 * the ground, the particles climb windward slopes and sink down lee slopes.
 */
export class SurfaceParticles {
  n = 0;
  trailLen = 12;
  x = new Float32Array(0);
  y = new Float32Array(0);
  speed = new Float32Array(0);
  w = new Float32Array(0);
  age = new Float32Array(0);
  maxAge = new Float32Array(0);
  alive = new Uint8Array(0);
  /** History in scene coords: trail[(p * trailLen + k) * 3], k = 0 is the newest. */
  trail = new Float32Array(0);

  reset(ctx: SurfaceContext): void {
    const n = ctx.cells.length;
    this.n = n;
    this.trailLen = ctx.trailLen;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.w = new Float32Array(n);
    this.age = new Float32Array(n);
    this.maxAge = new Float32Array(n);
    this.alive = new Uint8Array(n).fill(1);
    this.trail = new Float32Array(n * this.trailLen * 3);
    for (let i = 0; i < n; i++) {
      this.respawn(i, ctx);
      this.age[i] = Math.random() * this.maxAge[i]; // desynchronise lifetimes
    }
  }

  private sceneY(x: number, y: number, ctx: SurfaceContext): number {
    const h = ctx.terrain.at(ctx.domain.lat(y), ctx.domain.lon(x));
    return ((h + AGL_M) / 1000) * ctx.exaggeration;
  }

  private respawn(i: number, ctx: SurfaceContext): void {
    const { domain } = ctx;
    const c = ctx.cells[i];
    const x = c.x0 + Math.random() * (c.x1 - c.x0);
    const y = c.y0 + Math.random() * (c.y1 - c.y0);
    this.x[i] = x;
    this.y[i] = y;
    this.age[i] = 0;
    this.maxAge[i] = 2 + Math.random() * 4; // seconds
    const X = domain.sceneX(x);
    const Y = this.sceneY(x, y, ctx);
    const Z = domain.sceneZ(y);
    const L = this.trailLen;
    const base = i * L * 3;
    for (let k = 0; k < L; k++) {
      this.trail[base + k * 3] = X;
      this.trail[base + k * 3 + 1] = Y;
      this.trail[base + k * 3 + 2] = Z;
    }
  }

  step(dtReal: number, ctx: SurfaceContext): void {
    const { domain, wind } = ctx;
    const dtKm = (dtReal * ctx.speedFactor) / 1000; // (m/s) * s -> km
    const tr = this.trail;
    const L = this.trailLen;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dtReal;
      const x = this.x[i];
      const y = this.y[i];
      const u = nearest(wind.u, wind, x, y);
      const v = nearest(wind.v, wind, x, y);
      this.speed[i] = Math.hypot(u, v);
      this.w[i] = nearest(wind.w, wind, x, y);
      const nx = x + u * dtKm;
      const ny = y + v * dtKm;
      if (this.age[i] > this.maxAge[i] || !domain.contains(nx, ny)) {
        this.respawn(i, ctx);
        continue;
      }
      this.x[i] = nx;
      this.y[i] = ny;
      const base = i * L * 3;
      tr.copyWithin(base + 3, base, base + (L - 1) * 3);
      tr[base] = domain.sceneX(nx);
      tr[base + 1] = this.sceneY(nx, ny, ctx);
      tr[base + 2] = domain.sceneZ(ny);
    }
  }
}
