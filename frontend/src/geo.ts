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
