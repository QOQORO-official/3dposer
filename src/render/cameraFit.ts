import * as THREE from 'three';

/** Camera orientation (yaw 0, looking down -Z) from pitch-down elevation and image roll. */
export function cameraOrientation(elevationDeg: number, rollDeg: number): THREE.Quaternion {
  const e = new THREE.Euler(THREE.MathUtils.degToRad(-elevationDeg), 0, THREE.MathUtils.degToRad(-rollDeg), 'YXZ');
  return new THREE.Quaternion().setFromEuler(e);
}

export interface FitPoint {
  world: THREE.Vector3;
  u: number;
  v: number;
  weight: number;
}

/**
 * Finds the camera position that best projects `points` onto their image coordinates for a fixed
 * orientation and field of view. The projection constraints are linear in the camera position,
 * so this is a 3x3 least-squares solve.
 */
export function fitCameraPosition(points: FitPoint[], q: THREE.Quaternion, fovDeg: number, aspect: number): THREE.Vector3 | null {
  const r1 = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const r2 = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const r3 = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const tanY = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const A = new Array(9).fill(0);
  const b = [0, 0, 0];
  const n = new THREE.Vector3();
  const add = (nv: THREE.Vector3, J: THREE.Vector3, w: number) => {
    const rhs = nv.dot(J);
    const c = [nv.x, nv.y, nv.z];
    for (let i = 0; i < 3; i++) {
      b[i] += w * c[i] * rhs;
      for (let k = 0; k < 3; k++) A[i * 3 + k] += w * c[i] * c[k];
    }
  };
  let total = 0;
  for (const pt of points) {
    if (pt.weight <= 0) continue;
    total += pt.weight;
    const ax = (2 * pt.u - 1) * tanY * aspect;
    const ay = (1 - 2 * pt.v) * tanY;
    add(n.copy(r1).addScaledVector(r3, ax), pt.world, pt.weight);
    add(n.copy(r2).addScaledVector(r3, ay), pt.world, pt.weight);
  }
  if (total === 0) return null;
  const m = new THREE.Matrix3().set(A[0], A[1], A[2], A[3], A[4], A[5], A[6], A[7], A[8]);
  if (Math.abs(m.determinant()) < 1e-12) return null;
  return new THREE.Vector3(b[0], b[1], b[2]).applyMatrix3(m.invert());
}

/** Mean squared reprojection error (in normalized image units) for a candidate camera. */
export function reprojectionError(points: FitPoint[], camera: THREE.PerspectiveCamera): number {
  camera.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let err = 0;
  let total = 0;
  for (const pt of points) {
    if (pt.weight <= 0) continue;
    v.copy(pt.world).project(camera);
    if (v.z > 1) return Infinity; // behind the camera
    const u = (v.x + 1) / 2;
    const vv = (1 - v.y) / 2;
    err += pt.weight * ((u - pt.u) ** 2 + (vv - pt.v) ** 2);
    total += pt.weight;
  }
  return total ? err / total : Infinity;
}

/** Fits position (and optionally FOV) and applies the result to `camera`. */
export function matchCamera(
  camera: THREE.PerspectiveCamera,
  points: FitPoint[],
  q: THREE.Quaternion,
  opts: { fov: number; aspect: number; searchFov: boolean },
): { fov: number; error: number } | null {
  const tryFov = (fov: number) => {
    const pos = fitCameraPosition(points, q, fov, opts.aspect);
    if (!pos) return { fov, error: Infinity, pos: null };
    camera.fov = fov;
    camera.aspect = opts.aspect;
    camera.position.copy(pos);
    camera.quaternion.copy(q);
    camera.updateProjectionMatrix();
    return { fov, error: reprojectionError(points, camera), pos };
  };
  // Reprojection error alone favors long lenses (they flatten away depth mismatches), so the
  // search stays near the estimated lens and pays a penalty for drifting from it.
  const penalty = (fov: number) => 1 + 2 * Math.log(fov / opts.fov) ** 2;
  let best = tryFov(opts.fov);
  let bestScore = best.error;
  if (opts.searchFov) {
    const lo = Math.max(10, opts.fov / 1.6);
    const hi = Math.min(120, opts.fov * 1.6);
    for (let i = 0; i <= 24; i++) {
      const fov = lo * (hi / lo) ** (i / 24);
      const r = tryFov(fov);
      const score = r.error * penalty(fov);
      if (score < bestScore) {
        best = r;
        bestScore = score;
      }
    }
  }
  if (!best.pos) return null;
  camera.fov = best.fov;
  camera.position.copy(best.pos);
  camera.quaternion.copy(q);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { fov: best.fov, error: best.error };
}
