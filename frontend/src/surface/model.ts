import { Domain } from '../geo';
import { bilinear } from '../wind/interpolation';
import { Terrain } from '../wind/loader';

/** Upwind distance (km) searched for sheltering terrain. */
const FETCH_KM = 3;
/** Upwind terrain slope (rise / run) that gives full sheltering. */
const FULL_SHELTER = 0.3;

export interface SurfaceParams {
  /** Depth of the flowing layer above the highest summit, m. Shallow = stable, flow goes around. */
  layerDepth: number;
  /** Largest speed reduction in deep lee, 0..1. */
  shelter: number;
}

/** A model's 10 m wind interpolated to the model grid. */
export interface Background {
  u: Float32Array;
  v: Float32Array;
}

function gradient(f: Float32Array, nx: number, ny: number, dx: number, dy: number, gx: Float32Array, gy: Float32Array): void {
  for (let j = 0; j < ny; j++) {
    const jS = Math.max(j - 1, 0);
    const jN = Math.min(j + 1, ny - 1);
    for (let i = 0; i < nx; i++) {
      const iW = Math.max(i - 1, 0);
      const iE = Math.min(i + 1, nx - 1);
      const k = j * nx + i;
      gx[k] = (f[j * nx + iE] - f[j * nx + iW]) / ((iE - iW) * dx);
      gy[k] = (f[jN * nx + i] - f[jS * nx + i]) / ((jN - jS) * dy);
    }
  }
}

/**
 * Red-black SOR for sum_n a_n (phi_n - phi_c) = rhs, phi = 0 on the boundary.
 * Stops when the residual falls below `tol` relative to the right-hand side.
 */
function sor(
  phi: Float32Array,
  rhs: Float32Array,
  a: { e: Float32Array; w: Float32Array; n: Float32Array; s: Float32Array; c: Float32Array },
  nx: number,
  ny: number,
  tol = 1e-4,
  maxIters = 6000,
): number {
  const omega = 2 / (1 + Math.sin(Math.PI / Math.max(nx, ny)));
  const { e, w, n, s, c } = a;
  let rhsNorm = 0;
  for (let k = 0; k < rhs.length; k++) rhsNorm += Math.abs(rhs[k]);
  if (rhsNorm === 0) return 0;
  for (let it = 1; it <= maxIters; it++) {
    for (let color = 0; color < 2; color++) {
      for (let j = 1; j < ny - 1; j++) {
        const row = j * nx;
        for (let i = 1 + ((j + color) & 1); i < nx - 1; i += 2) {
          const k = row + i;
          const sum = e[k] * phi[k + 1] + w[k] * phi[k - 1] + n[k] * phi[k + nx] + s[k] * phi[k - nx];
          phi[k] += omega * ((sum - rhs[k]) / c[k] - phi[k]);
        }
      }
    }
    if (it % 25 === 0) {
      let res = 0;
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const k = j * nx + i;
          const sum = e[k] * phi[k + 1] + w[k] * phi[k - 1] + n[k] * phi[k + nx] + s[k] * phi[k - nx];
          res += Math.abs(sum - c[k] * phi[k] - rhs[k]);
        }
      }
      if (res < tol * rhsNorm) return it;
    }
  }
  return maxIters;
}

/**
 * Terrain-adjusted 10 m wind from a model's coarse 10 m wind (the background).
 *
 * 1. Layer flow. Air in a layer between the ground h and a lid at height `top`
 *    (a stable layer / inversion) conserves mass, ∇·((top − h) V) = 0, and stays
 *    irrotational, V = V0 + ∇φ. Where the layer is thin (over mountains) the flow
 *    speeds up across crests and is partly pushed around the mountain; a shallow
 *    layer (stable air) blocks more. The problem is linear in V0, so it is solved
 *    once for V0 = east and once for V0 = north, and each cell mixes the two with
 *    its local background wind. That is a good approximation when the background
 *    varies over tens of km and the terrain over one km.
 * 2. Lee sheltering. The steepest upwind terrain angle within 3 km (Winstral Sx)
 *    reduces the speed behind ridges.
 * 3. Vertical wind. Air at the ground follows the terrain, so w = V·∇h:
 *    positive (rising) on windward slopes, negative (sinking) on lee slopes.
 */
export class SurfaceWindModel {
  readonly nx: number;
  readonly ny: number;
  /** Grid spacing, km. */
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly depth: number;
  /** Terrain (m), the terrain grid itself. */
  readonly h: Float32Array;
  /** Terrain gradient, m per m. */
  readonly hx: Float32Array;
  readonly hy: Float32Array;
  /** Height of the layer top, m above sea level. */
  top = 0;

  /** 10 m wind (m/s). */
  readonly u: Float32Array;
  readonly v: Float32Array;
  readonly speed: Float32Array;
  /** Vertical wind at 10 m, w = V10·∇h (m/s). */
  readonly w: Float32Array;
  /** Layer wind (above the surface layer, no sheltering). */
  readonly layerU: Float32Array;
  readonly layerV: Float32Array;
  /** Terrain speed-up: |layer wind| × sheltering / background speed. */
  readonly ratio: Float32Array;
  /** Lee sheltering factor, 1 = exposed. */
  readonly shelterF: Float32Array;
  /** Background wind in each cell (m/s). */
  readonly bgU: Float32Array;
  readonly bgV: Float32Array;

