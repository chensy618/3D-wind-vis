import * as THREE from 'three';

const COLOR = 0x5cc8ff;
const PERIOD = 1.4; // seconds per pulse

/**
 * Marks a queried or clicked point: a solid ring on the ground plus a ring that
 * pulses outwards from it. Drawn over the terrain (no depth test) so the point
 * stays visible behind mountains.
 */
export class Highlight {
  readonly group = new THREE.Group();
  private pulse: THREE.Mesh;
  private t = 0;

  constructor() {
    const mat = (opacity: number) =>
      new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.45, 64), mat(0.95));
    this.pulse = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.5, 64), mat(0.8));
    for (const m of [ring, this.pulse]) {
      m.rotation.x = -Math.PI / 2; // lie flat on the ground
      m.renderOrder = 10;
    }
    this.group.add(ring, this.pulse);
    this.group.visible = false;
  }

  /** Place at scene (x, y, z); `restart` starts the pulse again, for a new point. */
  set(x: number, y: number, z: number, restart = false): void {
    this.group.position.set(x, y + 0.02, z);
    this.group.visible = true;
    if (restart) this.t = 0;
  }

  hide(): void {
    this.group.visible = false;
  }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.t += dt;
    const f = (this.t % PERIOD) / PERIOD;
    this.pulse.scale.setScalar(1 + 2.2 * f);
    (this.pulse.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - f);
  }
}
