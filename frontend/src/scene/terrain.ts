import * as THREE from 'three';
import { Domain } from '../geo';
import { srgbToLinear } from '../colormap';
import { Terrain } from '../wind/loader';

// Hypsometric tint (sRGB), elevation in metres
const WATER: [number, number, number] = [0x1b, 0x3a, 0x57];
const LAND: [number, [number, number, number]][] = [
  [0, [0x4f, 0x6f, 0x46]],
  [150, [0x6f, 0x86, 0x55]],
  [400, [0x9a, 0x94, 0x6c]],
  [700, [0xb9, 0xae, 0x98]],
  [950, [0xee, 0xee, 0xf0]],
];

function landColor(h: number, out: number[]): void {
  let i = 0;
  while (i < LAND.length - 2 && h > LAND[i + 1][0]) i++;
  const [h0, c0] = LAND[i];
  const [h1, c1] = LAND[i + 1];
  const a = Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
  for (let k = 0; k < 3; k++) out[k] = srgbToLinear((c0[k] + (c1[k] - c0[k]) * a) / 255);
}

/** Hypsometric colour (linear RGB) for an elevation in metres; below 0.5 m is water. */
export function terrainColor(h: number, out: number[]): void {
  if (h < 0.5) {
    for (let q = 0; q < 3; q++) out[q] = srgbToLinear(WATER[q] / 255);
  } else {
    landColor(h, out);
  }
}

/**
 * Terrain mesh in km; vertical exaggeration is applied through mesh.scale.y so
 * it can change without rebuilding the geometry.
 */
export function buildTerrainMesh(terrain: Terrain, domain: Domain): THREE.Mesh {
  const { ny, nx, elevation } = terrain;
  const pos = new Float32Array(ny * nx * 3);
  const col = new Float32Array(ny * nx * 3);
  const c = [0, 0, 0];
  const lat = terrain.manifest.lat;
  const lon = terrain.manifest.lon;
  for (let j = 0; j < ny; j++) {
    const z = domain.sceneZ(domain.localY(lat[j]));
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const h = elevation[k];
      pos[k * 3] = domain.sceneX(domain.localX(lon[i]));
      pos[k * 3 + 1] = h / 1000;
      pos[k * 3 + 2] = z;
      terrainColor(h, c);
      col.set(c, k * 3);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const d = a + nx;
      const e = d + 1;
      // counter-clockwise when viewed from above (+Y), Z points south
      idx.push(a, b, e, a, e, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    flatShading: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'terrain';
  return mesh;
}

/** Thin base plate and domain outline so the box reads as a volume. */
export function buildDomainFrame(domain: Domain, topKm: number): THREE.LineSegments {
  const w = domain.width / 2;
  const d = domain.depth / 2;
  const pts = [
    [-w, 0, -d], [w, 0, -d], [w, 0, -d], [w, 0, d], [w, 0, d], [-w, 0, d], [-w, 0, d], [-w, 0, -d],
    [-w, 0, -d], [-w, topKm, -d], [w, 0, -d], [w, topKm, -d], [w, 0, d], [w, topKm, d], [-w, 0, d], [-w, topKm, d],
    [-w, topKm, -d], [w, topKm, -d], [w, topKm, -d], [w, topKm, d], [w, topKm, d], [-w, topKm, d], [-w, topKm, d], [-w, topKm, -d],
  ].flat();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.LineBasicMaterial({ color: 0x8aa0b8, transparent: true, opacity: 0.25 });
  const lines = new THREE.LineSegments(g, m);
  lines.name = 'domain-frame';
  return lines;
}