  private readonly terrainMax: number;
  private readonly phiX: Float32Array;
  private readonly phiY: Float32Array;
  // layer wind for unit background wind towards east (ex*) and north (ey*)
  private readonly exU: Float32Array;
  private readonly exV: Float32Array;
  private readonly eyU: Float32Array;
  private readonly eyV: Float32Array;
  private solvedDepth = NaN;
  /** SOR sweeps used by the last solve (both directions), for diagnostics. */
  iterations = 0;

  /** Computed on the terrain grid itself, so wind and terrain share one resolution. */
  constructor(terrain: Terrain, domain: Domain) {
    const { nx, ny } = terrain;
    this.nx = nx;
    this.ny = ny;
    this.width = domain.width;
    this.depth = domain.depth;
    this.dx = domain.width / (nx - 1);
    this.dy = domain.depth / (ny - 1);
    const alloc = () => new Float32Array(nx * ny);
    this.h = alloc();
    this.hx = alloc();
    this.hy = alloc();
    this.u = alloc();
    this.v = alloc();
    this.speed = alloc();
    this.w = alloc();
    this.layerU = alloc();
    this.layerV = alloc();
    this.ratio = alloc();
    this.shelterF = alloc();
    this.bgU = alloc();
    this.bgV = alloc();
    this.phiX = alloc();
    this.phiY = alloc();
    this.exU = alloc();
    this.exV = alloc();
    this.eyU = alloc();
    this.eyV = alloc();
    this.terrainMax = terrain.manifest.max;

    this.h.set(terrain.elevation);
    gradient(this.h, nx, ny, this.dx * 1000, this.dy * 1000, this.hx, this.hy);
  }

  /** Bilinear sample of a model field at local (x, y) km. */
  sample(field: Float32Array, x: number, y: number): number {
    return bilinear(field, 0, this.ny, this.nx, y / this.dy, x / this.dx);
  }

  update(p: SurfaceParams, bg: Background): void {
    if (p.layerDepth !== this.solvedDepth) this.solve(p.layerDepth);
    this.bgU.set(bg.u);
    this.bgV.set(bg.v);
    this.computeShelter(p.shelter);
    for (let k = 0; k < this.h.length; k++) {
      const U0 = this.bgU[k];
      const V0 = this.bgV[k];
      const lu = U0 * this.exU[k] + V0 * this.eyU[k];
      const lv = U0 * this.exV[k] + V0 * this.eyV[k];
      this.layerU[k] = lu;
      this.layerV[k] = lv;
      const sh = this.shelterF[k];
      const u = lu * sh;
      const v = lv * sh;
      this.u[k] = u;
      this.v[k] = v;
      this.speed[k] = Math.hypot(u, v);
      this.w[k] = u * this.hx[k] + v * this.hy[k];
      const s0 = Math.hypot(U0, V0);
      this.ratio[k] = s0 > 0.1 ? (Math.hypot(lu, lv) * sh) / s0 : 1;
    }
  }

  private solve(layerDepth: number): void {
    const { nx, ny, dx, dy, h } = this;
    this.top = this.terrainMax + layerDepth;
    const N = nx * ny;
    const K = new Float32Array(N);
    for (let k = 0; k < N; k++) K[k] = this.top - h[k];
    const a = { e: new Float32Array(N), w: new Float32Array(N), n: new Float32Array(N), s: new Float32Array(N), c: new Float32Array(N) };
    const ix2 = 1 / (dx * dx);
    const iy2 = 1 / (dy * dy);
    const rhsX = new Float32Array(N);
    const rhsY = new Float32Array(N);
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i;
        a.e[k] = 0.5 * (K[k] + K[k + 1]) * ix2;
        a.w[k] = 0.5 * (K[k] + K[k - 1]) * ix2;
        a.n[k] = 0.5 * (K[k] + K[k + nx]) * iy2;
        a.s[k] = 0.5 * (K[k] + K[k - nx]) * iy2;
        a.c[k] = a.e[k] + a.w[k] + a.n[k] + a.s[k];
        // ∇·(K∇φ) = −∇·(K e) = e·∇h, h in m and distances in km as in K∇φ
        rhsX[k] = this.hx[k] * 1000;
        rhsY[k] = this.hy[k] * 1000;
      }
    }
    // later solves start from the previous depth's solution
    this.iterations = sor(this.phiX, rhsX, a, nx, ny) + sor(this.phiY, rhsY, a, nx, ny);
    gradient(this.phiX, nx, ny, dx, dy, this.exU, this.exV);
    gradient(this.phiY, nx, ny, dx, dy, this.eyU, this.eyV);
    for (let k = 0; k < N; k++) {
      this.exU[k] += 1;
      this.eyV[k] += 1;
    }
    this.solvedDepth = layerDepth;
  }

  /** Lee sheltering in each cell, looking upwind along its own background wind. */
  private computeShelter(strength: number): void {
    const { nx, ny, dx, dy, h } = this;
    const steps = Math.ceil(FETCH_KM / Math.min(dx, dy));
    const step = FETCH_KM / steps;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const s0 = Math.hypot(this.bgU[k], this.bgV[k]);
        if (s0 < 1e-6 || strength === 0) {
          this.shelterF[k] = 1;
          continue;
        }
        const wx = this.bgU[k] / s0;
        const wy = this.bgV[k] / s0;
        const x = i * dx;
        const y = j * dy;
        let m = 0;
        for (let q = 1; q <= steps; q++) {
          const d = q * step;
          const t = (this.sample(h, x - d * wx, y - d * wy) - h[k]) / (d * 1000);
          if (t > m) m = t;
        }
        this.shelterF[k] = 1 - strength * Math.min(1, m / FULL_SHELTER);
      }
    }
  }
}
