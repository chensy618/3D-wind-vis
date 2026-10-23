import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Domain } from '../geo';

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  reset(): void;
  /** Re-frame for a domain of another size (e.g. a small CFD box) and reset the view. */
  setDomain(domain: Domain): void;
  resize(width: number, height: number): void;
  /** Pan so that `point` becomes the orbit centre, keeping the view angle and distance. */
  focus(point: THREE.Vector3): void;
  /** Advance a running pan; call once per frame. */
  tick(dt: number): void;
}

const PAN_SECONDS = 0.8;

/**
 * Perspective camera with orbit (rotate), dolly (zoom) and pan. `distance` scales how far the
 * default view stands back from the domain (1: the domain fills the view; larger shows it smaller).
 */
export function createCamera(dom: HTMLElement, domain: Domain, distance = 1): CameraRig {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  const controls = new OrbitControls(camera, dom);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.maxPolarAngle = Math.PI * 0.495; // stay above the ground plane
  controls.maxDistance = 400;

  let size = 0;
  const reset = () => {
    // looking from the south-west over the ocean towards the Senja mountains
    // (target shifted west so the domain sits right of the control panel)
    controls.target.set(-0.1 * size, 0.06 * size, 0);
    camera.position.set(-0.75 * size, 0.49 * size, 0.95 * size).multiplyScalar(distance).add(controls.target);
    controls.update();
  };
  const setDomain = (d: Domain) => {
    size = Math.max(d.width, d.depth);
    controls.minDistance = Math.min(3, 0.1 * size);
    reset();
  };
  setDomain(domain);
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
    setDomain(d: Domain) {
      pan = null;
      setDomain(d);
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
