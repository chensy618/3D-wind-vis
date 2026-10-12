import * as THREE from 'three';
import { colormapLinear } from '../colormap';
import { TRAIL } from '../wind/advection';

/** What the renderer reads from a particle system (trail k = 0 is the newest position). */
export interface ParticleTrails {
  n: number;
  /** stored positions per particle; TRAIL when omitted */
  trailLen?: number;
  trail: Float32Array;
  speed: Float32Array;
  age: Float32Array;
  maxAge: Float32Array;
  alive: Uint8Array;
}

/**
 * Fading streak lines + bright heads, colored by wind speed unless `color` is given. With
 * `arrows`, each particle is instead a "--->" arrow (shaft and two barbs, in the horizontal
 * plane) pointing along its motion, and the streak lines are hidden.
 */
export class ParticleRenderer {
  readonly group = new THREE.Group();
  private lines: THREE.LineSegments;
  private heads: THREE.Points | THREE.LineSegments;
  /** vertices per head: 1 (point) or 6 (arrow: shaft + two barbs) */
  private hv: number;
  private capacity = 0;
  private segs = 0;
  private rgb = new Float32Array(3);
  /** arrow length, scene km */
  private arrow = 0.3;
  /** last horizontal direction per particle, kept while it does not move */
  private dir = new Float32Array(0);

  constructor(private readonly arrows = false) {
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
    );
    this.hv = arrows ? 6 : 1;
    this.lines.visible = !arrows;
    this.heads = arrows
      ? new THREE.LineSegments(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
        )
      : new THREE.Points(
          new THREE.BufferGeometry(),
          new THREE.PointsMaterial({
            size: 2.5,
            sizeAttenuation: false,
            vertexColors: true,
            transparent: true,
            depthWrite: false,
          }),
        );
    this.lines.frustumCulled = false;
    this.heads.frustumCulled = false;
    this.group.add(this.lines, this.heads);
    this.group.name = 'particles';
  }

  /** Arrow length in scene km (horizontal, so not stretched by the vertical exaggeration). */
  setArrowSize(km: number): void {
    this.arrow = km;
  }

  private ensure(n: number, segs: number): void {
    if (n === this.capacity && segs === this.segs) return;
    this.capacity = n;
    this.segs = segs;
    const lg = this.lines.geometry;
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * segs * 2 * 3), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * segs * 2 * 4), 4));
    const hg = this.heads.geometry;
    hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * this.hv * 3), 3));
    hg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * this.hv * 4), 4));
    this.dir = new Float32Array(n * 2);
  }

  update(ps: ParticleTrails, maxSpeed: number, color?: (i: number, out: Float32Array) => void): void {
    const n = ps.n;
    const len = ps.trailLen ?? TRAIL;
    const SEGS = len - 1;
    this.ensure(n, SEGS);
    const lpos = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    const lcol = this.lines.geometry.getAttribute('color') as THREE.BufferAttribute;
    const hpos = this.heads.geometry.getAttribute('position') as THREE.BufferAttribute;
    const hcol = this.heads.geometry.getAttribute('color') as THREE.BufferAttribute;
    const lp = lpos.array as Float32Array;
    const lc = lcol.array as Float32Array;
    const hp = hpos.array as Float32Array;
    const hc = hcol.array as Float32Array;
    const tr = ps.trail;
    const rgb = this.rgb;

    for (let i = 0; i < n; i++) {
      const base = i * len * 3;
      if (color) color(i, rgb);
      else colormapLinear(ps.speed[i] / maxSpeed, rgb);
      // fade in at birth and out at death
      const life = ps.age[i] / ps.maxAge[i];
      const fade = ps.alive[i] ? Math.min(1, ps.age[i] * 3, (1 - life) * 4) : 0;

      if (this.arrows) {
        this.arrowHead(i, tr, base, rgb, fade, hp, hc);
      } else {
        hp[i * 3] = tr[base];
        hp[i * 3 + 1] = tr[base + 1];
        hp[i * 3 + 2] = tr[base + 2];
        hc[i * 4] = rgb[0];
        hc[i * 4 + 1] = rgb[1];
        hc[i * 4 + 2] = rgb[2];
        hc[i * 4 + 3] = fade;
      }

      for (let s = 0; s < SEGS; s++) {
        const v = (i * SEGS + s) * 2;
        const a = base + s * 3;
        lp[v * 3] = tr[a];
        lp[v * 3 + 1] = tr[a + 1];
        lp[v * 3 + 2] = tr[a + 2];
        lp[v * 3 + 3] = tr[a + 3];
        lp[v * 3 + 4] = tr[a + 4];
        lp[v * 3 + 5] = tr[a + 5];
        const a0 = fade * (1 - s / SEGS);
        const a1 = fade * (1 - (s + 1) / SEGS);
        const c = v * 4;
        lc[c] = lc[c + 4] = rgb[0];
        lc[c + 1] = lc[c + 5] = rgb[1];
        lc[c + 2] = lc[c + 6] = rgb[2];
        lc[c + 3] = a0;
        lc[c + 7] = a1;
      }
    }
    lpos.needsUpdate = true;
    lcol.needsUpdate = true;
    hpos.needsUpdate = true;
    hcol.needsUpdate = true;
    this.lines.geometry.setDrawRange(0, n * SEGS * 2);
    this.heads.geometry.setDrawRange(0, n * this.hv);
  }

  /** "--->" with its tip at the head, pointing from the previous position (scene x, z plane). */
  private arrowHead(i: number, tr: Float32Array, base: number, rgb: Float32Array, fade: number, hp: Float32Array, hc: Float32Array): void {
    const ddx = tr[base] - tr[base + 3];
    const ddz = tr[base + 2] - tr[base + 5];
    const dl = Math.hypot(ddx, ddz);
    if (dl > 1e-9) {
      this.dir[i * 2] = ddx / dl;
      this.dir[i * 2 + 1] = ddz / dl;
    }
    const dx = this.dir[i * 2];
    const dz = this.dir[i * 2 + 1];
    const L = this.arrow;
    const B = 0.3 * L; // barb length
    const tx = tr[base];
    const y = tr[base + 1];
    const tz = tr[base + 2];
    // barbs at +-30 degrees from the reversed direction
    const c30 = 0.866 * B;
    const s30 = 0.5 * B;
    const pts = [
      tx - dx * L, tz - dz * L, tx, tz, // shaft
      tx, tz, tx - dx * c30 - dz * s30, tz - dz * c30 + dx * s30, // barb
      tx, tz, tx - dx * c30 + dz * s30, tz - dz * c30 - dx * s30, // barb
    ];
    const alpha = dx === 0 && dz === 0 ? 0 : fade; // no direction yet
    for (let k = 0; k < 6; k++) {
      const p = (i * 6 + k) * 3;
      hp[p] = pts[k * 2];
      hp[p + 1] = y;
      hp[p + 2] = pts[k * 2 + 1];
      const c = (i * 6 + k) * 4;
      hc[c] = rgb[0];
      hc[c + 1] = rgb[1];
      hc[c + 2] = rgb[2];
      hc[c + 3] = alpha;
    }
  }
}
