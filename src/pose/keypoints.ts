import * as THREE from 'three';
import { KEYPOINT_NAMES, type DetectorLandmark, type Keypoints, type PoseAnalysis } from '../../shared/schema';
import type { WorldKeypoints } from '../figure/solver';

export const DEFAULT_CAMERA: PoseAnalysis['camera'] = { fov_deg: 40, elevation_deg: 0, roll_deg: 0, distance_m: 3 };

/** Wraps detector output in the same shape Claude returns, so both paths share one pipeline. */
export function analysisFromDetector(landmarks: DetectorLandmark[]): PoseAnalysis {
  const byName = new Map(landmarks.map((l) => [l.name, l]));
  const keypoints = {} as Keypoints;
  for (const name of KEYPOINT_NAMES) {
    const l = byName.get(name);
    keypoints[name] = l
      ? { u: l.u, v: l.v, x: l.x, y: l.y, z: l.z, confidence: l.visibility }
      : { u: 0.5, v: 0.5, x: 0, y: 0, z: 0, confidence: 0 };
  }
  return {
    description: 'Pose detected by MediaPipe (no Claude refinement yet).',
    foreshortening_notes: 'Depth comes from the detector alone and may be unreliable for limbs pointing at the camera.',
    camera: { ...DEFAULT_CAMERA },
    keypoints,
    hands: {
      left: { finger_curl: 0.3, thumb_curl: 0.2, spread: 0.15 },
      right: { finger_curl: 0.3, thumb_curl: 0.2, spread: 0.15 },
    },
    body: { sex: 'neutral', muscularity: 0.5, body_fat: 0.25, heads_tall: 7.5 },
  };
}

/** Rotates camera-frame keypoints into world space around `anchor` (the hip midpoint). */
export function keypointsToWorld(kp: Keypoints, cameraQ: THREE.Quaternion, anchor: THREE.Vector3): WorldKeypoints {
  const out = {} as WorldKeypoints;
  for (const name of KEYPOINT_NAMES) {
    const k = kp[name];
    out[name] = {
      p: new THREE.Vector3(k.x, k.y, k.z).applyQuaternion(cameraQ).add(anchor),
      confidence: THREE.MathUtils.clamp(k.confidence, 0, 1),
    };
  }
  return out;
}

/** Expresses figure keypoints in the camera frame + image coordinates (for refinement requests). */
export function worldToKeypoints(points: Record<string, THREE.Vector3>, camera: THREE.PerspectiveCamera): Keypoints {
  camera.updateMatrixWorld(true);
  const inv = camera.quaternion.clone().invert();
  const hip = points.left_hip.clone().add(points.right_hip).multiplyScalar(0.5);
  const kp = {} as Keypoints;
  for (const name of KEYPOINT_NAMES) {
    const w = points[name];
    const rel = w.clone().sub(hip).applyQuaternion(inv);
    const ndc = w.clone().project(camera);
    kp[name] = {
      u: +((ndc.x + 1) / 2).toFixed(4),
      v: +((1 - ndc.y) / 2).toFixed(4),
      x: +rel.x.toFixed(4),
      y: +rel.y.toFixed(4),
      z: +rel.z.toFixed(4),
      confidence: 1,
    };
  }
  return kp;
}
