import * as THREE from 'three';
import { colormapLinear } from '../colormap';
import { Domain } from '../geo';
import { TimeWeights } from '../wind/interpolation';
import { Terrain, WindField } from '../wind/loader';
import { SURFACE_ASL_M } from '../wind/advection';

/**
 * Translucent surface following the geopotential height of one pressure
 * level, colored by wind speed. Parts below the terrain are hidden.
 */
export class LevelSurface {
  readonly mesh: THREE.Mesh;
  private readonly wind: WindField;

  constructor(wind: WindField, domain: Domain) {
    this.wind = wind;
    const { ny, nx } = wind;
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(ny * nx * 3);
    const lat = wind.manifest.lat;
    const lon = wind.manifest.lon;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (j * nx + i) * 3;
        pos[k] = domain.sceneX(domain.localX(lon[i]));
        pos[k + 2] = domain.sceneZ(domain.localY(lat[j]));
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        idx.push(a, a + 1, a + nx + 1, a, a + nx + 1, a + nx);
      }
    }
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ny * nx * 4), 4));
    geom.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.name = 'level-surface';
    this.mesh.renderOrder = -1;
  }

  update(level: number, tw: TimeWeights, terrain: Terrain, exaggeration: number, maxSpeed: number, opacity: number): void {
    const { ny, nx } = this.wind;
    const pos = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    const c = col.array as Float32Array;
    const lat = this.wind.manifest.lat;
    const lon = this.wind.manifest.lon;
    const rgb = new Float32Array(3);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const h = this.wind.sample(this.wind.height, tw, level, lat[j], lon[i]);
        const s = this.wind.sample(this.wind.speed, tw, level, lat[j], lon[i]);
        p[k * 3 + 1] = (h / 1000) * exaggeration;
        colormapLinear(s / maxSpeed, rgb);
        c[k * 4] = rgb[0];
        c[k * 4 + 1] = rgb[1];
        c[k * 4 + 2] = rgb[2];
        c[k * 4 + 3] = h > terrain.at(lat[j], lon[i]) ? opacity : 0;
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
  }
}

/**
 * Translucent flat surface at SURFACE_ASL_M, coloured by the dataset's own 10 m wind speed, like the
 * other levels. Parts below the terrain are hidden.
 */
export class SurfaceLayer {
  readonly mesh: THREE.Mesh;

  constructor(terrain: Terrain, domain: Domain) {
    const { ny, nx } = terrain;
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(ny * nx * 3);
    const lat = terrain.manifest.lat;
    const lon = terrain.manifest.lon;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (j * nx + i) * 3;
        pos[k] = domain.sceneX(domain.localX(lon[i]));
        pos[k + 2] = domain.sceneZ(domain.localY(lat[j]));
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        idx.push(a, a + 1, a + nx + 1, a, a + nx + 1, a + nx);
      }
    }
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ny * nx * 4), 4));
    geom.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.name = 'surface-layer';
    this.mesh.renderOrder = -1;
  }

  update(wind: WindField, tw: TimeWeights, terrain: Terrain, exaggeration: number, maxSpeed: number, opacity: number): void {
    const { ny, nx, elevation } = terrain;
    const pos = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    const c = col.array as Float32Array;
    const lat = terrain.manifest.lat;
    const lon = terrain.manifest.lon;
    const rgb = new Float32Array(3);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const u = wind.sampleSurface(wind.u10!, tw, lat[j], lon[i]);
        const v = wind.sampleSurface(wind.v10!, tw, lat[j], lon[i]);
        p[k * 3 + 1] = (SURFACE_ASL_M / 1000) * exaggeration;
        colormapLinear(Math.hypot(u, v) / maxSpeed, rgb);
        c[k * 4] = rgb[0];
        c[k * 4 + 1] = rgb[1];
        c[k * 4 + 2] = rgb[2];
        c[k * 4 + 3] = SURFACE_ASL_M > elevation[k] ? opacity : 0;
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
  }
}
