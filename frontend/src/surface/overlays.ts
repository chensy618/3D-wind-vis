import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Domain } from '../geo';
import { Terrain } from '../wind/loader';
import { SurfaceWindModel } from './model';

/** Height above ground (m) the grid overlay is drawn at. */
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

/** Append a straight line from (x0, y0) to (x1, y1) km, draped AGL_M above the terrain, as segments. */
function drapedLine(pts: number[], x0: number, y0: number, x1: number, y1: number, terrain: Terrain, domain: Domain, exaggeration: number): void {
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
}

/**
 * Grid lines draped 10 m above the terrain: either the terrain grid the
 * terrain response is computed on (256 × 256, ~200 m), or the wind model's own
 * lat/lon grid (spacing `deg`, points on multiples of it) with its
 * grid points, which shows how few model points cover Senja.
 */
export class GridOverlay {
  readonly group = new THREE.Group();

  /** `model` is only needed for the terrain grid; `lineWidth` (px) above 1 draws thick lines. */
  build(
    kind: GridKind,
    deg: number,
    modelName: string,
    model: SurfaceWindModel | null,
    terrain: Terrain,
    domain: Domain,
    exaggeration: number,
    lineWidth = 1,
  ): void {
    disposeGroup(this.group);
    const pts: number[] = [];
    const line = (x0: number, y0: number, x1: number, y1: number) => drapedLine(pts, x0, y0, x1, y1, terrain, domain, exaggeration);
    const W = domain.width;
    const D = domain.depth;

    if (kind === 'terrain') {
      if (!model) throw new Error('the terrain grid needs the surface wind model');
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

    const color = kind === 'native' ? 0xffd166 : 0xe8f0fa;
    const opacity = kind === 'native' ? 0.9 : 0.28;
    if (lineWidth > 1) {
      const g = new LineSegmentsGeometry().setPositions(pts);
      this.group.add(new LineSegments2(g, new LineMaterial({ color, linewidth: lineWidth, transparent: true, opacity, depthWrite: false })));
      return;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })));
  }

  /** Lines every `spacing` km from the domain's SW corner, plus the domain outline, draped 10 m above the terrain. */
  buildRegular(spacing: number, terrain: Terrain, domain: Domain, exaggeration: number): void {
    disposeGroup(this.group);
    const pts: number[] = [];
    const line = (x0: number, y0: number, x1: number, y1: number) => drapedLine(pts, x0, y0, x1, y1, terrain, domain, exaggeration);
    const W = domain.width;
    const D = domain.depth;
    for (let x = spacing; x < W - 1e-6; x += spacing) line(x, 0, x, D);
    for (let y = spacing; y < D - 1e-6; y += spacing) line(0, y, W, y);
    line(0, 0, W, 0);
    line(W, 0, W, D);
    line(W, D, 0, D);
    line(0, D, 0, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.group.add(
      new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.35, depthWrite: false })),
    );
  }
}
