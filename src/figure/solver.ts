import * as THREE from 'three';
import { KEYPOINT_NAMES, type KeypointName } from '../../shared/schema';
import { basisFromYX, basisFromYZ, sideSign, type Figure } from './rig';
import { SIDES, type Side } from './params';

export interface WorldKeypoint {
  p: THREE.Vector3;
  confidence: number;
}
export type WorldKeypoints = Record<KeypointName, WorldKeypoint>;

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

const axis = (q: THREE.Quaternion, a: THREE.Vector3) => a.clone().applyQuaternion(q);
const sub = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().sub(b);
const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
const perp = (v: THREE.Vector3, n: THREE.Vector3) => v.clone().addScaledVector(n, -v.dot(n));
const smooth = (e0: number, e1: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Rotates `v` toward `target` so the angle between them is at most `maxRad`. */
function limitAngle(v: THREE.Vector3, target: THREE.Vector3, maxRad: number): THREE.Vector3 {
  const ang = v.angleTo(target);
  if (ang <= maxRad) return v.clone();
  const axisV = new THREE.Vector3().crossVectors(target, v);
  if (axisV.lengthSq() < 1e-10) return target.clone();
  return target.clone().applyAxisAngle(axisV.normalize(), maxRad);
}

// ---------------------------------------------------------------------------------------------
// Frame construction. These build orthonormal frames from directions only. When driven by
// keypoints, the frames are mapped to bone orientations through a per-figure calibration (see
// `calibration`), so landmark conventions (nose vs. ears, heel vs. toe...) never need hand-tuning.

/** Upper arm / forearm / hand frames from `u` shoulder->elbow and `f` elbow->wrist. */
export function armFrames(
  u: THREE.Vector3,
  f: THREE.Vector3,
  twistHint: THREE.Vector3,
  hand: { y: THREE.Vector3; z: THREE.Vector3 } | null,
): { upper: THREE.Quaternion; fore: THREE.Quaternion; hand: THREE.Quaternion | null } {
  u = u.clone().normalize();
  f = f.clone().normalize();
  const bendDir = perp(f, u);
  const hint = perp(twistHint, u);
  if (hint.lengthSq() < 1e-8) hint.copy(perp(Y, u));
  hint.normalize();
  const w = bendDir.lengthSq() > 1e-8 ? smooth(0.12, 0.45, u.angleTo(f)) : 0;
  const zAxis = hint.multiplyScalar(1 - w).add(bendDir.normalize().multiplyScalar(w));
  const upper = basisFromYZ(u, zAxis);
  let fore = basisFromYX(f, axis(upper, X));
  let handQ: THREE.Quaternion | null = null;
  if (hand) {
    const hy = limitAngle(hand.y.clone().normalize(), f, THREE.MathUtils.degToRad(80));
    handQ = basisFromYZ(hy, hand.z);
    // Share the hand's twist with the forearm (radius and ulna rotate with the wrist).
    const foreZ = axis(fore, Z);
    const handZ = perp(axis(handQ, Z), f).normalize();
    let twist = Math.atan2(new THREE.Vector3().crossVectors(foreZ, handZ).dot(f), foreZ.dot(handZ));
    twist = THREE.MathUtils.clamp(twist, -Math.PI * 0.75, Math.PI * 0.75);
    fore = new THREE.Quaternion().setFromAxisAngle(f, twist * 0.6).multiply(fore);
  }
  return { upper, fore, hand: handQ };
}

/** Thigh / shin / foot frames from `t` hip->knee and `sh` knee->ankle; `footY` heel->toe. */
export function legFrames(
  t: THREE.Vector3,
  sh: THREE.Vector3,
  twistHint: THREE.Vector3,
  footY: THREE.Vector3 | null,
): { thigh: THREE.Quaternion; shin: THREE.Quaternion; foot: THREE.Quaternion | null } {
  t = t.clone().normalize();
  sh = sh.clone().normalize();
  const bendDir = perp(sh, t).negate(); // the knee flexes backward: the kneecap faces away from the shin
  const hint = perp(twistHint, t);
  if (hint.lengthSq() < 1e-8) hint.copy(perp(Z, t));
  hint.normalize();
  const w = bendDir.lengthSq() > 1e-8 ? smooth(0.12, 0.45, t.angleTo(sh)) : 0;
  const zAxis = hint.multiplyScalar(1 - w).add(bendDir.normalize().multiplyScalar(w));
  const thigh = basisFromYZ(t, zAxis);
  const shin = basisFromYX(sh, axis(thigh, X));
  let foot: THREE.Quaternion | null = null;
  if (footY) {
    // Keep the ankle within a plausible range around "foot perpendicular to the shin".
    const fy = limitAngle(footY.clone().normalize(), axis(shin, Z), THREE.MathUtils.degToRad(70));
    foot = basisFromYZ(fy, sh.clone().negate());
  }
  return { thigh, shin, foot };
}

interface KeypointFrames {
  frames: Map<string, THREE.Quaternion | null>;
  hipMid: THREE.Vector3;
  armDir: Record<Side, THREE.Vector3>;
}

function keypointFrames(kp: WorldKeypoints): KeypointFrames {
  const P = (n: KeypointName) => kp[n].p;
  const ok = (n: KeypointName, min = 0.15) => kp[n].confidence >= min;
  const frames = new Map<string, THREE.Quaternion | null>();

  const hipMid = mid(P('left_hip'), P('right_hip'));
  const up = sub(mid(P('left_shoulder'), P('right_shoulder')), hipMid).normalize();
  const thighL = sub(P('left_knee'), P('left_hip')).normalize();
  const thighR = sub(P('right_knee'), P('right_hip')).normalize();
  // The thigh that hangs lowest; when both are raised (sitting) the pelvis tilts back.
  const lowThigh = thighL.dot(up) < thighR.dot(up) ? thighL : thighR;
  const pelvisUp = up.clone().multiplyScalar(0.85).addScaledVector(lowThigh, -0.15).normalize();
  const pelvis = basisFromYX(pelvisUp, sub(P('left_hip'), P('right_hip')));
  // Chest bends a little further than the hip-to-shoulder chord (spine curvature).
  const chestUp = up.clone().addScaledVector(sub(up, axis(pelvis, Y)), 0.6).normalize();
  const chest = basisFromYX(chestUp, sub(P('left_shoulder'), P('right_shoulder')));
  frames.set('pelvis', pelvis);
  frames.set('spine', pelvis.clone().slerp(chest, 0.5));
  frames.set('chest', chest);

  if (ok('nose') && ok('left_ear', 0.05) && ok('right_ear', 0.05)) {
    const earMid = mid(P('left_ear'), P('right_ear'));
    const xAxis = sub(P('left_ear'), P('right_ear')).normalize();
    const fwd = perp(sub(P('nose'), earMid), xAxis).normalize();
    const head = basisFromYZ(new THREE.Vector3().crossVectors(fwd, xAxis), fwd);
    frames.set('head', head);
    frames.set('neck', chest.clone().slerp(head, 0.45));
  } else {
    frames.set('head', null);
    frames.set('neck', null);
  }

  const chestY = axis(chest, Y);
  const chestZ = axis(chest, Z);
  const pz = axis(pelvis, Z);
  const py = axis(pelvis, Y);
  const armDir = {} as Record<Side, THREE.Vector3>;
  for (const s of SIDES) {
    const side = s === 'l' ? 'left' : 'right';
    const k = (n: string) => `${side}_${n}` as KeypointName;
    const u = sub(P(k('elbow')), P(k('shoulder'))).normalize();
    const f = sub(P(k('wrist')), P(k('elbow'))).normalize();
    armDir[s] = u;
    let hand: { y: THREE.Vector3; z: THREE.Vector3 } | null = null;
    if (ok(k('index'), 0.3) && ok(k('pinky'), 0.3)) {
      hand = { y: sub(mid(P(k('index')), P(k('pinky'))), P(k('wrist'))), z: sub(P(k('index')), P(k('pinky'))) };
      if (hand.y.lengthSq() < 1e-10 || hand.z.lengthSq() < 1e-10) hand = null;
    }
    const arm = armFrames(u, f, chestZ.clone().addScaledVector(chestY, u.dot(chestZ)), hand);
    frames.set(`upperarm_${s}`, arm.upper);
    frames.set(`forearm_${s}`, arm.fore);
    frames.set(`hand_${s}`, arm.hand);

    const t = sub(P(k('knee')), P(k('hip'))).normalize();
    const sh = sub(P(k('ankle')), P(k('knee'))).normalize();
    let footY: THREE.Vector3 | null = null;
    if (ok(k('heel'), 0.3) && ok(k('foot_index'), 0.3)) {
      footY = sub(P(k('foot_index')), P(k('heel')));
      if (footY.lengthSq() < 1e-10) footY = null;
    }
    const leg = legFrames(t, sh, pz.clone().addScaledVector(py, t.dot(pz)), footY);
    frames.set(`thigh_${s}`, leg.thigh);
    frames.set(`shin_${s}`, leg.shin);
    frames.set(`foot_${s}`, leg.foot);
  }
  return { frames, hipMid, armDir };
}

// ---------------------------------------------------------------------------------------------
// Calibration: frames built from the figure's own rest-pose keypoints, compared with its rest
// bone orientations. bone = frame * correction.

const calibrationCache = new WeakMap<Figure, { version: number; corr: Map<string, THREE.Quaternion> }>();

function calibration(fig: Figure): Map<string, THREE.Quaternion> {
  const cached = calibrationCache.get(fig);
  if (cached && cached.version === fig.shapeVersion) return cached.corr;
  const saved = fig.snapshot();
  const hands = structuredClone(fig.params.hands);
  for (const s of SIDES) fig.params.hands[s] = { curl: 0, thumbCurl: 0, spread: 0 };
  fig.resetPose();
  const pts = figureKeypoints(fig);
  const kp = {} as WorldKeypoints;
  for (const n of KEYPOINT_NAMES) kp[n] = { p: pts[n], confidence: 1 };
  const { frames } = keypointFrames(kp);
  const corr = new Map<string, THREE.Quaternion>();
  for (const [name, f] of frames) {
    if (f) corr.set(name, f.clone().invert().multiply(fig.worldQuat(name)));
  }
  fig.params.hands = hands;
  fig.restore(saved);
  calibrationCache.set(fig, { version: fig.shapeVersion, corr });
  return corr;
}

/** Raises the clavicle when the arm goes overhead, like the scapula's upward rotation. */
function autoClavicle(fig: Figure, s: Side, armDir: THREE.Vector3, chestUp: THREE.Vector3) {
  const elev = armDir.angleTo(chestUp.clone().negate());
  const k = smooth(THREE.MathUtils.degToRad(70), THREE.MathUtils.degToRad(170), elev);
  const j = fig.get(`clavicle_${s}`);
  const q = new THREE.Quaternion().setFromAxisAngle(Z, sideSign(s) * THREE.MathUtils.degToRad(24) * k);
  j.obj.quaternion.copy(j.restLocal).multiply(q);
  j.obj.updateMatrixWorld(true);
}

/**
 * Retargets keypoints (world space, any scale) onto the figure's bones. Only directions are used,
 * so the figure keeps its own proportions.
 */
export function solveFromKeypoints(fig: Figure, kp: WorldKeypoints): void {
  const corr = calibration(fig);
  const { frames, hipMid, armDir } = keypointFrames(kp);
  const bone = (name: string) => {
    const f = frames.get(name);
    const c = corr.get(name);
    return f && c ? f.clone().multiply(c) : null;
  };
  /** Sets a joint from its frame, or keeps its rest orientation relative to the parent. */
  const set = (name: string) => {
    const q = bone(name);
    if (q) fig.setWorldQuat(name, q);
    else {
      const j = fig.get(name);
      j.obj.quaternion.copy(j.restLocal);
      j.obj.updateMatrixWorld(true);
    }
  };

  const pelvisQ = bone('pelvis')!;
  const scale = fig.root.scale.x;
  const pelvisWorld = hipMid.clone().add(fig.pelvisFromHips().multiplyScalar(scale).applyQuaternion(pelvisQ));
  fig.get('pelvis').obj.position.copy(fig.root.worldToLocal(pelvisWorld));
  fig.root.updateMatrixWorld(true);
  for (const name of ['pelvis', 'spine', 'chest', 'neck', 'head']) set(name);

  const chestUp = axis(frames.get('chest')!, Y);
  for (const s of SIDES) {
    autoClavicle(fig, s, armDir[s], chestUp);
    for (const name of [`upperarm_${s}`, `forearm_${s}`, `hand_${s}`, `thigh_${s}`, `shin_${s}`, `foot_${s}`]) set(name);
  }
  fig.root.updateMatrixWorld(true);
}

/**
 * Analytic two-bone IK: moves the end of an arm/leg to `target` (world), keeping the current bend
 * plane and the end segment's world orientation.
 */
export function solveLimbIK(fig: Figure, s: Side, limb: 'arm' | 'leg', target: THREE.Vector3): void {
  const [aN, bN, cN] = limb === 'arm' ? [`upperarm_${s}`, `forearm_${s}`, `hand_${s}`] : [`thigh_${s}`, `shin_${s}`, `foot_${s}`];
  const A = fig.worldPos(aN);
  const B = fig.worldPos(bN);
  const C = fig.worldPos(cN);
  const endQ = fig.worldQuat(cN);
  const upperQ = fig.worldQuat(aN);
  const a = A.distanceTo(B);
  const b = B.distanceTo(C);
  const toT = sub(target, A);
  const d = THREE.MathUtils.clamp(toT.length(), Math.abs(a - b) + 1e-4, a + b - 1e-4);
  const dir = toT.lengthSq() > 1e-10 ? toT.normalize() : sub(C, A).normalize();
  let pole = perp(sub(B, A), dir);
  if (pole.lengthSq() < 1e-8) {
    // Straight limb: elbows bend backward (away from +Z of the upper arm), knees bend forward.
    pole = perp(axis(upperQ, Z).multiplyScalar(limb === 'arm' ? -1 : 1), dir);
  }
  pole.normalize();
  const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const E = A.clone().addScaledVector(dir, a * cosA).addScaledVector(pole, a * sinA);
  const W = A.clone().addScaledVector(dir, d);
  // Bone frames directly (no keypoint calibration); joint offsets lie along each bone's +Y.
  const frames = limb === 'arm' ? armFrames(sub(E, A), sub(W, E), axis(upperQ, Z), null) : legFrames(sub(E, A), sub(W, E), axis(upperQ, Z), null);
  const [q1, q2] = limb === 'arm' ? [(frames as ReturnType<typeof armFrames>).upper, (frames as ReturnType<typeof armFrames>).fore] : [(frames as ReturnType<typeof legFrames>).thigh, (frames as ReturnType<typeof legFrames>).shin];
  fig.setWorldQuat(aN, q1);
  fig.setWorldQuat(bN, q2);
  // Joint offsets aren't exactly on each bone's axis after body morphs; swing the whole limb so
  // the end lands on the target.
  for (let i = 0; i < 3; i++) {
    const end = sub(fig.worldPos(cN), A);
    const want = sub(target, A);
    if (end.lengthSq() < 1e-10 || want.lengthSq() < 1e-10) break;
    const swing = new THREE.Quaternion().setFromUnitVectors(end.normalize(), want.normalize());
    fig.setWorldQuat(aN, swing.multiply(fig.worldQuat(aN)));
  }
  fig.setWorldQuat(cN, endQ);
  fig.root.updateMatrixWorld(true);
}

/** World positions on the figure that correspond to each keypoint name. */
export function figureKeypoints(fig: Figure): Record<KeypointName, THREE.Vector3> {
  const L = fig.landmarks;
  const out = {} as Record<KeypointName, THREE.Vector3>;
  for (const s of SIDES) {
    const side = s === 'l' ? 'left' : 'right';
    out[`${side}_ear` as KeypointName] = fig.vertexWorld(L[`ear_${s}`]);
    out[`${side}_shoulder` as KeypointName] = fig.worldPos(`upperarm_${s}`);
    out[`${side}_elbow` as KeypointName] = fig.worldPos(`forearm_${s}`);
    out[`${side}_wrist` as KeypointName] = fig.worldPos(`hand_${s}`);
    out[`${side}_index` as KeypointName] = fig.worldPos(`index1_${s}`);
    out[`${side}_pinky` as KeypointName] = fig.worldPos(`pinky1_${s}`);
    out[`${side}_thumb` as KeypointName] = fig.worldPos(`thumb3_${s}`);
    out[`${side}_hip` as KeypointName] = fig.worldPos(`thigh_${s}`);
    out[`${side}_knee` as KeypointName] = fig.worldPos(`shin_${s}`);
    out[`${side}_ankle` as KeypointName] = fig.worldPos(`foot_${s}`);
    out[`${side}_heel` as KeypointName] = fig.vertexWorld(L[`heel_${s}`]);
    out[`${side}_foot_index` as KeypointName] = fig.vertexWorld(L[`toe_${s}`]);
  }
  out.nose = fig.vertexWorld(L.nose);
  return out;
}
