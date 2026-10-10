import * as THREE from 'three';
import type { KeypointName } from '../../shared/schema';
import { BASE, basisFromYX, basisFromYZ, sideSign, type Figure } from './rig';
import { SIDES, type Side } from './params';

export interface WorldKeypoint {
  p: THREE.Vector3;
  confidence: number;
}
export type WorldKeypoints = Record<KeypointName, WorldKeypoint>;

const X = new THREE.Vector3(1, 0, 0);
/** Angle of the nose tip below the ear line in a level head (radians). */
const NOSE_DROP = 0.085;
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

/**
 * Solves an arm from directions: `u` shoulder->elbow, `f` elbow->wrist (world space).
 * `twistHint` is used when the elbow is nearly straight; `handY`/`handZ` orient the hand if given.
 */
export function solveArm(
  fig: Figure,
  s: Side,
  u: THREE.Vector3,
  f: THREE.Vector3,
  twistHint: THREE.Vector3,
  hand: { y: THREE.Vector3; z: THREE.Vector3 } | THREE.Quaternion | null,
): void {
  u = u.clone().normalize();
  f = f.clone().normalize();
  const bend = u.angleTo(f);
  const bendDir = perp(f, u);
  const hint = perp(twistHint, u);
  if (hint.lengthSq() < 1e-8) hint.copy(perp(Y, u));
  hint.normalize();
  const w = bendDir.lengthSq() > 1e-8 ? smooth(0.12, 0.45, bend) : 0;
  const zAxis = hint.multiplyScalar(1 - w).add(bendDir.normalize().multiplyScalar(w));
  const upperQ = basisFromYZ(u, zAxis);
  fig.setWorldQuat(`upperarm_${s}`, upperQ);

  const hingeX = axis(upperQ, X);
  let foreQ = basisFromYX(f, hingeX);

  let handQ: THREE.Quaternion | null = null;
  if (hand instanceof THREE.Quaternion) {
    handQ = hand.clone();
  } else if (hand) {
    const hy = limitAngle(hand.y.clone().normalize(), f, THREE.MathUtils.degToRad(80));
    handQ = basisFromYZ(hy, hand.z);
  }
  if (handQ) {
    // Share the hand's twist with the forearm (radius/ulna rotate together with the wrist).
    const foreZ = axis(foreQ, Z);
    const handZ = perp(axis(handQ, Z), f).normalize();
    let twist = Math.atan2(new THREE.Vector3().crossVectors(foreZ, handZ).dot(f), foreZ.dot(handZ));
    twist = THREE.MathUtils.clamp(twist, -Math.PI * 0.75, Math.PI * 0.75);
    foreQ = new THREE.Quaternion().setFromAxisAngle(f, twist * 0.6).multiply(foreQ);
  }
  fig.setWorldQuat(`forearm_${s}`, foreQ);
  fig.setWorldQuat(`hand_${s}`, handQ ?? foreQ);
}

/** Solves a leg from directions: `t` hip->knee, `sh` knee->ankle. */
export function solveLeg(
  fig: Figure,
  s: Side,
  t: THREE.Vector3,
  sh: THREE.Vector3,
  twistHint: THREE.Vector3,
  foot: { y: THREE.Vector3 } | THREE.Quaternion | null,
): void {
  t = t.clone().normalize();
  sh = sh.clone().normalize();
  const bend = t.angleTo(sh);
  const bendDir = perp(sh, t).negate(); // the knee flexes backward, so the kneecap faces away from the shin
  const hint = perp(twistHint, t);
  if (hint.lengthSq() < 1e-8) hint.copy(perp(Z, t));
  hint.normalize();
  const w = bendDir.lengthSq() > 1e-8 ? smooth(0.12, 0.45, bend) : 0;
  const zAxis = hint.multiplyScalar(1 - w).add(bendDir.normalize().multiplyScalar(w));
  const thighQ = basisFromYZ(t, zAxis);
  fig.setWorldQuat(`thigh_${s}`, thighQ);
  const shinQ = basisFromYX(sh, axis(thighQ, X));
  fig.setWorldQuat(`shin_${s}`, shinQ);

  const restFoot = shinQ.clone().multiply(fig.get(`foot_${s}`).restLocal);
  if (foot instanceof THREE.Quaternion) {
    fig.setWorldQuat(`foot_${s}`, foot);
  } else if (foot) {
    // Keep the ankle within a plausible range of the shin.
    const restY = axis(restFoot, Y);
    const fy = limitAngle(foot.y.clone().normalize(), restY, THREE.MathUtils.degToRad(60));
    fig.setWorldQuat(`foot_${s}`, basisFromYZ(fy, sh.clone().negate()));
  } else {
    fig.setWorldQuat(`foot_${s}`, restFoot);
  }
}

