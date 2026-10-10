import * as THREE from 'three';
import type { Figure } from './rig';

/**
 * Joint rings: planar cuts through the rest mesh, perpendicular to a bone at a joint, limited to
 * vertices near the joint so they wrap the limb only.
 */
const RINGS: { at: string; axis: string; radius: number; region: string[] }[] = [
  { at: 'neck', axis: 'neck', radius: 0.1, region: ['neck', 'head'] },
  ...['l', 'r'].flatMap((s) => [
    { at: `upperarm_${s}`, axis: `upperarm_${s}`, radius: 0.16, region: [`upperarm_${s}`, `clavicle_${s}`] },
    { at: `forearm_${s}`, axis: `forearm_${s}`, radius: 0.11, region: [`upperarm_${s}`, `forearm_${s}`] },
    { at: `hand_${s}`, axis: `forearm_${s}`, radius: 0.07, region: [`forearm_${s}`, `hand_${s}`] },
    { at: `shin_${s}`, axis: `thigh_${s}`, radius: 0.13, region: [`thigh_${s}`, `shin_${s}`] },
    { at: `foot_${s}`, axis: `shin_${s}`, radius: 0.09, region: [`shin_${s}`, `foot_${s}`] },
  ]),
];

/** The hip ("brief") line follows where the legs' skin weights take over from the pelvis. */
const WEIGHT_LINES: string[][] = [
  ['thigh_l', 'shin_l', 'foot_l'],
  ['thigh_r', 'shin_r', 'foot_r'],
];

/**
 * Construction lines that ride on the posed mesh: the front/back center line and the joint
 * boundaries (neck, shoulders, elbows, wrists, waist, hips, knees, ankles), like the panel lines
 * on a drawing mannequin. Endpoints are interpolations between two mesh vertices, re-skinned on
 * the CPU each frame they are visible.
 */
export class GuideLines {
  readonly object: THREE.LineSegments;
  private a = new Uint16Array(0);
  private b = new Uint16Array(0);
  private t = new Float32Array(0);
  private verts = new Uint16Array(0);
  private skinned = new Float32Array(0);

  constructor(
    private figure: Figure,
    material: THREE.LineBasicMaterial,
  ) {
    this.object = new THREE.LineSegments(new THREE.BufferGeometry(), material);
    this.object.name = 'guides';
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
    figure.root.add(this.object);
    this.build();
  }

