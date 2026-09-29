import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Domain } from '../geo';

function label(text: string, cls: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = `label3d ${cls}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

/** Height axis at the NE corner, level tags on the east edge and a north arrow. */
export class Annotations {
  readonly group = new THREE.Group();
  private levelTags: CSS2DObject[] = [];

  constructor(private domain: Domain) {
    this.group.name = 'annotations';
  }

  build(levels: number[], meanHeights: number[], exaggeration: number, topM: number): void {
    this.dispose();
    const { domain } = this;
    // height axis on the NE corner (back right in the default view)
    const x0 = domain.width / 2;
    const z0 = -domain.depth / 2;

    const ticks: number[] = [];
    for (let h = 0; h <= topM; h += 1000) ticks.push(h);
    const pts: number[] = [x0, 0, z0, x0, (ticks[ticks.length - 1] / 1000) * exaggeration, z0];
    for (const h of ticks) {
      const y = (h / 1000) * exaggeration;
      pts.push(x0, y, z0, x0 + 0.8, y, z0);
      const l = label(`${h / 1000} km`, 'axis');
      l.position.set(x0 + 1.2, y, z0);
      l.center.set(0, 0.5);
      this.group.add(l);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9fb3c8 })));

    // level tags on the east edge
    this.levelTags = levels.map((p, i) => {
      const l = label(`${p} hPa`, 'level');
      l.position.set(domain.width / 2 + 0.5, (meanHeights[i] / 1000) * exaggeration, domain.depth / 2);
      l.center.set(0, 0.5);
      this.group.add(l);
      return l;
    });

    // north arrow
    const n = label('N ↑', 'north');
    n.position.set(0, 0, -domain.depth / 2 - 2);
    this.group.add(n);
  }

  highlight(active: boolean[]): void {
    this.levelTags.forEach((l, i) => l.element.classList.toggle('on', active[i]));
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove();
      if (o instanceof THREE.LineSegments) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.group.clear();
    this.levelTags = [];
  }
}

/** Vertical probe column with a dot at each level height. */
export class ProbeMarker {
  readonly group = new THREE.Group();
  private line: THREE.Line;
  private dots: THREE.Points;

  constructor() {
    this.line = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }),
    );
    this.dots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: 0xffffff, size: 7, sizeAttenuation: false }),
    );
    this.group.add(this.line, this.dots);
    this.group.visible = false;
  }

  set(x: number, z: number, groundY: number, levelYs: number[]): void {
    const top = Math.max(groundY, ...levelYs) + 0.5;
    this.line.geometry.setAttribute('position', new THREE.Float32BufferAttribute([x, groundY, z, x, top, z], 3));
    this.dots.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(levelYs.flatMap((y) => [x, y, z]), 3),
    );
    this.line.geometry.computeBoundingSphere();
    this.dots.geometry.computeBoundingSphere();
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}
