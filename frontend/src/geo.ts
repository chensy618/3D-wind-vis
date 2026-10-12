import * as THREE from 'three';

const KM_PER_DEG_LAT = 111.32;

/** Regular, ascending lat/lon grid (C-order: lat, lon). */
export class RegularGrid {
  readonly ny: number;
  readonly nx: number;
  readonly latMin: number;
  readonly latMax: number;
  readonly lonMin: number;
  readonly lonMax: number;

  constructor(lat: number[], lon: number[]) {
    this.ny = lat.length;
    this.nx = lon.length;
    this.latMin = lat[0];
    this.latMax = lat[lat.length - 1];
    this.lonMin = lon[0];
    this.lonMax = lon[lon.length - 1];
  }

  /** Fractional row index for a latitude. */
  fy(lat: number): number {
    return ((lat - this.latMin) / (this.latMax - this.latMin)) * (this.ny - 1);
  }

  /** Fractional column index for a longitude. */
  fx(lon: number): number {
    return ((lon - this.lonMin) / (this.lonMax - this.lonMin)) * (this.nx - 1);
  }
}

/**
 * Local metric frame for the visualization domain.
 * Local coordinates (x, y) are km east / north of the SW corner.
 * Scene coordinates: X east, Y up (km x vertical exaggeration), Z south.
 */
export class Domain {
  readonly latMin: number;
  readonly latMax: number;
  readonly lonMin: number;
  readonly lonMax: number;
  readonly kmPerLon: number;
  readonly width: number; // km east-west
  readonly depth: number; // km north-south

  constructor(latMin: number, latMax: number, lonMin: number, lonMax: number) {
    this.latMin = latMin;
    this.latMax = latMax;
    this.lonMin = lonMin;
    this.lonMax = lonMax;
    this.kmPerLon = KM_PER_DEG_LAT * Math.cos((((latMin + latMax) / 2) * Math.PI) / 180);
    this.width = (lonMax - lonMin) * this.kmPerLon;
    this.depth = (latMax - latMin) * KM_PER_DEG_LAT;
  }

  static fromGrid(g: RegularGrid): Domain {
    return new Domain(g.latMin, g.latMax, g.lonMin, g.lonMax);
  }

  lat(y: number): number {
    return this.latMin + y / KM_PER_DEG_LAT;
  }

  lon(x: number): number {
    return this.lonMin + x / this.kmPerLon;
  }

  localX(lon: number): number {
    return (lon - this.lonMin) * this.kmPerLon;
  }

  localY(lat: number): number {
    return (lat - this.latMin) * KM_PER_DEG_LAT;
  }

  contains(x: number, y: number): boolean {
    return x >= 0 && x <= this.width && y >= 0 && y <= this.depth;
  }

  sceneX(x: number): number {
    return x - this.width / 2;
  }

  sceneZ(y: number): number {
    return this.depth / 2 - y;
  }

  toScene(x: number, y: number, heightM: number, exaggeration: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.sceneX(x), (heightM / 1000) * exaggeration, this.sceneZ(y));
  }

  fromScene(p: THREE.Vector3): { x: number; y: number } {
    return { x: p.x + this.width / 2, y: this.depth / 2 - p.z };
  }
}

/** A model grid cell clipped to the domain, in local km. */
export interface CellBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Cells of a regular `deg` lat/lon model grid (centred on multiples of `deg`) that overlap the
 * domain, clipped to it; a cell that only touches the edge is left out.
 */
export function nativeCells(domain: Domain, deg: number): CellBounds[] {
  const half = deg / 2;
  const eps = 1e-6 * deg;
  const axis = (lo: number, hi: number) => {
    const out: number[] = [];
    for (let c = Math.ceil((lo - half) / deg) * deg; c - half < hi - eps; c += deg) if (c + half > lo + eps) out.push(c);
    return out;
  };
  const cells: CellBounds[] = [];
  for (const lat of axis(domain.latMin, domain.latMax)) {
    for (const lon of axis(domain.lonMin, domain.lonMax)) {
      cells.push({
        x0: Math.max(0, domain.localX(lon - half)),
        x1: Math.min(domain.width, domain.localX(lon + half)),
        y0: Math.max(0, domain.localY(lat - half)),
        y1: Math.min(domain.depth, domain.localY(lat + half)),
      });
    }
  }
  return cells;
}

/** Number of `deg` cells over the domain, without building them. */
export function nativeCellCount(domain: Domain, deg: number): number {
  return (Math.ceil((domain.latMax - domain.latMin) / deg) + 1) * (Math.ceil((domain.lonMax - domain.lonMin) / deg) + 1);
}
