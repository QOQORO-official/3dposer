import * as THREE from 'three';
import { defaultParams, SIDES, type FigureParams, type Proportions, type Side } from './params';
import { DetailSharpener, groupCentroid, morphPositions, targetWeights, type HumanAsset } from './human';

/**
 * Every joint's local frame follows one convention: +Y runs along the bone toward its child,
 * +Z is the segment's "front" (the direction an elbow flexes toward, the kneecap faces, the face
 * looks), and +X = Y x Z. With that, the palm side of each hand is `medial(side) * X`.
 *
 * Joints are THREE.Bones driving one skinned mesh (the MakeHuman base mesh). Rest orientations
 * come from the mesh's A-pose; body shape comes from morph targets; limb lengths are applied by
 * stretching each bone's region of the mesh before binding.
 */

export const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type Finger = (typeof FINGERS)[number];

/** +1 on the left side (+x), -1 on the right. */
export const sideSign = (s: Side) => (s === 'l' ? 1 : -1);
/** Sign of the local X axis that points toward the palm / body midline for a limb joint. */
export const medial = (s: Side) => (s === 'l' ? 1 : -1);

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
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

interface JointDef {
  name: string;
  parent: string | null;
  side: Side | null;
  /** Group (joint or tip) the bone points at in the rest pose. */
  end: string;
  /** How bone length scales: along the bone, or uniformly (head, hands, feet). */
  stretch?: (p: Proportions) => { along: number; uniform?: boolean };
  finger?: { finger: Finger; index: number };
}

function buildDefs(): JointDef[] {
  const defs: JointDef[] = [
    { name: 'pelvis', parent: null, side: null, end: 'spine' },
    { name: 'spine', parent: 'pelvis', side: null, end: 'chest', stretch: (p) => ({ along: p.torsoLength }) },
    { name: 'chest', parent: 'spine', side: null, end: 'neck', stretch: (p) => ({ along: p.torsoLength }) },
    { name: 'neck', parent: 'chest', side: null, end: 'head', stretch: (p) => ({ along: p.neckLength }) },
    { name: 'head', parent: 'neck', side: null, end: 'head_top', stretch: (p) => ({ along: p.headSize, uniform: true }) },
  ];
  for (const s of SIDES) {
    defs.push(
      { name: `clavicle_${s}`, parent: 'chest', side: s, end: `upperarm_${s}` },
      { name: `upperarm_${s}`, parent: `clavicle_${s}`, side: s, end: `forearm_${s}`, stretch: (p) => ({ along: p[`upperArm_${s}`] }) },
      { name: `forearm_${s}`, parent: `upperarm_${s}`, side: s, end: `hand_${s}`, stretch: (p) => ({ along: p[`forearm_${s}`] }) },
      { name: `hand_${s}`, parent: `forearm_${s}`, side: s, end: `hand_mid_${s}`, stretch: (p) => ({ along: p[`hand_${s}`], uniform: true }) },
      { name: `thigh_${s}`, parent: 'pelvis', side: s, end: `shin_${s}`, stretch: (p) => ({ along: p[`thigh_${s}`] }) },
      { name: `shin_${s}`, parent: `thigh_${s}`, side: s, end: `foot_${s}`, stretch: (p) => ({ along: p[`shin_${s}`] }) },
      { name: `foot_${s}`, parent: `shin_${s}`, side: s, end: `toe_${s}`, stretch: (p) => ({ along: p[`foot_${s}`], uniform: true }) },
    );
    for (const f of FINGERS) {
      for (let i = 1; i <= 3; i++) {
        defs.push({
          name: `${f}${i}_${s}`,
          parent: i === 1 ? `hand_${s}` : `${f}${i - 1}_${s}`,
          side: s,
          end: i === 3 ? `${f}_tip_${s}` : `${f}${i + 1}_${s}`,
          finger: { finger: f, index: i },
          stretch: (p) => ({ along: p[`hand_${s}`], uniform: true }),
        });
      }
    }
  }
  return defs;
}

