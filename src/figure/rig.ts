import * as THREE from 'three';
import { defaultParams, SIDES, type FigureParams, type Proportions, type Side } from './params';

/**
 * Every joint's local frame follows one convention: +Y runs along the bone toward its child,
 * +Z is the segment's "front" (the direction an elbow flexes toward, the kneecap faces, the face
 * looks), and +X = Y x Z. For limbs hanging in the rest pose that makes the palm side of each hand
 * `medial(side) * X`.
 */

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type Finger = (typeof FINGERS)[number];

const PHALANX_LENGTHS: Record<Finger, [number, number, number]> = {
  thumb: [0.044, 0.034, 0.028],
  index: [0.044, 0.026, 0.021],
  middle: [0.048, 0.03, 0.022],
  ring: [0.045, 0.028, 0.021],
  pinky: [0.035, 0.021, 0.019],
};
export const FINGER_RADIUS: Record<Finger, number> = {
  thumb: 0.0115,
  index: 0.0098,
  middle: 0.01,
  ring: 0.0093,
  pinky: 0.0083,
};
const KNUCKLES: Record<Exclude<Finger, 'thumb'>, [number, number]> = {
  // [distance down the hand, offset toward the thumb side]
  index: [0.094, 0.025],
  middle: [0.098, 0.0075],
  ring: [0.094, -0.0095],
  pinky: [0.086, -0.0255],
};
const FINGER_SPLAY_DEG: Record<Exclude<Finger, 'thumb'>, number> = { index: 4, middle: 0, ring: -3, pinky: -7 };

export const BASE = {
  hipDrop: 0.06,
  hipHalfWidth: 0.09,
  spineOffset: 0.04,
  spine: 0.2,
  chest: 0.25,
  neck: 0.085,
  clavicle: 0.165,
  upperArm: 0.3,
  forearm: 0.26,
  hand: 0.19,
  thigh: 0.44,
  shin: 0.43,
  ankleHeight: 0.08,
  foot: 0.2,
};

/** +1 on the left side (+x), -1 on the right. */
export const sideSign = (s: Side) => (s === 'l' ? 1 : -1);
/** Sign of the local X axis that points toward the body's midline for a limb joint. */
export const medial = (s: Side) => (s === 'l' ? 1 : -1);

