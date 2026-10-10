import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { DetectorLandmark } from '../../shared/schema';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task';

/** MediaPipe's 33 pose landmarks, in index order. */
export const MEDIAPIPE_NAMES = [
  'nose',
  'left_eye_inner',
  'left_eye',
  'left_eye_outer',
  'right_eye_inner',
  'right_eye',
  'right_eye_outer',
  'left_ear',
  'right_ear',
  'mouth_left',
  'mouth_right',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_pinky',
  'right_pinky',
  'left_index',
  'right_index',
  'left_thumb',
  'right_thumb',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
  'left_heel',
  'right_heel',
  'left_foot_index',
  'right_foot_index',
];

let landmarker: Promise<PoseLandmarker> | null = null;

function getLandmarker(): Promise<PoseLandmarker> {
  landmarker ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const create = (delegate: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'IMAGE',
        numPoses: 1,
        minPoseDetectionConfidence: 0.3,
        minPosePresenceConfidence: 0.3,
      });
    try {
      return await create('GPU');
    } catch {
      return await create('CPU');
    }
  })();
  landmarker.catch(() => (landmarker = null));
  return landmarker;
}

/**
 * Runs MediaPipe on the image. Returns landmarks converted to this app's camera frame
 * (+x image right, +y up, +z toward the camera, meters, origin between the hips), or null if
 * no person was found.
 */
export async function detectPose(image: HTMLImageElement): Promise<DetectorLandmark[] | null> {
  const lm = await getLandmarker();
  const result = lm.detect(image);
  const norm = result.landmarks[0];
  const world = result.worldLandmarks[0];
  if (!norm || !world) return null;
  return MEDIAPIPE_NAMES.map((name, i) => ({
    name,
    u: norm[i].x,
    v: norm[i].y,
    // MediaPipe world landmarks: y down, smaller z = closer to the camera.
    x: world[i].x,
    y: -world[i].y,
    z: -world[i].z,
    visibility: norm[i].visibility ?? 1,
  }));
}
