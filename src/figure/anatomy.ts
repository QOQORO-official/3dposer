import * as THREE from 'three';
import { BASE, FINGER_RADIUS, FINGERS, medial, type Figure, type Joint } from './rig';
import { SIDES } from './params';

/**
 * Builds the mannequin's volumes as overlapping ellipsoids and tapered capsules parented to the
 * joints. Every shape carries `userData.joint` so clicks can select the joint, and `userData.group`
 * (a muscle-group name) so the UI can highlight what a slider controls. Ellipsoids are also kept in
 * a per-joint list for drawing construction lines on the surface.
 */

export interface Ellipsoid {
  center: THREE.Vector3;
  radii: THREE.Vector3;
  rotation: THREE.Quaternion;
}

const SPHERE = new THREE.SphereGeometry(1, 40, 28);

export interface AnatomyMaterials {
  skin: THREE.Material;
  guide: THREE.LineBasicMaterial;
}

type Vec = [number, number, number];

class Builder {
  readonly ellipsoids = new Map<string, Ellipsoid[]>();

  constructor(private materials: AnatomyMaterials) {}

  private group(j: Joint): THREE.Group {
    let g = j.obj.getObjectByName(`anat_${j.name}`) as THREE.Group | undefined;
    if (!g) {
      g = new THREE.Group();
      g.name = `anat_${j.name}`;
      j.obj.add(g);
    }
    return g;
  }

  ellip(j: Joint, group: string, c: Vec, r: Vec, rotDeg: Vec = [0, 0, 0], guide = true): THREE.Mesh {
    const mesh = new THREE.Mesh(SPHERE, this.materials.skin);
    mesh.position.set(...c);
    mesh.scale.set(Math.max(r[0], 1e-4), Math.max(r[1], 1e-4), Math.max(r[2], 1e-4));
    mesh.rotation.set(...(rotDeg.map(THREE.MathUtils.degToRad) as Vec));
    this.tag(mesh, j, group);
    this.group(j).add(mesh);
    if (guide) {
      const list = this.ellipsoids.get(j.name) ?? [];
      list.push({ center: mesh.position.clone(), radii: mesh.scale.clone(), rotation: mesh.quaternion.clone() });
      this.ellipsoids.set(j.name, list);
    }
    return mesh;
  }

  /**
   * A limb volume along +Y from y0 to y1. Radius goes r0 -> r1 with rounded ends; `sx`/`sz`
   * squash the cross-section, `bulge` adds a belly at `bulgeAt` (0..1).
   */
  limb(
    j: Joint,
    group: string,
    y0: number,
    y1: number,
    r0: number,
    r1: number,
    opts: { sx?: number; sz?: number; bulge?: number; bulgeAt?: number; offset?: Vec; cap?: number } = {},
  ): THREE.Mesh {
    const { sx = 1, sz = 1, bulge = 0, bulgeAt = 0.35, offset = [0, 0, 0], cap: capPow = 6 } = opts;
    const pts: THREE.Vector2[] = [];
    const n = 28;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      // Superellipse end caps: flat-ish sides, round ends.
      const cap = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * t - 1), capPow)), 1 / capPow);
      const belly = bulge * Math.exp(-Math.pow((t - bulgeAt) / 0.28, 2));
      const r = (r0 + (r1 - r0) * t + belly) * cap;
      pts.push(new THREE.Vector2(Math.max(r, 1e-4), y0 + (y1 - y0) * t));
    }
    const geo = new THREE.LatheGeometry(pts, 32);
    const mesh = new THREE.Mesh(geo, this.materials.skin);
    mesh.scale.set(sx, 1, sz);
    mesh.position.set(...offset);
    mesh.userData.ownsGeometry = true;
    this.tag(mesh, j, group);
    this.group(j).add(mesh);
    return mesh;
  }

  guideLine(j: Joint, points: THREE.Vector3[]): void {
    if (points.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geo, this.materials.guide);
    line.userData.ownsGeometry = true;
    line.userData.guide = true;
    line.renderOrder = 2;
    this.group(j).add(line);
  }

  private tag(mesh: THREE.Mesh, j: Joint, group: string) {
    mesh.userData.joint = j.name;
    mesh.userData.group = group;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
}

