import type { FigureParams, Muscles } from './params';
import { SIDES } from './params';

/**
 * The human base mesh (MakeHuman, CC0) prepared by scripts/build-human.py: one continuous mesh
 * with skin weights for this app's joints and sparse morph targets for body shape and muscles.
 */
export interface HumanAsset {
  vertexCount: number;
  renderVertexCount: number;
  positions: Float32Array;
  indices: Uint16Array;
  skinIndex: Uint8Array;
  /** Normalized weights, 4 per vertex. */
  skinWeight: Float32Array;
  joints: string[];
  /** Vertex groups whose centroid is a joint (or a tip point). */
  groups: Record<string, number[]>;
  targets: Map<string, { idx: Uint16Array; delta: Int16Array }>;
  deltaScale: number;
}

interface AssetJson {
  vertexCount: number;
  renderVertexCount: number;
  layout: Record<'positions' | 'indices' | 'skinIndex' | 'skinWeight', { offset: number; bytes: number }>;
  joints: string[];
  groups: Record<string, number[]>;
  targets: { name: string; count: number; offset: number }[];
  deltaScale: number;
}

export async function loadHumanAsset(base = `${import.meta.env.BASE_URL}models/`): Promise<HumanAsset> {
  const [meta, buf] = await Promise.all([
    fetch(`${base}human.json`).then((r) => {
      if (!r.ok) throw new Error(`Could not load the human model (${r.status}).`);
      return r.json() as Promise<AssetJson>;
    }),
    fetch(`${base}human.bin`).then((r) => {
      if (!r.ok) throw new Error(`Could not load the human model (${r.status}).`);
      return r.arrayBuffer();
    }),
  ]);
  const L = meta.layout;
  const n = meta.vertexCount;
  const rawWeights = new Uint8Array(buf, L.skinWeight.offset, n * 4);
  const skinWeight = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) skinWeight[i] = rawWeights[i] / 255;
  const targets = new Map<string, { idx: Uint16Array; delta: Int16Array }>();
  for (const t of meta.targets) {
    targets.set(t.name, {
      idx: new Uint16Array(buf, t.offset, t.count),
      delta: new Int16Array(buf, t.offset + t.count * 2, t.count * 3),
    });
  }
  return {
    vertexCount: n,
    renderVertexCount: meta.renderVertexCount,
    positions: new Float32Array(buf, L.positions.offset, n * 3),
    indices: new Uint16Array(buf, L.indices.offset, L.indices.bytes / 2),
    skinIndex: new Uint8Array(buf, L.skinIndex.offset, n * 4),
    skinWeight,
    joints: meta.joints,
    groups: meta.groups,
    targets,
    deltaScale: meta.deltaScale,
  };
}

/**
 * MakeHuman's three-point blend for a slider with "average" at 0.5. Values above 1 extrapolate
 * the max target (used for the muscle slider).
 */
function tri(v: number): { min: number; average: number; max: number } {
  return {
    min: Math.max(0, 1 - 2 * v),
    average: Math.max(0, 1 - Math.abs(2 * v - 1)),
    max: Math.max(0, 2 * v - 1),
  };
}

const MUSCLE_TARGETS: Record<keyof Muscles, (sign: 'incr' | 'decr') => string[]> = {
  neck: (s) => [`neck-horiz-${s === 'incr' ? 'more' : 'less'}`],
  deltoids: (s) => SIDES.map((x) => `${x}-upperarm-shoulder-muscle-${s}`),
  chest: (s) => [`torso-pectoral-${s}`],
  lats: (s) => [`torso-dorsi-${s}`],
  vShape: (s) => [`torso-vshape-${s === 'incr' ? 'more' : 'less'}`],
  abs: (s) => [`stomach-tone-${s}`],
  belly: (s) => [`stomach-pregnant-${s}`],
  upperArms: (s) => SIDES.map((x) => `${x}-upperarm-muscle-${s}`),
  forearms: (s) => SIDES.map((x) => `${x}-lowerarm-muscle-${s}`),
  glutes: (s) => [`buttocks-${s}`],
  thighs: (s) => SIDES.map((x) => `${x}-upperleg-muscle-${s}`),
  calves: (s) => SIDES.map((x) => `${x}-lowerleg-muscle-${s}`),
};

