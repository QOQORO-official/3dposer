import { z } from 'zod';

/**
 * Keypoints the pose solver consumes. Names follow MediaPipe's pose landmark
 * names so detector output maps across without renaming.
 */
export const KEYPOINT_NAMES = [
  'nose',
  'left_ear',
  'right_ear',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_index',
  'right_index',
  'left_pinky',
  'right_pinky',
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
] as const;

export type KeypointName = (typeof KEYPOINT_NAMES)[number];

export const KeypointSchema = z.object({
  u: z.number().describe('Horizontal image position, 0 = left edge, 1 = right edge.'),
  v: z.number().describe('Vertical image position, 0 = top edge, 1 = bottom edge.'),
  x: z.number().describe('Meters, camera frame, + = image right. Relative to the hip midpoint.'),
  y: z.number().describe('Meters, camera frame, + = image up. Relative to the hip midpoint.'),
  z: z.number().describe('Meters, camera frame, + = toward the camera. Relative to the hip midpoint.'),
  confidence: z.number().describe('0..1. Lower it for occluded or guessed points.'),
});
export type Keypoint = z.infer<typeof KeypointSchema>;

const keypointShape = Object.fromEntries(KEYPOINT_NAMES.map((n) => [n, KeypointSchema])) as Record<
  KeypointName,
  typeof KeypointSchema
>;
export const KeypointsSchema = z.object(keypointShape);
export type Keypoints = z.infer<typeof KeypointsSchema>;

export const HandSchema = z.object({
  finger_curl: z.number().describe('0 = fingers straight, 1 = tight fist.'),
  thumb_curl: z.number().describe('0 = thumb extended, 1 = thumb folded over the fingers.'),
  spread: z.number().describe('0 = fingers together, 1 = fully splayed.'),
});
export type HandPose = z.infer<typeof HandSchema>;

export const PoseAnalysisSchema = z.object({
  description: z.string().describe('One or two sentences describing the pose and the action.'),
  foreshortening_notes: z
    .string()
    .describe('Which limbs/segments point toward or away from the camera, and how you resolved depth.'),
  camera: z.object({
    fov_deg: z.number().describe('Vertical field of view of the camera in degrees (wide lens = strong perspective).'),
    elevation_deg: z.number().describe('Camera pitch: + = camera above looking down, - = below looking up.'),
    roll_deg: z.number().describe('Camera roll (dutch angle) in degrees, + = counter-clockwise image tilt.'),
    distance_m: z.number().describe('Approximate distance from the camera to the hip midpoint in meters.'),
  }),
  keypoints: KeypointsSchema,
  hands: z.object({ left: HandSchema, right: HandSchema }),
  body: z.object({
    sex: z.enum(['male', 'female', 'neutral']),
    muscularity: z.number().describe('0 = slight, 0.5 = athletic, 1 = bodybuilder.'),
    body_fat: z.number().describe('0 = very lean, 0.3 = average athletic, 1 = heavy.'),
    heads_tall: z.number().describe('Figure height measured in head heights (realistic ~7.5, heroic ~8.5).'),
  }),
});
export type PoseAnalysis = z.infer<typeof PoseAnalysisSchema>;

/** Landmarks from the in-browser detector, sent to the server as extra evidence. */
export interface DetectorLandmark {
  name: string;
  u: number;
  v: number;
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface ImagePayload {
  media_type: 'image/jpeg' | 'image/png' | 'image/webp';
  data: string;
}

export interface AnalyzeRequest {
  image: ImagePayload;
  /** Present for refinement: the current 3D figure rendered from the matched camera. */
  render?: ImagePayload;
  detector?: DetectorLandmark[];
  /** Present for refinement: the keypoints that produced `render`. */
  current?: PoseAnalysis;
  note?: string;
}

export interface AnalyzeResponse {
  analysis: PoseAnalysis;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
}