/** Removes all generated meshes from the figure. */
export function clearAnatomy(fig: Figure): void {
  for (const j of fig.order) {
    const g = j.obj.getObjectByName(`anat_${j.name}`);
    if (!g) continue;
    g.traverse((o) => {
      if (o.userData.ownsGeometry && (o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
    });
    j.obj.remove(g);
  }
}

/** Surface height (along +Z or -Z) of an axis-aligned ellipsoid at (x, y), or the center if outside. */
function surfZ(c: Vec, r: Vec, x: number, y: number, back = false): number {
  const k = 1 - ((x - c[0]) / r[0]) ** 2 - ((y - c[1]) / r[1]) ** 2;
  const d = r[2] * Math.sqrt(Math.max(0, k));
  return back ? c[2] - d : c[2] + d;
}

export function buildAnatomy(fig: Figure, materials: AnatomyMaterials, showGuides: boolean): void {
  clearAnatomy(fig);
  const b = new Builder(materials);
  const p = fig.params.proportions;
  const M = fig.params.muscles;
  const fat = M.bodyFat;
  const core = 0.94 + 0.3 * fat; // soft-tissue thickness on the core volumes
  const def = 1 - 0.45 * fat; // how much individual muscles stand out
  const mus = (v: number) => 0.35 + 0.65 * v; // muscle slider -> thickness factor (never fully flat)
  const head = p.headSize;
  const tl = p.torsoLength;

  // ---------- pelvis ----------
  {
    const j = fig.get('pelvis');
    const hw = p.hipWidth;
    const pelvisCore: Vec = [0, -0.035, -0.005];
    const pelvisR: Vec = [0.158 * hw * core, 0.115, 0.108 * core];
    b.ellip(j, 'pelvis', pelvisCore, pelvisR);
    b.ellip(j, 'abs', [0, -0.005, 0.022], [0.112 * hw * core, 0.088, 0.082 * core]);
    b.ellip(j, 'pelvis', [0, -0.105, 0.0], [0.075 * hw, 0.055, 0.07]);
    for (const s of SIDES) {
      const sx = s === 'l' ? 1 : -1;
      const g = mus(M.glutes);
      b.ellip(j, 'glutes', [sx * 0.07 * hw, -0.075, -0.052 - 0.01 * g], [0.08 * hw * (0.9 + 0.1 * g) * core, 0.095, 0.062 * g * core], [-12, 0, sx * -8]);
      // Gluteus medius / hip flesh above the trochanter.
      b.ellip(j, 'glutes', [sx * 0.12 * hw, -0.04, -0.01], [0.06 * core, 0.075, 0.075 * core], [0, 0, sx * 12]);
      b.ellip(j, 'pelvis', [sx * 0.135 * hw, -0.095, 0.0], [0.055 * core, 0.07, 0.068 * core]);
    }
    if (showGuides) {
      // Front center line on the lower belly.
      const pts: THREE.Vector3[] = [];
      for (let y = -0.1; y <= 0.06; y += 0.01) pts.push(new THREE.Vector3(0, y, surfZ([0, -0.005, 0.022], [0.112 * hw * core, 0.088, 0.082 * core], 0, y) + 0.002));
      b.guideLine(j, pts.filter((v) => v.z > 0.04));
    }
  }

  // ---------- abdomen ----------
  {
    const j = fig.get('spine');
    const L = BASE.spine * tl;
    const w = p.waistWidth;
    const c: Vec = [0, L * 0.45, -0.005];
    const r: Vec = [0.128 * w * core, L * 0.62, 0.097 * core];
    // A flat-sided trunk avoids a visible seam between pelvis and ribcage.
    b.limb(j, 'core', -0.06, L + 0.05, 0.142 * w * core, 0.136 * w * core, { sz: 0.7 / w, offset: [0, 0, -0.008], bulge: -0.01 * (1 - fat), bulgeAt: 0.55, cap: 2.5 });
    b.ellip(j, 'core', c, r, [0, 0, 0], false);
    const a = mus(M.abs) * def;
    if (a > 0.1) {
      for (const sx of [1, -1]) {
        for (const [i, y] of [L * 0.18, L * 0.47, L * 0.76].entries()) {
          const x = sx * 0.031;
          const pr: Vec = [0.03, 0.03 + 0.003 * i, 0.012 * a];
          b.ellip(j, 'abs', [x, y, surfZ(c, r, x, y) - pr[2] * 0.55], pr, [0, sx * 8, 0]);
        }
      }
    }
    const o = mus(M.obliques);
    for (const sx of [1, -1]) {
      b.ellip(j, 'obliques', [sx * 0.098 * w, L * 0.25, 0.005], [0.045 * o * core, L * 0.48, 0.072 * core], [0, 0, sx * -6]);
      // Erector spinae along the lower back.
      b.ellip(j, 'lats', [sx * 0.032, L * 0.45, -0.07 * core], [0.028, L * 0.55, 0.026], [0, 0, 0], false);
    }
    if (showGuides) {
      const pts: THREE.Vector3[] = [];
      for (let y = -0.02; y <= L + 0.02; y += 0.01) pts.push(new THREE.Vector3(0, y, surfZ(c, r, 0, y) + 0.0015 + (a > 0.1 ? 0.004 : 0)));
      b.guideLine(j, pts);
    }
  }

  // ---------- chest / ribcage / back ----------
  {
    const j = fig.get('chest');
    const L = BASE.chest * tl;
    const cw = p.chestWidth;
    const sw = p.shoulderWidth;
    const c: Vec = [0, L * 0.47, -0.016];
    const r: Vec = [0.145 * cw * core, L * 0.62, 0.112 * core];
    b.ellip(j, 'core', c, r);
    const ch = mus(M.chest) * def;
    for (const sx of [1, -1]) {
      const x = sx * 0.068 * cw;
      const y = L * 0.66;
      const pr: Vec = [0.08 * cw, 0.058, 0.022 * ch + 0.01];
      b.ellip(j, 'chest', [x, y, surfZ(c, r, x, y) - pr[2] * 0.5], pr, [8, sx * 18, sx * -14]);
      // Pec tendon sweeping toward the armpit.
      b.ellip(j, 'chest', [sx * 0.118 * cw * sw, L * 0.76, 0.035], [0.04, 0.035, 0.03 * ch + 0.004], [0, sx * 30, sx * -30], false);
      const la = mus(M.lats);
      b.ellip(j, 'lats', [sx * (0.105 * cw + 0.012 * la), L * 0.42, -0.035], [0.04 + 0.018 * la, L * 0.5, 0.062 * core], [0, sx * -10, sx * 10]);
      // Scapula / upper back.
      b.ellip(j, 'traps', [sx * 0.068, L * 0.64, -0.092 * core], [0.055, 0.065, 0.02], [0, sx * -15, 0]);
      const tr = mus(M.traps);
      b.ellip(j, 'traps', [sx * 0.07 * sw, L * 0.86, -0.035], [0.085 * sw, 0.03 + 0.016 * tr, 0.055], [0, 0, sx * -24]);
      // Shoulder girdle: bridges the ribcage to the deltoid over the acromion.
      b.ellip(j, 'deltoids', [sx * 0.125 * sw, L * 0.78, -0.012], [0.07 * sw, 0.048, 0.066], [0, 0, sx * -12], false);
      if (M.breasts > 0.05) {
        const br = M.breasts;
        const bx = sx * 0.075 * cw;
        const by = L * 0.55;
        const rr = 0.028 + 0.035 * br;
        b.ellip(j, 'breasts', [bx, by - 0.01 * br, surfZ(c, r, bx, by) + rr * 0.15], [rr * 1.05, rr * 0.95, rr * 0.9], [10, sx * 12, 0]);
      }
    }
    // Upper trapezius mass behind the neck.
    b.ellip(j, 'traps', [0, L * 0.94, -0.05], [0.065, 0.03 + 0.022 * mus(M.traps), 0.05]);
    if (showGuides) {
      const pts: THREE.Vector3[] = [];
      for (let y = -0.03; y <= L * 1.05; y += 0.01) pts.push(new THREE.Vector3(0, y, surfZ(c, r, 0, y) + 0.0015));
      b.guideLine(j, pts);
    }
  }

  // ---------- neck & head ----------
  {
    const j = fig.get('neck');
    const L = BASE.neck * p.neckLength;
    const n = mus(M.neck);
    b.limb(j, 'neck', -0.05, L + 0.03, 0.058 * (0.85 + 0.15 * n) * core, 0.047 * core, { sx: 1, sz: 1.02 });
    for (const sx of [1, -1]) {
      b.ellip(j, 'neck', [sx * 0.03, L * 0.45, 0.022], [0.016 * n, L * 0.85, 0.016 * n], [-22, 0, sx * 18], false);
    }
  }
  {
    const j = fig.get('head');
    const cranC: Vec = [0, 0.095 * head, -0.012 * head];
    const cranR: Vec = [0.077 * head, 0.1 * head, 0.097 * head];
    b.ellip(j, 'head', cranC, cranR);
    const faceC: Vec = [0, 0.038 * head, 0.03 * head];
    const faceR: Vec = [0.06 * head, 0.072 * head, 0.068 * head];
    b.ellip(j, 'head', faceC, faceR, [-8, 0, 0]);
    b.ellip(j, 'head', [0, -0.018 * head, 0.06 * head], [0.028 * head, 0.022 * head, 0.026 * head]);
    b.ellip(j, 'head', [0, 0.058 * head, 0.093 * head], [0.01 * head, 0.02 * head, 0.013 * head], [20, 0, 0], false);
    for (const sx of [1, -1]) {
      b.ellip(j, 'head', [sx * 0.075 * head, 0.068 * head, -0.008 * head], [0.009 * head, 0.028 * head, 0.017 * head], [0, sx * 15, 0], false);
    }
    if (showGuides) {
      const shapes = b.ellipsoids.get('head') ?? [];
      const o = new THREE.Vector3(0, 0.07 * head, 0);
      // Vertical center line over the skull and down the face.
      const vertical: THREE.Vector3[] = [];
      for (let a = -150; a <= 120; a += 4) {
        const t = THREE.MathUtils.degToRad(a);
        vertical.push(projectToShell(o, new THREE.Vector3(0, Math.sin(t), Math.cos(t)), shapes));
      }
      b.guideLine(j, vertical);
      // Eye line wrapping around the front of the head.
      const eye = new THREE.Vector3(0, 0.075 * head, 0);
      const brow: THREE.Vector3[] = [];
      for (let a = -100; a <= 100; a += 4) {
        const t = THREE.MathUtils.degToRad(a);
        brow.push(projectToShell(eye, new THREE.Vector3(Math.sin(t), 0, Math.cos(t)), shapes));
      }
      b.guideLine(j, brow);
    }
  }

  // ---------- arms ----------
  for (const s of SIDES) {
    const m = medial(s);
    {
      const j = fig.get(`clavicle_${s}`);
      b.limb(j, 'traps', 0, j.length, 0.016, 0.018, { sz: 0.9 });
    }
    {
      const j = fig.get(`upperarm_${s}`);
      const L = j.length;
      const d = mus(M.deltoids);
      const bi = mus(M.biceps) * def;
      const tri = mus(M.triceps) * def;
      b.limb(j, 'upperarm', -0.025, L + 0.015, 0.047 * core, 0.036 * core, { sx: 0.95 });
      // Deltoid: lateral, anterior and posterior heads capping the shoulder.
      b.ellip(j, 'deltoids', [-m * 0.01, 0.03, 0], [0.042 + 0.01 * d, 0.062 + 0.006 * d, 0.046 + 0.008 * d], [0, 0, m * -8]);
      b.ellip(j, 'deltoids', [-m * 0.002, 0.04, 0.024], [0.032 + 0.006 * d, 0.055, 0.024 + 0.012 * d], [-14, 0, 0]);
      b.ellip(j, 'deltoids', [-m * 0.002, 0.04, -0.024], [0.032 + 0.006 * d, 0.055, 0.022 + 0.01 * d], [14, 0, 0]);
      b.ellip(j, 'biceps', [m * 0.004, L * 0.56, 0.02], [0.03 + 0.004 * bi, L * 0.3, 0.02 + 0.016 * bi], [0, 0, 0]);
      b.ellip(j, 'triceps', [-m * 0.008, L * 0.4, -0.02], [0.032 + 0.004 * tri, L * 0.33, 0.02 + 0.016 * tri]);
      b.ellip(j, 'triceps', [-m * 0.022, L * 0.36, -0.006], [0.02 + 0.006 * tri, L * 0.25, 0.022], [0, 0, 0], false);
      b.ellip(j, 'upperarm', [0, L, -0.008], [0.032, 0.03, 0.03], [0, 0, 0], false);
    }
    {
      const j = fig.get(`forearm_${s}`);
      const L = j.length;
      const f = mus(M.forearms) * def;
      b.limb(j, 'forearm', -0.02, L + 0.005, 0.038 * core, 0.024, { sx: 0.82, sz: 1.08 });
      b.ellip(j, 'forearms', [-m * 0.014, L * 0.24, 0.012], [0.026 + 0.008 * f, L * 0.3, 0.026 + 0.008 * f], [0, 0, m * 6]);
      b.ellip(j, 'forearms', [m * 0.014, L * 0.3, 0.004], [0.024 + 0.008 * f, L * 0.32, 0.024 + 0.006 * f], [0, 0, -m * 4]);
      b.ellip(j, 'forearm', [0, L * 0.98, 0], [0.019, 0.02, 0.028], [0, 0, 0], false);
    }
    {
      const j = fig.get(`hand_${s}`);
      const h = p[`hand_${s}`];
      // Palm: thin along X (palm normal), wide along Z (thumb -> pinky).
      b.limb(j, 'hand', -0.004 * h, 0.1 * h, 0.04 * h, 0.043 * h, { sx: 0.4, offset: [-m * 0.002, 0, -0.002 * h], cap: 3.5 });
      b.ellip(j, 'hand', [m * 0.009, 0.035 * h, 0.018 * h], [0.013 * h, 0.03 * h, 0.019 * h], [0, 0, 0], false);
      b.ellip(j, 'hand', [m * 0.006, 0.055 * h, -0.025 * h], [0.011 * h, 0.04 * h, 0.014 * h], [0, 0, 0], false);
      for (const f of FINGERS) {
        for (let i = 1; i <= 3; i++) {
          const fj = fig.get(`${f}${i}_${s}`);
          const r = FINGER_RADIUS[f] * h * (i === 3 ? 0.88 : i === 2 ? 0.94 : 1);
          if (f === 'thumb' && i === 1) {
            b.limb(fj, 'hand', -0.006, fj.length + 0.004, 0.016 * h, r, { sx: 0.9 });
          } else {
            b.limb(fj, 'hand', -r * 0.6, fj.length + (i === 3 ? r * 0.5 : r * 0.2), r, r * 0.92, { sx: 0.92 });
          }
        }
      }
    }
  }

  // ---------- legs ----------
  for (const s of SIDES) {
    const m = medial(s);
    {
      const j = fig.get(`thigh_${s}`);
      const L = j.length;
      const q = mus(M.quads) * def;
      const hm = mus(M.hamstrings) * def;
      b.limb(j, 'thigh', -0.035, L + 0.01, 0.085 * core, 0.047 * core, { sx: 0.95, bulge: 0.01 * core, bulgeAt: 0.25 });
      b.ellip(j, 'quads', [0, L * 0.45, 0.03], [0.05, L * 0.4, 0.028 + 0.02 * q], [-3, 0, 0]);
      b.ellip(j, 'quads', [-m * 0.035, L * 0.45, 0.002], [0.034 + 0.012 * q, L * 0.38, 0.05], [0, 0, m * 4]);
      b.ellip(j, 'quads', [m * 0.03, L * 0.78, 0.022], [0.028 + 0.01 * q, 0.07, 0.028 + 0.01 * q], [0, 0, -m * 10]);
      b.ellip(j, 'hamstrings', [0, L * 0.5, -0.03], [0.05, L * 0.38, 0.03 + 0.016 * hm]);
      b.ellip(j, 'thigh', [m * 0.04, L * 0.22, -0.002], [0.035 * core, L * 0.24, 0.05 * core], [0, 0, -m * 8], false);
      // Knee.
      b.ellip(j, 'thigh', [0, L, 0.005], [0.043, 0.048, 0.043], [0, 0, 0], false);
      b.ellip(j, 'thigh', [0, L - 0.004, 0.04], [0.025, 0.03, 0.014], [0, 0, 0], false);
    }
    {
      const j = fig.get(`shin_${s}`);
      const L = j.length;
      const cv = mus(M.calves) * def;
      b.limb(j, 'shin', -0.02, L + 0.01, 0.048 * core, 0.027, { sx: 0.95 });
      b.ellip(j, 'calves', [m * 0.017, L * 0.27, -0.03], [0.033, L * 0.21, 0.025 + 0.017 * cv]);
      b.ellip(j, 'calves', [-m * 0.015, L * 0.25, -0.028], [0.03, L * 0.19, 0.022 + 0.015 * cv]);
      b.ellip(j, 'calves', [0, L * 0.5, -0.02], [0.036, L * 0.24, 0.022 + 0.006 * cv]);
      b.ellip(j, 'shin', [-m * 0.014, L * 0.3, 0.02], [0.022, L * 0.25, 0.02]);
      // Malleoli.
      b.ellip(j, 'shin', [m * 0.022, L - 0.008, 0], [0.014, 0.016, 0.016], [0, 0, 0], false);
      b.ellip(j, 'shin', [-m * 0.021, L + 0.004, -0.004], [0.013, 0.016, 0.015], [0, 0, 0], false);
    }
    {
      // Foot frame: +Y forward, +Z up. The sole sits at z = -ankleHeight.
      const j = fig.get(`foot_${s}`);
      const fl = p[`foot_${s}`];
      const ah = BASE.ankleHeight;
      b.ellip(j, 'foot', [0, -0.032 * fl, -ah + 0.035], [0.031, 0.04 * fl, 0.035]);
      b.ellip(j, 'foot', [m * 0.004, 0.06 * fl, -ah + 0.033], [0.04, 0.11 * fl, 0.034], [-6, 0, 0]);
      b.ellip(j, 'foot', [-m * 0.01, 0.07 * fl, -ah + 0.022], [0.028, 0.09 * fl, 0.022], [0, 0, 0], false);
      b.ellip(j, 'foot', [m * 0.008, 0.152 * fl, -ah + 0.018], [0.044, 0.048 * fl, 0.018], [0, 0, m * -8]);
      b.ellip(j, 'foot', [m * 0.022, 0.185 * fl, -ah + 0.017], [0.015, 0.025 * fl, 0.016], [0, 0, 0], false);
    }
  }
}

/** Farthest hit along a ray from `origin` against a set of ellipsoids, pushed out slightly. */
function projectToShell(origin: THREE.Vector3, dir: THREE.Vector3, shapes: Ellipsoid[]): THREE.Vector3 {
  let best = 0;
  const inv = new THREE.Quaternion();
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (const e of shapes) {
    inv.copy(e.rotation).invert();
    o.copy(origin).sub(e.center).applyQuaternion(inv).divide(e.radii);
    d.copy(dir).applyQuaternion(inv).divide(e.radii);
    const a = d.dot(d);
    const bq = 2 * o.dot(d);
    const c = o.dot(o) - 1;
    const disc = bq * bq - 4 * a * c;
    if (disc < 0) continue;
    const t = (-bq + Math.sqrt(disc)) / (2 * a);
    if (t > best) best = t;
  }
  return origin.clone().addScaledVector(dir, best * 1.012 + 0.0008);
}
