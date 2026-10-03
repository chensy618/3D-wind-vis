import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Domain } from '../geo';

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  reset(): void;
  resize(width: number, height: number): void;
  /** Pan so that `point` becomes the orbit centre, keeping the view angle and distance. */
  focus(point: THREE.Vector3): void;
  /** Advance a running pan; call once per frame. */
  tick(dt: number): void;
}

const PAN_SECONDS = 0.8;

/** Perspective camera with orbit (rotate), dolly (zoom) and pan. */
export function createCamera(dom: HTMLElement, domain: Domain): CameraRig {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  const controls = new OrbitControls(camera, dom);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI * 0.495; // stay above the ground plane
  controls.minDistance = 3;
  controls.maxDistance = 400;

  const size = Math.max(domain.width, domain.depth);
  const reset = () => {
    // looking from the south-west over the ocean towards the Senja mountains
    // (target shifted west so the domain sits right of the control panel)
    camera.position.set(-0.85 * size, 0.55 * size, 0.95 * size);
    controls.target.set(-0.1 * size, 3, 0);
    controls.update();
  };
  reset();

  // a pan moves the camera and its target by the same offset, eased in and out
  let pan: { from: THREE.Vector3; by: THREE.Vector3; t: number } | null = null;
  const moved = new THREE.Vector3();

  return {
    camera,
    controls,
    reset() {
      pan = null;
      reset();
    },
    focus(point: THREE.Vector3) {
      pan = { from: controls.target.clone(), by: point.clone().sub(controls.target), t: 0 };
    },
    tick(dt: number) {
      if (!pan) return;
      pan.t = Math.min(1, pan.t + dt / PAN_SECONDS);
      const e = pan.t < 0.5 ? 2 * pan.t * pan.t : 1 - (-2 * pan.t + 2) ** 2 / 2;
      moved.copy(pan.from).addScaledVector(pan.by, e).sub(controls.target);
      controls.target.add(moved);
      camera.position.add(moved);
      if (pan.t >= 1) pan = null;
    },
    resize(width: number, height: number) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
  };
}
