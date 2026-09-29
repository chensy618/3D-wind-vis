import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Domain } from '../geo';

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  reset(): void;
  resize(width: number, height: number): void;
}

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

  return {
    camera,
    controls,
    reset,
    resize(width: number, height: number) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },
  };
}
