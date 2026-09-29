import * as THREE from 'three';
import { colormapLinear } from '../colormap';
import { ParticleSystem, TRAIL } from '../wind/advection';

const SEGS = TRAIL - 1;

/** Fading streak lines + bright heads, colored by wind speed. */
export class ParticleRenderer {
  readonly group = new THREE.Group();
  private lines: THREE.LineSegments;
  private heads: THREE.Points;
  private capacity = 0;
  private rgb = new Float32Array(3);

  constructor() {
    this.lines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
    );
    this.heads = new THREE.Points(
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

  private ensure(n: number): void {
    if (n === this.capacity) return;
    this.capacity = n;
    const lg = this.lines.geometry;
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * SEGS * 2 * 3), 3));
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * SEGS * 2 * 4), 4));
    const hg = this.heads.geometry;
    hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    hg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  }

  update(ps: ParticleSystem, maxSpeed: number): void {
    const n = ps.n;
    this.ensure(n);
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
      const base = i * TRAIL * 3;
      colormapLinear(ps.speed[i] / maxSpeed, rgb);
      // fade in at birth and out at death
      const life = ps.age[i] / ps.maxAge[i];
      const fade = ps.alive[i] ? Math.min(1, ps.age[i] * 3, (1 - life) * 4) : 0;

      hp[i * 3] = tr[base];
      hp[i * 3 + 1] = tr[base + 1];
      hp[i * 3 + 2] = tr[base + 2];
      hc[i * 4] = rgb[0];
      hc[i * 4 + 1] = rgb[1];
      hc[i * 4 + 2] = rgb[2];
      hc[i * 4 + 3] = fade;

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
    this.heads.geometry.setDrawRange(0, n);
  }
}
