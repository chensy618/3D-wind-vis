import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { colormapLinear } from '../colormap';
import { Domain } from '../geo';
import { Terrain } from '../wind/loader';
import { SurfaceWindModel } from './model';

/** Height above ground (m) of the 10 m wind; particles, arrows and grids are drawn there. */
export const AGL_M = 10;
/** native: the wind model's own lat/lon grid. terrain: the terrain grid. */
export type GridKind = 'native' | 'terrain';

/** Scene Y of a point AGL_M above the ground. */
function drapeY(terrain: Terrain, domain: Domain, x: number, y: number, exaggeration: number): number {
  return ((terrain.at(domain.lat(y), domain.lon(x)) + AGL_M) / 1000) * exaggeration;
}

function label(text: string, cls: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = `label3d ${cls}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

function disposeGroup(g: THREE.Group): void {
  g.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove();
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    (m.material as THREE.Material | undefined)?.dispose();
  });
  g.clear();
}

/**
 * Grid lines draped 10 m above the terrain: either the terrain grid the
 * terrain response is computed on (256 × 256, ~200 m), or the wind model's own
 * lat/lon grid (spacing `deg`, points on multiples of it) with its
 * grid points, which shows how few model points cover Senja.
 */
export class GridOverlay {
  readonly group = new THREE.Group();

  build(kind: GridKind, deg: number, modelName: string, model: SurfaceWindModel, terrain: Terrain, domain: Domain, exaggeration: number): void {
    disposeGroup(this.group);
    const pts: number[] = [];
    const line = (x0: number, y0: number, x1: number, y1: number) => {
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.15));
      let px = domain.sceneX(x0);
      let py = drapeY(terrain, domain, x0, y0, exaggeration);
      let pz = domain.sceneZ(y0);
      for (let k = 1; k <= n; k++) {
        const x = x0 + ((x1 - x0) * k) / n;
        const y = y0 + ((y1 - y0) * k) / n;
        const qx = domain.sceneX(x);
        const qy = drapeY(terrain, domain, x, y, exaggeration);
        const qz = domain.sceneZ(y);
        pts.push(px, py, pz, qx, qy, qz);
        px = qx;
        py = qy;
        pz = qz;
      }
    };
    const W = domain.width;
    const D = domain.depth;

    if (kind === 'terrain') {
      for (let i = 0; i < model.nx; i++) line(i * model.dx, 0, i * model.dx, D);
      for (let j = 0; j < model.ny; j++) line(0, j * model.dy, W, j * model.dy);
    } else {
      // cell edges halfway between grid points, plus the domain outline
      const half = deg / 2;
      for (let lon = Math.ceil((domain.lonMin - half) / deg) * deg + half; lon < domain.lonMax; lon += deg) {
        if (lon > domain.lonMin) line(domain.localX(lon), 0, domain.localX(lon), D);
      }
      for (let lat = Math.ceil((domain.latMin - half) / deg) * deg + half; lat < domain.latMax; lat += deg) {
        if (lat > domain.latMin) line(0, domain.localY(lat), W, domain.localY(lat));
      }
      line(0, 0, W, 0);
      line(W, 0, W, D);
      line(W, D, 0, D);
      line(0, D, 0, 0);
      const nodes: number[] = [];
      let tagged = false;
      for (let lat = Math.ceil(domain.latMin / deg) * deg; lat <= domain.latMax; lat += deg) {
        for (let lon = Math.ceil(domain.lonMin / deg) * deg; lon <= domain.lonMax; lon += deg) {
          const x = domain.localX(lon);
          const y = domain.localY(lat);
          const p = [domain.sceneX(x), drapeY(terrain, domain, x, y, exaggeration), domain.sceneZ(y)];
          nodes.push(...p);
          if (!tagged && lon > domain.lonMin + deg) {
            const l = label(`${modelName} grid point (${lat.toFixed(2)}° N, ${lon.toFixed(2)}° E)`, 'grid');
            l.position.set(p[0], p[1], p[2]);
            l.center.set(-0.05, 1.2);
            this.group.add(l);
            tagged = true;
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(nodes, 3));
      this.group.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffd166, size: 9, sizeAttenuation: false })));
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(
      g,
      new THREE.LineBasicMaterial({
        color: kind === 'native' ? 0xffd166 : 0xe8f0fa,
        transparent: true,
        opacity: kind === 'native' ? 0.9 : 0.28,
        depthWrite: false,
      }),
    );
    this.group.add(lines);
  }
}

/** One wind arrow at (x, y) km. */
export interface ArrowPoint {
  x: number;
  y: number;
  u: number;
  v: number;
}

/** 10 m wind arrows draped 10 m above the ground; the fastest is about `spacing` km long. */
export class ArrowField {
  readonly group = new THREE.Group();

  build(points: ArrowPoint[], spacing: number, terrain: Terrain, domain: Domain, exaggeration: number, maxSpeed: number, white: boolean): void {
    disposeGroup(this.group);
    const pos: number[] = [];
    const col: number[] = [];
    const rgb = [0, 0, 0];
    const kmPerMs = (spacing * 0.95) / maxSpeed;
    const push = (x: number, y: number) =>
      pos.push(domain.sceneX(x), drapeY(terrain, domain, x, y, exaggeration), domain.sceneZ(y));
    for (const { x: x0, y: y0, u, v } of points) {
      const s = Math.hypot(u, v);
      if (s < 0.05) continue;
      const x1 = x0 + u * kmPerMs;
      const y1 = y0 + v * kmPerMs;
      const hl = Math.min(0.35 * s * kmPerMs, 0.35 * spacing); // arrowhead length, km
      const ux = u / s;
      const uy = v / s;
      const c = Math.cos(0.45);
      const sn = Math.sin(0.45);
      push(x0, y0);
      push(x1, y1);
      push(x1, y1);
      push(x1 - hl * (ux * c - uy * sn), y1 - hl * (uy * c + ux * sn));
      push(x1, y1);
      push(x1 - hl * (ux * c + uy * sn), y1 - hl * (uy * c - ux * sn));
      if (white) rgb[0] = rgb[1] = rgb[2] = 1;
      else colormapLinear(s / maxSpeed, rgb);
      for (let q = 0; q < 6; q++) col.push(rgb[0], rgb[1], rgb[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true })));
  }
}

/** Marks the inspected point: a stick from the ground to 10 m (exaggerated with the terrain) and a label. */
export class TenMetreMarker {
  readonly group = new THREE.Group();

  set(terrain: Terrain, domain: Domain, x: number, y: number, exaggeration: number): void {
    disposeGroup(this.group);
    const X = domain.sceneX(x);
    const Z = domain.sceneZ(y);
    const ground = (terrain.at(domain.lat(y), domain.lon(x)) / 1000) * exaggeration;
    const top = drapeY(terrain, domain, x, y, exaggeration);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([X, ground, Z, X, top + 0.6, Z], 3));
    this.group.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff })));
    const dot = new THREE.BufferGeometry();
    dot.setAttribute('position', new THREE.Float32BufferAttribute([X, top, Z], 3));
    this.group.add(new THREE.Points(dot, new THREE.PointsMaterial({ color: 0xffffff, size: 8, sizeAttenuation: false })));
    const l = label(`● 10 m above ground · ${Math.round(terrain.at(domain.lat(y), domain.lon(x)) + AGL_M)} m a.s.l.`, 'ten');
    l.position.set(X, top + 0.6, Z);
    l.center.set(0, 1);
    this.group.add(l);
  }

  hide(): void {
    disposeGroup(this.group);
  }
}