interface JointDef {
  name: string;
  parent: string | null;
  side?: Side;
  /** Rest orientation in world space (Y along the bone, Z the front hint)... */
  restY?: THREE.Vector3;
  restZ?: THREE.Vector3;
  /** ...or relative to the parent. */
  restLocal?: (side: Side) => THREE.Quaternion;
  offset: (p: Proportions, side: Side) => THREE.Vector3;
  length: (p: Proportions, side: Side) => number;
  finger?: { finger: Finger; index: number };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const DOWN = V(0, -1, 0);
const FWD = V(0, 0, 1);

export function basisFromYZ(y: THREE.Vector3, zHint: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  const Y = y.clone().normalize();
  const Z = zHint.clone().addScaledVector(Y, -zHint.dot(Y));
  if (Z.lengthSq() < 1e-10) Z.copy(Math.abs(Y.z) < 0.9 ? FWD : UP).addScaledVector(Y, -(Math.abs(Y.z) < 0.9 ? Y.z : Y.y));
  Z.normalize();
  const X = new THREE.Vector3().crossVectors(Y, Z);
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

export function basisFromYX(y: THREE.Vector3, xHint: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  const Y = y.clone().normalize();
  const X = xHint.clone().addScaledVector(Y, -xHint.dot(Y));
  if (X.lengthSq() < 1e-10) X.set(1, 0, 0).addScaledVector(Y, -Y.x);
  X.normalize();
  const Z = new THREE.Vector3().crossVectors(X, Y);
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
}

function buildDefs(): JointDef[] {
  const defs: JointDef[] = [
    {
      name: 'pelvis',
      parent: null,
      restY: UP,
      restZ: FWD,
      offset: (p) => V(0, pelvisHeight(p), 0),
      length: () => BASE.spineOffset,
    },
    {
      name: 'spine',
      parent: 'pelvis',
      restY: UP,
      restZ: FWD,
      offset: () => V(0, BASE.spineOffset, 0),
      length: (p) => BASE.spine * p.torsoLength,
    },
    {
      name: 'chest',
      parent: 'spine',
      restY: UP,
      restZ: FWD,
      offset: (p) => V(0, BASE.spine * p.torsoLength, 0),
      length: (p) => BASE.chest * p.torsoLength,
    },
    {
      name: 'neck',
      parent: 'chest',
      restY: UP,
      restZ: FWD,
      offset: (p) => V(0, BASE.chest * p.torsoLength, -0.012),
      length: (p) => BASE.neck * p.neckLength,
    },
    {
      name: 'head',
      parent: 'neck',
      restY: UP,
      restZ: FWD,
      offset: (p) => V(0, BASE.neck * p.neckLength, 0.008),
      length: (p) => 0.2 * p.headSize,
    },
  ];

  for (const s of SIDES) {
    const sx = sideSign(s);
    defs.push(
      {
        name: `clavicle_${s}`,
        parent: 'chest',
        side: s,
        restY: V(sx, 0.03, -0.24).normalize(),
        restZ: FWD,
        offset: (p) => V(sx * 0.018, BASE.chest * p.torsoLength * 0.74, 0.055),
        length: (p) => BASE.clavicle * p.shoulderWidth,
      },
      {
        name: `upperarm_${s}`,
        parent: `clavicle_${s}`,
        side: s,
        restY: DOWN,
        restZ: FWD,
        offset: (p) => V(0, BASE.clavicle * p.shoulderWidth, 0),
        length: (p, side) => BASE.upperArm * p[`upperArm_${side}`],
      },
      {
        name: `forearm_${s}`,
        parent: `upperarm_${s}`,
        side: s,
        restY: DOWN,
        restZ: FWD,
        offset: (p, side) => V(0, BASE.upperArm * p[`upperArm_${side}`], 0),
        length: (p, side) => BASE.forearm * p[`forearm_${side}`],
      },
      {
        name: `hand_${s}`,
        parent: `forearm_${s}`,
        side: s,
        restY: DOWN,
        restZ: FWD,
        offset: (p, side) => V(0, BASE.forearm * p[`forearm_${side}`], 0),
        length: (p, side) => 0.095 * p[`hand_${side}`],
      },
      {
        name: `thigh_${s}`,
        parent: 'pelvis',
        side: s,
        restY: DOWN,
        restZ: FWD,
        offset: (p) => V(sx * BASE.hipHalfWidth * p.hipWidth, -BASE.hipDrop, 0),
        length: (p, side) => BASE.thigh * p[`thigh_${side}`],
      },
      {
        name: `shin_${s}`,
        parent: `thigh_${s}`,
        side: s,
        restY: DOWN,
        restZ: FWD,
        offset: (p, side) => V(0, BASE.thigh * p[`thigh_${side}`], 0),
        length: (p, side) => BASE.shin * p[`shin_${side}`],
      },
      {
        name: `foot_${s}`,
        parent: `shin_${s}`,
        side: s,
        restY: FWD,
        restZ: UP,
        offset: (p, side) => V(0, BASE.shin * p[`shin_${side}`], 0),
        length: (p, side) => BASE.foot * p[`foot_${side}`],
      },
    );

    for (const f of FINGERS) {
      for (let i = 1; i <= 3; i++) {
        const name = `${f}${i}_${s}`;
        const parent = i === 1 ? `hand_${s}` : `${f}${i - 1}_${s}`;
        const len = PHALANX_LENGTHS[f];
        defs.push({
          name,
          parent,
          side: s,
          finger: { finger: f, index: i },
          restLocal:
            i === 1
              ? (side) => (f === 'thumb' ? thumbRest(side) : splay(FINGER_SPLAY_DEG[f]))
              : () => new THREE.Quaternion(),
          offset: (p, side) => {
            const h = p[`hand_${side}`];
            if (i > 1) return V(0, len[i - 2] * h, 0);
            if (f === 'thumb') return V(medial(side) * 0.012, 0.016, 0.02).multiplyScalar(h);
            const [y, z] = KNUCKLES[f];
            return V(0, y, z).multiplyScalar(h);
          },
          length: (p, side) => len[i - 1] * p[`hand_${side}`],
        });
      }
    }
  }
  return defs;
}

function splay(deg: number) {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(deg));
}

/** Thumb metacarpal: points down and forward out of the palm; flexes toward the palm like the fingers. */
function thumbRest(side: Side) {
  const m = medial(side);
  const y = V(m * 0.3, 1, 0.55).normalize();
  // Fingers flex toward +m*X. For the thumb, that flex direction is across the palm toward the pinky.
  const flex = V(m * 0.75, 0.1, -0.65);
  return basisFromYX(y, flex.multiplyScalar(m));
}

export function pelvisHeight(p: Proportions): number {
  const leg = (BASE.thigh * (p.thigh_l + p.thigh_r)) / 2 + (BASE.shin * (p.shin_l + p.shin_r)) / 2;
  return BASE.hipDrop + leg + BASE.ankleHeight;
}

export interface Joint {
  name: string;
  def: JointDef;
  obj: THREE.Object3D;
  parent: Joint | null;
  children: Joint[];
  side: Side | null;
  restLocal: THREE.Quaternion;
  length: number;
}

export interface PoseSnapshot {
  pelvisPosition: [number, number, number];
  joints: Record<string, [number, number, number, number]>;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class Figure {
  readonly root = new THREE.Group();
  readonly joints = new Map<string, Joint>();
  readonly order: Joint[] = [];
  params: FigureParams;

  constructor(params: FigureParams = defaultParams()) {
    this.params = params;
    this.root.name = 'figure';
    const worldRest = new Map<string, THREE.Quaternion>();
    for (const def of buildDefs()) {
      const obj = new THREE.Object3D();
      obj.name = def.name;
      const parent = def.parent ? this.joints.get(def.parent)! : null;
      const side = def.side ?? null;
      const parentWorld = parent ? worldRest.get(parent.name)! : new THREE.Quaternion();
      let world: THREE.Quaternion;
      if (def.restLocal) {
        world = parentWorld.clone().multiply(def.restLocal(side ?? 'l'));
      } else {
        world = basisFromYZ(def.restY!, def.restZ!);
      }
      worldRest.set(def.name, world);
      const restLocal = parentWorld.clone().invert().multiply(world);
      obj.quaternion.copy(restLocal);
      const joint: Joint = { name: def.name, def, obj, parent, children: [], side, restLocal, length: 0 };
      (parent ? parent.obj : this.root).add(obj);
      parent?.children.push(joint);
      this.joints.set(def.name, joint);
      this.order.push(joint);
    }
    this.updateProportions(true);
  }

  get(name: string): Joint {
    const j = this.joints.get(name);
    if (!j) throw new Error(`Unknown joint ${name}`);
    return j;
  }

  /** Re-applies bone lengths and offsets. Rotations (the pose) are untouched. */
  updateProportions(resetPelvis = false): void {
    const p = this.params.proportions;
    this.root.scale.setScalar(p.height);
    for (const j of this.order) {
      const off = j.def.offset(p, j.side ?? 'l');
      if (j.name === 'pelvis') {
        if (resetPelvis) j.obj.position.copy(off);
      } else {
        j.obj.position.copy(off);
      }
      j.length = j.def.length(p, j.side ?? 'l');
    }
    this.root.updateMatrixWorld(true);
  }

  /** Standing height of the pelvis for the current proportions (figure-local units). */
  restPelvisHeight(): number {
    return pelvisHeight(this.params.proportions);
  }

  worldPos(name: string, out = new THREE.Vector3()): THREE.Vector3 {
    return this.get(name).obj.getWorldPosition(out);
  }

  worldQuat(name: string, out = new THREE.Quaternion()): THREE.Quaternion {
    return this.get(name).obj.getWorldQuaternion(out);
  }

  /** Sets a joint's world orientation; parents must already be up to date. */
  setWorldQuat(name: string, q: THREE.Quaternion): void {
    const j = this.get(name);
    const parentWorld = j.parent ? j.parent.obj.getWorldQuaternion(_q2) : this.root.getWorldQuaternion(_q2);
    j.obj.quaternion.copy(parentWorld.invert().multiply(q));
    j.obj.updateMatrixWorld(true);
  }

  /** Rotation relative to the rest pose, as used by the joint sliders. */
  getDelta(name: string, out = new THREE.Quaternion()): THREE.Quaternion {
    const j = this.get(name);
    return out.copy(j.restLocal).invert().multiply(j.obj.quaternion);
  }

  setDelta(name: string, delta: THREE.Quaternion): void {
    const j = this.get(name);
    j.obj.quaternion.copy(j.restLocal).multiply(delta);
    j.obj.updateMatrixWorld(true);
  }

  resetPose(): void {
    for (const j of this.order) j.obj.quaternion.copy(j.restLocal);
    this.get('pelvis').obj.position.set(0, this.restPelvisHeight(), 0);
    this.applyHands();
    this.root.updateMatrixWorld(true);
  }

  /** A relaxed standing pose: arms slightly away from the body, soft elbows and knees. */
  naturalPose(): void {
    this.resetPose();
    const rot = (name: string, x: number, y: number, z: number) => {
      const e = new THREE.Euler(
        THREE.MathUtils.degToRad(x),
        THREE.MathUtils.degToRad(y),
        THREE.MathUtils.degToRad(z),
      );
      this.setDelta(name, new THREE.Quaternion().setFromEuler(e));
    };
    for (const s of SIDES) {
      const m = medial(s);
      rot(`upperarm_${s}`, 2, 0, m * 9);
      rot(`forearm_${s}`, 14, 0, 0);
      rot(`hand_${s}`, 0, m * 10, 0);
      rot(`thigh_${s}`, 0, 0, m * 3);
      rot(`foot_${s}`, 0, 0, 0);
    }
    rot('head', -3, 0, 0);
    this.root.updateMatrixWorld(true);
  }

  /** Drives finger joints from the per-hand curl / spread parameters. */
  applyHands(): void {
    const deg = THREE.MathUtils.degToRad;
    const ax = new THREE.Vector3();
    for (const s of SIDES) {
      const hp = this.params.hands[s];
      const m = medial(s);
      for (const f of FINGERS) {
        for (let i = 1; i <= 3; i++) {
          const j = this.get(`${f}${i}_${s}`);
          const curl = f === 'thumb' ? hp.thumbCurl : hp.curl;
          const curlDeg = f === 'thumb' ? [25, 45, 55][i - 1] : [80, 95, 65][i - 1];
          // Rotating about local Z by -m*angle moves +Y toward the palm (+m*X).
          _q.setFromAxisAngle(ax.set(0, 0, 1), -m * deg(curlDeg * curl));
          if (i === 1) {
            const spreadDeg = f === 'thumb' ? 30 : { index: 10, middle: 1, ring: -8, pinky: -18 }[f];
            _q2.setFromAxisAngle(ax.set(1, 0, 0), deg(spreadDeg * hp.spread));
            j.obj.quaternion.copy(j.restLocal).multiply(_q2).multiply(_q);
          } else {
            j.obj.quaternion.copy(j.restLocal).multiply(_q);
          }
        }
      }
    }
    this.root.updateMatrixWorld(true);
  }

  snapshot(): PoseSnapshot {
    const joints: PoseSnapshot['joints'] = {};
    for (const j of this.order) {
      const q = j.obj.quaternion;
      joints[j.name] = [q.x, q.y, q.z, q.w];
    }
    const p = this.get('pelvis').obj.position;
    return { pelvisPosition: [p.x, p.y, p.z], joints };
  }

  restore(s: PoseSnapshot): void {
    for (const [name, q] of Object.entries(s.joints)) {
      this.joints.get(name)?.obj.quaternion.set(q[0], q[1], q[2], q[3]);
    }
    this.get('pelvis').obj.position.fromArray(s.pelvisPosition);
    this.root.updateMatrixWorld(true);
  }

  /** Name of the joint on the other side of the body (or itself for the spine/head). */
  static counterpart(name: string): string {
    if (name.endsWith('_l')) return `${name.slice(0, -2)}_r`;
    if (name.endsWith('_r')) return `${name.slice(0, -2)}_l`;
    return name;
  }

  /**
   * Copies one side's limbs onto the other (mirror = false keeps the other side, mirror = true
   * swaps both sides and flips the torso, i.e. the whole pose is reflected).
   */
  mirrorPose(from: Side | 'flip'): void {
    const flipX = (v: THREE.Vector3) => v.set(-v.x, v.y, v.z);
    const frameOf = (q: THREE.Quaternion) => {
      const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      return { y, z };
    };
    const before = new Map<string, THREE.Quaternion>();
    for (const j of this.order) before.set(j.name, this.worldQuat(j.name));

    if (from === 'flip') {
      const pelvis = this.get('pelvis').obj.position;
      pelvis.x = -pelvis.x;
      // Reflect every world frame across the figure's YZ plane, top-down, swapping sides.
      // The pelvis heading is reflected around world Y so the figure stays in place.
      for (const j of this.order) {
        const src = before.get(Figure.counterpart(j.name))!;
        const { y, z } = frameOf(src);
        this.setWorldQuat(j.name, basisFromYZ(flipX(y), flipX(z)));
      }
    } else {
      const to: Side = from === 'l' ? 'r' : 'l';
      for (const j of this.order) {
        if (j.side !== to) continue;
        // Reflect relative to the torso segment the limb hangs from.
        const refName = j.name.startsWith('clavicle') || j.name.match(/^(upperarm|forearm|hand|thumb|index|middle|ring|pinky)/) ? 'chest' : 'pelvis';
        const ref = this.worldQuat(refName);
        const refInv = ref.clone().invert();
        const src = before.get(Figure.counterpart(j.name))!;
        const local = refInv.multiply(src);
        const { y, z } = frameOf(local);
        const mirrored = basisFromYZ(flipX(y), flipX(z));
        this.setWorldQuat(j.name, ref.clone().multiply(mirrored));
      }
    }
    this.root.updateMatrixWorld(true);
  }
}