export interface Joint {
  name: string;
  def: JointDef;
  obj: THREE.Bone;
  parent: Joint | null;
  children: Joint[];
  side: Side | null;
  /** Rest rotation relative to the parent. */
  restLocal: THREE.Quaternion;
  /** Rest rotation in figure space. */
  restWorld: THREE.Quaternion;
  /** Current (proportioned) bone length in figure units. */
  length: number;
}

export interface PoseSnapshot {
  pelvisPosition: [number, number, number];
  joints: Record<string, [number, number, number, number]>;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);

export class Figure {
  readonly root = new THREE.Group();
  readonly joints = new Map<string, Joint>();
  readonly order: Joint[] = [];
  readonly mesh: THREE.SkinnedMesh;
  readonly skeleton: THREE.Skeleton;
  params: FigureParams;
  /** Increments whenever the body shape or proportions change. */
  shapeVersion = 0;
  /** Dominant joint (index in `order`) per vertex, for picking and highlighting. */
  readonly dominant: Uint8Array;
  /** Index in `order` of each asset joint. */
  private readonly assetJoint: number[];
  private morphed: Float32Array;
  private restPos = new Map<string, THREE.Vector3>();
  private pelvisRest = new THREE.Vector3();
  private hipToPelvis = new THREE.Vector3();
  /** Vertices used as landmarks (nose, ears, heels, toes). */
  readonly landmarks: Record<string, number> = {};
  private sharpener: DetailSharpener;
  private normalScratch: THREE.BufferGeometry;

  constructor(
    readonly asset: HumanAsset,
    params: FigureParams = defaultParams(),
  ) {
    this.params = params;
    this.root.name = 'figure';

    // Rest frames come from the unmorphed mesh so the pose stays stable while the body changes.
    const P = (g: string) => {
      const v = new THREE.Vector3();
      groupCentroid(asset, asset.positions, g, v);
      return v;
    };
    const X = (q: THREE.Quaternion) => new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const restWorld = new Map<string, THREE.Quaternion>();
    for (const def of buildDefs()) {
      const head = P(def.name);
      const dir = P(def.end).sub(head);
      const parent = def.parent ? this.joints.get(def.parent)! : null;
      const s = def.side ?? 'l';
      const m = medial(s);
      let q: THREE.Quaternion;
      if (def.name.startsWith('upperarm')) {
        // Bend plane from the slightly flexed rest elbow: the forearm swings toward +Z.
        const u = dir.clone().normalize();
        const fore = P(`hand_${s}`).sub(P(`forearm_${s}`));
        const bend = fore.addScaledVector(u, -fore.dot(u));
        q = basisFromYZ(dir, bend.lengthSq() > 1e-6 ? bend : FWD);
      } else if (def.name.startsWith('forearm') || def.name.startsWith('shin')) {
        q = basisFromYX(dir, X(restWorld.get(def.parent!)!));
      } else if (def.name.startsWith('hand')) {
        q = basisFromYZ(dir, P(`index1_${s}`).sub(P(`pinky1_${s}`)));
      } else if (def.name.startsWith('foot')) {
        q = basisFromYZ(dir, UP);
      } else if (def.finger) {
        const hq = restWorld.get(`hand_${s}`)!;
        if (def.finger.finger === 'thumb') {
          // The thumb flexes across the palm toward the little finger.
          const palm = X(hq).multiplyScalar(m);
          const towardPinky = new THREE.Vector3(0, 0, -1).applyQuaternion(hq);
          const flex = palm.multiplyScalar(0.6).addScaledVector(towardPinky, 0.8);
          q = basisFromYX(dir, flex.multiplyScalar(m));
        } else {
          q = basisFromYX(dir, X(hq));
        }
      } else {
        q = basisFromYZ(dir, FWD);
      }
      restWorld.set(def.name, q);
      const obj = new THREE.Bone();
      obj.name = def.name;
      const parentWorld = parent ? restWorld.get(parent.name)! : new THREE.Quaternion();
      const restLocal = parentWorld.clone().invert().multiply(q);
      obj.quaternion.copy(restLocal);
      const joint: Joint = { name: def.name, def, obj, parent, children: [], side: def.side, restLocal, restWorld: q, length: dir.length() };
      (parent ? parent.obj : this.root).add(obj);
      parent?.children.push(joint);
      this.joints.set(def.name, joint);
      this.order.push(joint);
    }

    this.assetJoint = asset.joints.map((n) => this.order.findIndex((j) => j.name === n));
    const n = asset.vertexCount;
    this.morphed = new Float32Array(n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    const skinIndex = new Uint16Array(n * 4);
    this.dominant = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0;
      for (let k = 0; k < 4; k++) {
        skinIndex[i * 4 + k] = this.assetJoint[asset.skinIndex[i * 4 + k]];
        if (asset.skinWeight[i * 4 + k] > asset.skinWeight[i * 4 + best]) best = k;
      }
      this.dominant[i] = skinIndex[i * 4 + best];
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(asset.skinWeight), 4));
    geo.setIndex(new THREE.BufferAttribute(asset.indices, 1));