/** Target weights for the current parameters. */
export function targetWeights(params: FigureParams): Map<string, number> {
  const w = new Map<string, number>();
  const add = (name: string, v: number) => {
    if (Math.abs(v) > 1e-4) w.set(name, (w.get(name) ?? 0) + v);
  };
  const b = params.body;
  const genders = { female: 1 - b.gender, male: b.gender };
  const mus = tri(b.muscle);
  const wei = tri(b.weight);
  for (const [g, gw] of Object.entries(genders)) {
    if (gw <= 0) continue;
    for (const r of ['african', 'asian', 'caucasian']) add(`race-${r}-${g}`, gw / 3);
    for (const [m, mw] of Object.entries(mus)) {
      for (const [x, xw] of Object.entries(wei)) add(`universal-${g}-${m}muscle-${x}weight`, gw * mw * xw);
    }
    add(`proportions-${g}`, gw * b.idealProportions);
  }
  const cup = tri(b.breastSize);
  add('breast-mincup', genders.female * cup.min);
  add('breast-maxcup', genders.female * cup.max);

  const signed = (incr: string, decr: string, v: number) => (v >= 0 ? add(incr, v) : add(decr, -v));
  signed('shoulder-increase', 'shoulder-decrease', b.shoulders);
  signed('torso-horiz-incr', 'torso-horiz-decr', b.chestWidth);
  signed('hip-horiz-incr', 'hip-horiz-decr', b.hips);

  for (const key of Object.keys(MUSCLE_TARGETS) as (keyof Muscles)[]) {
    const v = params.muscles[key];
    const names = MUSCLE_TARGETS[key](v >= 0 ? 'incr' : 'decr');
    for (const name of names) add(name, Math.abs(v));
  }
  return w;
}

/** Base positions plus weighted target deltas. */
export function morphPositions(asset: HumanAsset, weights: Map<string, number>, out: Float32Array = new Float32Array(asset.vertexCount * 3)): Float32Array {
  out.set(asset.positions);
  for (const [name, wt] of weights) {
    const t = asset.targets.get(name);
    if (!t) continue;
    const k = wt * asset.deltaScale;
    const { idx, delta } = t;
    for (let i = 0; i < idx.length; i++) {
      const o = idx[i] * 3;
      out[o] += delta[i * 3] * k;
      out[o + 1] += delta[i * 3 + 1] * k;
      out[o + 2] += delta[i * 3 + 2] * k;
    }
  }
  return out;
}

export function groupCentroid(asset: HumanAsset, positions: Float32Array, group: string, out: { x: number; y: number; z: number }): void {
  const ids = asset.groups[group];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const i of ids) {
    x += positions[i * 3];
    y += positions[i * 3 + 1];
    z += positions[i * 3 + 2];
  }
  out.x = x / ids.length;
  out.y = y / ids.length;
  out.z = z / ids.length;
}

/**
 * Exaggerates mid-frequency surface detail (muscle separations, collarbones, ribs) along the
 * normals: the difference between the surface and a smoothed copy of it, with its slow trend
 * removed so limbs don't inflate. `mask` (0..1 per vertex) limits it to the body.
 */
export class DetailSharpener {
  private readonly start: Int32Array;
  private readonly nbr: Int32Array;

  constructor(
    private readonly count: number,
    indices: ArrayLike<number>,
    private readonly mask: Float32Array,
  ) {
    const sets: Set<number>[] = Array.from({ length: count }, () => new Set());
    for (let i = 0; i < indices.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = indices[i + e];
        const b = indices[i + ((e + 1) % 3)];
        if (a < count && b < count) {
          sets[a].add(b);
          sets[b].add(a);
        }
      }
    }
    this.start = new Int32Array(count + 1);
    let total = 0;
    for (let v = 0; v < count; v++) {
      this.start[v] = total;
      total += sets[v].size;
    }
    this.start[count] = total;
    this.nbr = new Int32Array(total);
    for (let v = 0; v < count; v++) this.nbr.set([...sets[v]], this.start[v]);
  }

  private smooth(src: Float32Array, stride: number, iterations: number): Float32Array {
    let cur = src;
    for (let it = 0; it < iterations; it++) {
      const next = new Float32Array(cur.length);
      for (let v = 0; v < this.count; v++) {
        const a = this.start[v];
        const b = this.start[v + 1];
        for (let c = 0; c < stride; c++) {
          let sum = cur[v * stride + c];
          for (let k = a; k < b; k++) sum += cur[this.nbr[k] * stride + c];
          next[v * stride + c] = sum / (b - a + 1);
        }
      }
      cur = next;
    }
    return cur;
  }

  /** Applies in place to `pos` (xyz per vertex) using vertex normals `nrm`. */
  apply(pos: Float32Array, nrm: Float32Array, amount: number): void {
    if (amount <= 0) return;
    const n = this.count;
    const smoothed = this.smooth(pos.subarray(0, n * 3), 3, 5);
    const s = new Float32Array(n);
    for (let v = 0; v < n; v++) {
      const o = v * 3;
      s[v] = (pos[o] - smoothed[o]) * nrm[o] + (pos[o + 1] - smoothed[o + 1]) * nrm[o + 1] + (pos[o + 2] - smoothed[o + 2]) * nrm[o + 2];
    }
    const trend = this.smooth(s, 1, 12);
    for (let v = 0; v < n; v++) {
      const d = (s[v] - trend[v]) * amount * this.mask[v];
      const o = v * 3;
      pos[o] += d * nrm[o];
      pos[o + 1] += d * nrm[o + 1];
      pos[o + 2] += d * nrm[o + 2];
    }
  }
}