/**
 * Retargets keypoints (world space, any scale) onto the figure's bones. Only directions are used,
 * so the figure keeps its own proportions.
 */
export function solveFromKeypoints(fig: Figure, kp: WorldKeypoints): void {
  const P = (n: KeypointName) => kp[n].p;
  const ok = (n: KeypointName, min = 0.15) => kp[n].confidence >= min;

  const hipMid = mid(P('left_hip'), P('right_hip'));
  const shMid = mid(P('left_shoulder'), P('right_shoulder'));
  const up = sub(shMid, hipMid).normalize();
  const thighL = sub(P('left_knee'), P('left_hip')).normalize();
  const thighR = sub(P('right_knee'), P('right_hip')).normalize();
  // The thigh that hangs lowest relative to the torso; when both are raised (sitting) the pelvis tilts back.
  const lowThigh = thighL.dot(up) < thighR.dot(up) ? thighL : thighR;

  // Pelvis: hip line + torso direction, tilted a little by the thighs.
  const pelvisUp = up.clone().multiplyScalar(0.85).addScaledVector(lowThigh, -0.15).normalize();
  const pelvisQ = basisFromYX(pelvisUp, sub(P('left_hip'), P('right_hip')));
  // Chest: shoulder line + torso direction, bent a little further than the chord (spine curvature).
  const pelvisY = axis(pelvisQ, Y);
  const chestUp = up.clone().addScaledVector(sub(up, pelvisY), 0.6).normalize();
  const chestQ = basisFromYX(chestUp, sub(P('left_shoulder'), P('right_shoulder')));
  const spineQ = pelvisQ.clone().slerp(chestQ, 0.5);

  const pelvis = fig.get('pelvis').obj;
  const scale = fig.root.scale.x;
  const pelvisWorld = hipMid.clone().addScaledVector(pelvisUp, BASE.hipDrop * scale);
  pelvis.position.copy(fig.root.worldToLocal(pelvisWorld));
  fig.root.updateMatrixWorld(true);
  fig.setWorldQuat('pelvis', pelvisQ);
  fig.setWorldQuat('spine', spineQ);
  fig.setWorldQuat('chest', chestQ);

  // Head from the ear line and the nose.
  if (ok('nose') && ok('left_ear', 0.05) && ok('right_ear', 0.05)) {
    const earMid = mid(P('left_ear'), P('right_ear'));
    const xAxis = sub(P('left_ear'), P('right_ear')).normalize();
    // The nose tip sits below the ear line; tilt the forward vector up to compensate.
    const fwd = perp(sub(P('nose'), earMid), xAxis).normalize().applyAxisAngle(xAxis, -NOSE_DROP);
    const yAxis = new THREE.Vector3().crossVectors(fwd, xAxis);
    const headQ = basisFromYZ(yAxis, fwd);
    fig.setWorldQuat('neck', chestQ.clone().slerp(headQ, 0.45));
    fig.setWorldQuat('head', headQ);
  } else {
    fig.setWorldQuat('neck', chestQ);
    fig.setWorldQuat('head', chestQ);
  }

  const chestY = axis(chestQ, Y);
  const chestZ = axis(chestQ, Z);
  for (const s of SIDES) {
    const side = s === 'l' ? 'left' : 'right';
    const k = (n: string) => `${side}_${n}` as KeypointName;
    const u = sub(P(k('elbow')), P(k('shoulder'))).normalize();
    const f = sub(P(k('wrist')), P(k('elbow'))).normalize();
    autoClavicle(fig, s, u, chestQ);
    const twist = chestZ.clone().addScaledVector(chestY, u.dot(chestZ));
    let hand: { y: THREE.Vector3; z: THREE.Vector3 } | null = null;
    if (ok(k('index'), 0.3) && ok(k('pinky'), 0.3)) {
      const knuckles = mid(P(k('index')), P(k('pinky')));
      hand = { y: sub(knuckles, P(k('wrist'))), z: sub(P(k('index')), P(k('pinky'))) };
      if (hand.y.lengthSq() < 1e-8) hand = null;
    }
    solveArm(fig, s, u, f, twist, hand);

    const pz = axis(pelvisQ, Z);
    const py = axis(pelvisQ, Y);
    const t = sub(P(k('knee')), P(k('hip'))).normalize();
    const sh = sub(P(k('ankle')), P(k('knee'))).normalize();
    const legTwist = pz.clone().addScaledVector(py, t.dot(pz));
    let foot: { y: THREE.Vector3 } | null = null;
    if (ok(k('heel'), 0.3) && ok(k('foot_index'), 0.3)) {
      foot = { y: sub(P(k('foot_index')), P(k('heel'))) };
      if (foot.y.lengthSq() < 1e-8) foot = null;
    }
    solveLeg(fig, s, t, sh, legTwist, foot);
  }
  fig.root.updateMatrixWorld(true);
}