    this.skeleton = new THREE.Skeleton(
      this.order.map((j) => j.obj),
      this.order.map(() => new THREE.Matrix4()),
    );
    this.mesh = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
    this.mesh.name = 'body';
    this.mesh.frustumCulled = false;
    this.mesh.bindMode = THREE.AttachedBindMode;
    this.root.add(this.mesh);
    // Bone inverses are filled in by updateShape(), in figure space (identity bind matrix).
    this.mesh.bind(this.skeleton, new THREE.Matrix4());

    // Sharpen the trunk and limbs; leave the face, hands and feet as modeled.
    const mask = new Float32Array(asset.renderVertexCount);
    const keep = /^(pelvis|spine|chest|clavicle|upperarm|forearm|thigh|shin)/;
    for (let i = 0; i < mask.length; i++) {
      for (let k = 0; k < 4; k++) {
        const name = this.order[skinIndex[i * 4 + k]].name;
        const w = asset.skinWeight[i * 4 + k];
        if (keep.test(name)) mask[i] += w;
        else if (name === 'neck') mask[i] += 0.5 * w;
      }
    }
    this.sharpener = new DetailSharpener(asset.renderVertexCount, asset.indices, mask);
    this.normalScratch = new THREE.BufferGeometry();
    this.normalScratch.setIndex(new THREE.BufferAttribute(asset.indices, 1));

