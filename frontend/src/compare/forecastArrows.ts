import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { colormapLinear } from '../colormap';
import { Domain, nativeCells } from '../geo';
import { windFromLabel } from '../ui/inspector';
import { TimeWeights } from '../wind/interpolation';
import { WindField } from '../wind/loader';

/** Unit arrow pointing +x (east) in the xy plane (y north), centred on the origin. */
function arrowShape(): THREE.Shape {
  const shaft = 0.07;
  const headW = 0.2;
  const headStart = 0.15;
  return new THREE.Shape([
    new THREE.Vector2(-0.5, -shaft),
    new THREE.Vector2(headStart, -shaft),
    new THREE.Vector2(headStart, -headW),
    new THREE.Vector2(0.5, 0),
    new THREE.Vector2(headStart, headW),
    new THREE.Vector2(headStart, shaft),
    new THREE.Vector2(-0.5, shaft),
  ]);
}

/**
 * One big arrow per native grid cell of a raw forecast, at each level on show: the forecast
 * gives a single wind per cell, so over the CFD box (inside one 0.25° cell) there is just one.
 * Coloured by speed on the shared scale, drawn on top of terrain and surfaces.
 */
export class ForecastArrows {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.ShapeGeometry(arrowShape());
  private readonly outline: THREE.BufferGeometry;

  constructor() {
    this.outline = new THREE.BufferGeometry().setFromPoints(arrowShape().getPoints());
  }

  private clear(): void {
    this.group.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
      const m = o as THREE.Mesh;
      (m.material as THREE.Material | undefined)?.dispose();
    });
    this.group.clear();
  }

  update(wind: WindField, domain: Domain, tw: TimeWeights, levels: number[], exaggeration: number, maxSpeed: number): void {
    this.clear();
    const deg = wind.manifest.native_deg;
    if (!deg) return;
    const cells = nativeCells(domain, deg);
    const unit = (wind.manifest.level_units ?? 'hPa').split(' ')[0];
    const name = wind.manifest.model.replace(/\s*\(native\)$/, '');
    const rgb = [0, 0, 0];
    for (const c of cells) {
      // a little west of the cell's centre
      const x = c.x0 + 0.35 * (c.x1 - c.x0);
      const y = (c.y0 + c.y1) / 2;
      const lat = domain.lat(y);
      const lon = domain.lon(x);
      const len = 0.35 * Math.min(c.x1 - c.x0, c.y1 - c.y0);
      for (const k of levels) {
        const u = wind.sample(wind.u, tw, k, lat, lon);
        const v = wind.sample(wind.v, tw, k, lat, lon);
        const speed = Math.hypot(u, v);
        const h = wind.sample(wind.height, tw, k, lat, lon);
        colormapLinear(Math.min(1, speed / maxSpeed), rgb);
        const fill = new THREE.Mesh(
          this.geometry,
          new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2]), transparent: true, opacity: 0.92, depthTest: false, side: THREE.DoubleSide }),
        );
        const edge = new THREE.LineLoop(this.outline, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
        const arrow = new THREE.Group();
        arrow.add(fill, edge);
        arrow.position.copy(domain.toScene(x, y, h, exaggeration));
        // shape plane -> horizontal (shape y = north = scene -Z), turned to the wind's heading
        arrow.rotation.set(-Math.PI / 2, 0, Math.atan2(v, u));
        arrow.scale.setScalar(len);
        fill.renderOrder = edge.renderOrder = 10;
        this.group.add(arrow);

        const el = document.createElement('div');
        el.className = 'label3d fc-arrow';
        const head = cells.length === 1 && levels.length === 1 ? `One ${name} value for the whole box<br>` : '';
        el.innerHTML = `${head}${wind.levels[k]} ${unit} · <b>${speed.toFixed(1)} m/s</b> from ${windFromLabel(u, v)}`;
        const label = new CSS2DObject(el);
        label.position.copy(arrow.position);
        label.center.set(0.5, -0.6);
        this.group.add(label);
      }
    }
  }
}