  /** Recomputes which edges carry lines (after the body shape changes). */
  build(): void {
    const fig = this.figure;
    const geo = fig.mesh.geometry;
    const index = geo.getIndex()!.array;
    const asset = fig.asset;
    const base = asset.positions;
    const n = asset.renderVertexCount;
    const order = fig.order.map((j) => j.name);
    const skinIdx = geo.getAttribute('skinIndex') as THREE.BufferAttribute;

    const a: number[] = [];
    const b: number[] = [];
    const t: number[] = [];
    const seg = (va: number, vb: number, ta: number, vc: number, vd: number, tc: number) => {
      a.push(va, vc);
      b.push(vb, vd);
      t.push(ta, tc);
    };

    // Vertex neighbours, for smoothing the weight fields so the lines don't zig-zag.
    const nbrs: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < index.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const p = index[i + e];
        const q = index[i + ((e + 1) % 3)];
        if (p < n && q < n) {
          nbrs[p].push(q);
          nbrs[q].push(p);
        }
      }
    }
    const smooth = (f: Float32Array, iterations: number) => {
      let cur = f;
      for (let it = 0; it < iterations; it++) {
        const next = new Float32Array(n);
        for (let v = 0; v < n; v++) {
          let sum = cur[v];
          for (const u of nbrs[v]) sum += cur[u];
          next[v] = sum / (nbrs[v].length + 1);
        }
        cur = next;
      }
      return cur;
    };

    const contour = (field: Float32Array, allowed: (v: number) => boolean) => {
      for (let i = 0; i < index.length; i += 3) {
        const tri = [index[i], index[i + 1], index[i + 2]];
        if (tri.some((v) => v >= n || !allowed(v))) continue;
        const pts: [number, number, number][] = [];
        for (let e = 0; e < 3; e++) {
          const p = tri[e];
          const q = tri[(e + 1) % 3];
          const fp = field[p];
          const fq = field[q];
          if ((fp < 0) !== (fq < 0)) pts.push([p, q, fp / (fp - fq)]);
        }
        if (pts.length === 2) seg(pts[0][0], pts[0][1], pts[0][2], pts[1][0], pts[1][1], pts[1][2]);
      }
    };

    for (const set of WEIGHT_LINES) {
      const ids = new Set(set.map((name) => order.indexOf(name)));
      const raw = new Float32Array(n);
      for (let v = 0; v < n; v++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (ids.has(skinIdx.getComponent(v, k))) w += asset.skinWeight[v * 4 + k];
        raw[v] = w;
      }
      const field = smooth(raw, 6);
      for (let v = 0; v < n; v++) field[v] -= 0.5;
      contour(field, () => true);
    }

    // Planar rings in the bind pose (geometry positions + bind bone matrices).
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const bind = (name: string) => fig.skeleton.boneInverses[order.indexOf(name)].clone().invert();
    for (const ring of RINGS) {
      const center = new THREE.Vector3().setFromMatrixPosition(bind(ring.at));
      const ax = new THREE.Vector3(0, 1, 0).transformDirection(bind(ring.axis));
      const region = new Set(ring.region.map((r) => order.indexOf(r)));
      const field = new Float32Array(n);
      const near = new Uint8Array(n);
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i).sub(center);
        const along = v.dot(ax);
        field[i] = along;
        let w = 0;
        for (let k = 0; k < 4; k++) if (region.has(skinIdx.getComponent(i, k))) w += asset.skinWeight[i * 4 + k];
        near[i] = w > 0.6 && v.addScaledVector(ax, -along).length() < ring.radius && Math.abs(along) < ring.radius ? 1 : 0;
      }
      contour(field, (i) => near[i] === 1);
    }

    // Center line: mesh edges lying on the symmetry plane, minus the inside of the mouth and
    // nostrils (vertices on the head whose normals point back toward the head's center).
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    const headIdx = order.indexOf('head');
    const headCenter = new THREE.Vector3().setFromMatrixPosition(fig.skeleton.boneInverses[headIdx].clone().invert());
    headCenter.y += 0.07;
    const inner = (i: number) => {
      if (fig.dominant[i] !== headIdx) return false;
      const out = new THREE.Vector3().fromBufferAttribute(pos, i).sub(headCenter);
      return out.dot(new THREE.Vector3().fromBufferAttribute(nrm, i)) < 0.3 * out.length();
    };
    const seen = new Set<number>();
    for (let i = 0; i < index.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const p = index[i + e];
        const q = index[i + ((e + 1) % 3)];
        if (p >= n || q >= n) continue;
        if (Math.abs(base[p * 3]) > 1e-5 || Math.abs(base[q * 3]) > 1e-5 || inner(p) || inner(q)) continue;
        const key = p < q ? p * 65536 + q : q * 65536 + p;
        if (seen.has(key)) continue;
        seen.add(key);
        seg(p, p, 0, q, q, 0);
      }
    }

    this.a = Uint16Array.from(a);
    this.b = Uint16Array.from(b);
    this.t = Float32Array.from(t);
    this.verts = Uint16Array.from(new Set([...a, ...b]));
    this.skinned = new Float32Array(n * 3);
    const g = this.object.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(a.length * 3), 3));
    this.update();
  }

  /** Re-skins the line endpoints to the current pose. */
  update(): void {
    if (!this.object.visible) return;
    const mesh = this.figure.mesh;
    const v = new THREE.Vector3();
    const s = this.skinned;
    for (const i of this.verts) {
      mesh.getVertexPosition(i, v);
      s[i * 3] = v.x;
      s[i * 3 + 1] = v.y;
      s[i * 3 + 2] = v.z;
    }
    const attr = this.object.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    for (let k = 0; k < this.a.length; k++) {
      const pa = this.a[k] * 3;
      const pb = this.b[k] * 3;
      const t = this.t[k];
      out[k * 3] = s[pa] + (s[pb] - s[pa]) * t;
      out[k * 3 + 1] = s[pa + 1] + (s[pb + 1] - s[pa + 1]) * t;
      out[k * 3 + 2] = s[pa + 2] + (s[pb + 2] - s[pa + 2]) * t;
    }
    attr.needsUpdate = true;
  }
}

/** A line material drawn slightly in front of the surface it lies on. */
export function createGuideMaterial(): THREE.LineBasicMaterial {
  const m = new THREE.LineBasicMaterial({ color: 0x202024 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n gl_Position.z -= 0.0015 * gl_Position.w;',
    );
  };
  return m;
}