    this.findLandmarks();
    this.updateShape(true);
  }

  get(name: string): Joint {
    const j = this.joints.get(name);
    if (!j) throw new Error(`Unknown joint ${name}`);
    return j;
  }

  /**
   * Re-evaluates morph targets and bone lengths, rebuilds the bind pose and the mesh.
   * Joint rotations (the pose) are untouched.
   */
  updateShape(resetPelvis = false): void {
    const asset = this.asset;
    const p = this.params.proportions;
    this.shapeVersion++;
    this.root.scale.setScalar(p.height);
    morphPositions(asset, targetWeights(this.params), this.morphed);
    if (this.params.body.definition > 0) {
      this.normalScratch.setAttribute('position', new THREE.BufferAttribute(this.morphed, 3));
      this.normalScratch.computeVertexNormals();
      const nrm = this.normalScratch.getAttribute('normal').array as Float32Array;
      this.sharpener.apply(this.morphed, nrm, 1.6 * this.params.body.definition);
    }

    const tmp = { x: 0, y: 0, z: 0 };
    const pos = (g: string) => {
      groupCentroid(asset, this.morphed, g, tmp);
      return new THREE.Vector3(tmp.x, tmp.y, tmp.z);
    };
    for (const j of this.order) {
      this.restPos.set(j.name, pos(j.name));
      this.restPos.set(j.def.end, pos(j.def.end));
    }

    // Proportioned bind skeleton: offsets are measured in the parent's rest frame and scaled by
    // the parent's stretch, so a longer upper arm moves the elbow and everything below it.
    const scaleOf = (j: Joint) => {
      const st = j.def.stretch?.(p) ?? { along: 1 };
      return st.uniform ? new THREE.Vector3(st.along, st.along, st.along) : new THREE.Vector3(1, st.along, 1);
    };
    const bindPos = new Map<string, THREE.Vector3>();
    const deform: Float32Array[] = [];
    for (const [i, j] of this.order.entries()) {
      const rest = this.restPos.get(j.name)!;
      const invRestQ = j.restWorld.clone().invert();
      let bp: THREE.Vector3;
      if (!j.parent) {
        bp = rest.clone();
        this.pelvisRest.copy(bp);
        if (resetPelvis) j.obj.position.copy(bp);
      } else {
        const pq = j.parent.restWorld;
        const local = rest.clone().sub(this.restPos.get(j.parent.name)!).applyQuaternion(pq.clone().invert());
        local.multiply(scaleOf(j.parent));
        j.obj.position.copy(local);
        bp = bindPos.get(j.parent.name)!.clone().add(local.clone().applyQuaternion(pq));
      }
      bindPos.set(j.name, bp);
      j.length = this.restPos.get(j.def.end)!.clone().sub(rest).applyQuaternion(invRestQ).multiply(scaleOf(j)).length();
      const bindM = new THREE.Matrix4().compose(bp, j.restWorld, ONE);
      this.skeleton.boneInverses[i].copy(bindM).invert();
      // Vertex deformation for this bone's region: rest frame -> stretched -> bind frame.
      const restInv = new THREE.Matrix4().compose(rest, j.restWorld, ONE).invert();
      const s = scaleOf(j);
      const d = bindM.multiply(new THREE.Matrix4().makeScale(s.x, s.y, s.z)).multiply(restInv);
      deform.push(new Float32Array(d.elements));
    }

    const hipMid = bindPos.get('thigh_l')!.clone().add(bindPos.get('thigh_r')!).multiplyScalar(0.5);
    this.hipToPelvis.copy(bindPos.get('pelvis')!).sub(hipMid).applyQuaternion(this.get('pelvis').restWorld.clone().invert());

    // Blend the per-bone deformations into the bind-pose mesh.
    const attr = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    const sw = asset.skinWeight;
    const src = this.morphed;
    for (let i = 0; i < asset.vertexCount; i++) {
      const x = src[i * 3];
      const y = src[i * 3 + 1];
      const z = src[i * 3 + 2];
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw[i * 4 + k];
        if (w === 0) continue;
        const m = deform[this.assetJoint[asset.skinIndex[i * 4 + k]]];
        ax += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
        ay += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
        az += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
      out[i * 3] = ax;
      out[i * 3 + 1] = ay;
      out[i * 3 + 2] = az;
    }
    attr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.root.updateMatrixWorld(true);
  }

  private findLandmarks(): void {
    const a = this.asset;
    const P = a.positions;
    const idx = (n: string) => this.order.findIndex((j) => j.name === n);
    const head = idx('head');
    const h = { x: 0, y: 0, z: 0 };
    groupCentroid(a, P, 'head', h);
    let nose = -1;
    let earL = -1;
    let earR = -1;
    for (let i = 0; i < a.renderVertexCount; i++) {
      if (this.dominant[i] !== head) continue;
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      const z = P[i * 3 + 2];
      if (Math.abs(x) < 0.004 && y > h.y && y < h.y + 0.1 && (nose < 0 || z > P[nose * 3 + 2])) nose = i;
      if (y > h.y && y < h.y + 0.09 && z < h.z + 0.02) {
        if (earL < 0 || x > P[earL * 3]) earL = i;
        if (earR < 0 || x < P[earR * 3]) earR = i;
      }
    }
    this.landmarks.nose = nose;
    this.landmarks.ear_l = earL;
    this.landmarks.ear_r = earR;
    for (const s of SIDES) {
      const foot = idx(`foot_${s}`);
      let heel = -1;
      let toe = -1;
      for (let i = 0; i < a.renderVertexCount; i++) {
        if (this.dominant[i] !== foot) continue;
        const y = P[i * 3 + 1];
        const z = P[i * 3 + 2];
        if (y < 0.04 && (heel < 0 || z < P[heel * 3 + 2])) heel = i;
        if (toe < 0 || z > P[toe * 3 + 2]) toe = i;
      }
      this.landmarks[`heel_${s}`] = heel;
      this.landmarks[`toe_${s}`] = toe;
    }
  }

  /** World position of a mesh vertex in the current pose. */
  vertexWorld(index: number, out = new THREE.Vector3()): THREE.Vector3 {
    this.mesh.getVertexPosition(index, out);
    return out.applyMatrix4(this.mesh.matrixWorld);
  }

  /** Pelvis joint relative to the hip-joint midpoint, in the pelvis frame (figure units). */
  pelvisFromHips(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.hipToPelvis);
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
    this.get('pelvis').obj.position.copy(this.pelvisRest);
    this.applyHands();
    this.root.updateMatrixWorld(true);
  }

  /** A relaxed standing pose: arms down at the sides, soft elbows, palms toward the thighs. */
  naturalPose(): void {
    this.resetPose();
    const world = (name: string, y: THREE.Vector3, z: THREE.Vector3) => this.setWorldQuat(name, basisFromYZ(y, z));
    for (const s of SIDES) {
      const sx = sideSign(s);
      world(`upperarm_${s}`, V(sx * 0.2, -1, -0.04), V(0, 0, 1));
      world(`forearm_${s}`, V(sx * 0.1, -1, 0.2), V(0, 0.2, 1));
      world(`hand_${s}`, V(sx * 0.04, -1, 0.12), V(0, 0, 1));
      world(`thigh_${s}`, V(sx * 0.05, -1, 0), V(0, 0, 1));
      world(`shin_${s}`, V(sx * 0.01, -1, -0.03), V(0, 0, 1));
      world(`foot_${s}`, V(sx * 0.15, -0.05, 1), V(0, 1, 0));
    }
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
          const curlDeg = f === 'thumb' ? [20, 40, 50][i - 1] : [75, 90, 60][i - 1];
          // Rotating about local Z by -m*angle moves +Y toward the palm (+m*X).
          _q.setFromAxisAngle(ax.set(0, 0, 1), -m * deg(curlDeg * curl));
          if (i === 1) {
            const spreadDeg = f === 'thumb' ? 25 : { index: 8, middle: 0, ring: -7, pinky: -15 }[f];
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

  /** Copies one side's limbs onto the other ('l' / 'r'), or reflects the whole pose ('flip'). */
  mirrorPose(from: Side | 'flip'): void {
    const flipX = (v: THREE.Vector3) => v.set(-v.x, v.y, v.z);
    const frameOf = (q: THREE.Quaternion) => ({
      y: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
      z: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    });
    const before = new Map<string, THREE.Quaternion>();
    for (const j of this.order) before.set(j.name, this.worldQuat(j.name));

    if (from === 'flip') {
      const pelvis = this.get('pelvis').obj.position;
      pelvis.x = -pelvis.x;
      for (const j of this.order) {
        const { y, z } = frameOf(before.get(Figure.counterpart(j.name))!);
        this.setWorldQuat(j.name, basisFromYZ(flipX(y), flipX(z)));
      }
    } else {
      const to: Side = from === 'l' ? 'r' : 'l';
      for (const j of this.order) {
        if (j.side !== to) continue;
        const refName = /^(clavicle|upperarm|forearm|hand|thumb|index|middle|ring|pinky)/.test(j.name) ? 'chest' : 'pelvis';
        const ref = this.worldQuat(refName);
        const local = ref.clone().invert().multiply(before.get(Figure.counterpart(j.name))!);
        const { y, z } = frameOf(local);
        this.setWorldQuat(j.name, ref.clone().multiply(basisFromYZ(flipX(y), flipX(z))));
      }
    }
    this.root.updateMatrixWorld(true);
  }
}