/** Raises the clavicle when the arm goes overhead, like the scapula's upward rotation. */
function autoClavicle(fig: Figure, s: Side, armDir: THREE.Vector3, chestQ: THREE.Quaternion) {
  const down = axis(chestQ, Y).negate();
  const elev = armDir.angleTo(down);
  const k = smooth(THREE.MathUtils.degToRad(70), THREE.MathUtils.degToRad(170), elev);
  const j = fig.get(`clavicle_${s}`);
  const q = new THREE.Quaternion().setFromAxisAngle(Z, sideSign(s) * THREE.MathUtils.degToRad(24) * k);
  j.obj.quaternion.copy(j.restLocal).multiply(q);
  j.obj.updateMatrixWorld(true);
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
  const twistHint = axis(upperQ, Z);
  if (limb === 'arm') solveArm(fig, s, sub(E, A), sub(W, E), twistHint, endQ);
  else solveLeg(fig, s, sub(E, A), sub(W, E), twistHint, endQ);
  fig.root.updateMatrixWorld(true);
}

/** World positions on the figure that correspond to each keypoint name. */
export function figureKeypoints(fig: Figure): Record<KeypointName, THREE.Vector3> {
  const h = fig.params.proportions.headSize;
  const local = (joint: string, x: number, y: number, z: number) =>
    fig.get(joint).obj.localToWorld(new THREE.Vector3(x, y, z));
  const out = {} as Record<KeypointName, THREE.Vector3>;
  for (const s of SIDES) {
    const side = s === 'l' ? 'left' : 'right';
    const fl = fig.params.proportions[`foot_${s}`];
    out[`${side}_ear` as KeypointName] = local('head', sideSign(s) * 0.079 * h, 0.07 * h, -0.006 * h);
    out[`${side}_shoulder` as KeypointName] = fig.worldPos(`upperarm_${s}`);
    out[`${side}_elbow` as KeypointName] = fig.worldPos(`forearm_${s}`);
    out[`${side}_wrist` as KeypointName] = fig.worldPos(`hand_${s}`);
    out[`${side}_index` as KeypointName] = fig.worldPos(`index1_${s}`);
    out[`${side}_pinky` as KeypointName] = fig.worldPos(`pinky1_${s}`);
    out[`${side}_thumb` as KeypointName] = fig.worldPos(`thumb3_${s}`);
    out[`${side}_hip` as KeypointName] = fig.worldPos(`thigh_${s}`);
    out[`${side}_knee` as KeypointName] = fig.worldPos(`shin_${s}`);
    out[`${side}_ankle` as KeypointName] = fig.worldPos(`foot_${s}`);
    out[`${side}_heel` as KeypointName] = local(`foot_${s}`, 0, -0.055 * fl, -0.06);
    out[`${side}_foot_index` as KeypointName] = local(`foot_${s}`, 0, 0.19 * fl, -0.06);
  }
  out.nose = local('head', 0, 0.06 * h, 0.112 * h);
  return out;
}

