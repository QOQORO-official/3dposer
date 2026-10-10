import * as THREE from 'three';
import type { KeypointName, Keypoints } from '../../shared/schema';
import type { Figure } from './rig';
import type { WorldKeypoints } from './solver';
import { SIDES } from './params';

/**
 * Makes limbs agree exactly with the 2D image while keeping the mannequin's bone lengths.
 *
 * For each bone (parent joint already placed), the child joint must lie on the camera ray through
 * its image position and at bone-length distance from the parent. That gives up to two points
 * (the limb tilted toward or away from the camera); the 3D estimate picks which one. This is
 * what turns a short-looking limb in the image into correct foreshortening.
 */
export function liftLimbsToImage(
  fig: Figure,
  kp: Keypoints,
  world: WorldKeypoints,
  camera: THREE.PerspectiveCamera,
  minConfidence = 0.4,
): WorldKeypoints {
  camera.updateMatrixWorld(true);
  const out: WorldKeypoints = { ...world };
  const scale = fig.root.scale.x;

  const ray = (name: KeypointName) => {
    const k = kp[name];
    const p = new THREE.Vector3(2 * k.u - 1, 1 - 2 * k.v, 0.5).unproject(camera);
    return { o: camera.position.clone(), d: p.sub(camera.position).normalize() };
  };

  /** Places `child` at distance `len` from `from`, on its image ray when confident. */
  const place = (from: THREE.Vector3, parentName: KeypointName, child: KeypointName, len: number): THREE.Vector3 => {
    const want = world[child].p.clone().sub(world[parentName].p).normalize();
    const conf = Math.min(kp[parentName].confidence, kp[child].confidence);
    if (conf < minConfidence || want.lengthSq() < 1e-10) return from.clone().addScaledVector(want, len);
    const { o, d } = ray(child);
    const oc = o.clone().sub(from);
    const b = d.dot(oc);
    const c = oc.lengthSq() - len * len;
    const disc = b * b - c;
    if (disc < 0) {
      // The ray passes beyond reach: point the bone at the ray's closest point.
      const closest = o.clone().addScaledVector(d, -b);
      return from.clone().addScaledVector(closest.sub(from).normalize(), len);
    }
    const s = Math.sqrt(disc);
    const candidates = [-b - s, -b + s].filter((t) => t > 0).map((t) => o.clone().addScaledVector(d, t));
    if (!candidates.length) return from.clone().addScaledVector(want, len);
    // Prefer the solution that agrees with the 3D estimate's direction (toward/away from camera).
    let best = candidates[0];
    let bestDot = -Infinity;
    for (const cnd of candidates) {
      const dot = cnd.clone().sub(from).normalize().dot(want);
      if (dot > bestDot) {
        bestDot = dot;
        best = cnd;
      }
    }
    return best;
  };

  const shift = (names: KeypointName[], delta: THREE.Vector3) => {
    for (const n of names) out[n] = { ...out[n], p: world[n].p.clone().add(delta) };
  };

  for (const s of SIDES) {
    const side = s === 'l' ? 'left' : 'right';
    const k = (n: string) => `${side}_${n}` as KeypointName;

    // Arm: shoulder (figure) -> elbow -> wrist; the hand points move with the wrist.
    const shoulder = fig.worldPos(`upperarm_${s}`);
    const elbow = place(shoulder, k('shoulder'), k('elbow'), fig.get(`upperarm_${s}`).length * scale);
    const wrist = place(elbow, k('elbow'), k('wrist'), fig.get(`forearm_${s}`).length * scale);
    out[k('shoulder')] = { ...world[k('shoulder')], p: shoulder };
    out[k('elbow')] = { ...world[k('elbow')], p: elbow };
    out[k('wrist')] = { ...world[k('wrist')], p: wrist };
    shift([k('index'), k('pinky'), k('thumb')], wrist.clone().sub(world[k('wrist')].p));

    // Leg: hip (figure) -> knee -> ankle; heel and toe move with the ankle.
    const hip = fig.worldPos(`thigh_${s}`);
    const knee = place(hip, k('hip'), k('knee'), fig.get(`thigh_${s}`).length * scale);
    const ankle = place(knee, k('knee'), k('ankle'), fig.get(`shin_${s}`).length * scale);
    out[k('hip')] = { ...world[k('hip')], p: hip };
    out[k('knee')] = { ...world[k('knee')], p: knee };
    out[k('ankle')] = { ...world[k('ankle')], p: ankle };
    shift([k('heel'), k('foot_index')], ankle.clone().sub(world[k('ankle')].p));
  }
  return out;
}
