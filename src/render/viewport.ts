import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { OutlineEffect } from 'three/examples/jsm/effects/OutlineEffect.js';
import type { Figure } from '../figure/rig';
import { solveLimbIK } from '../figure/solver';
import { createHalftoneMaterial, createMaterials, type RenderStyle, type StyleMaterials } from './style';
import type { Side } from '../figure/params';

export type GizmoMode = 'rotate' | 'move';

const EFFECTORS: { name: string; joint: string; limb?: 'arm' | 'leg'; side?: Side }[] = [
  { name: 'pelvis', joint: 'pelvis' },
  { name: 'hand_l', joint: 'hand_l', limb: 'arm', side: 'l' },
  { name: 'hand_r', joint: 'hand_r', limb: 'arm', side: 'r' },
  { name: 'foot_l', joint: 'foot_l', limb: 'leg', side: 'l' },
  { name: 'foot_r', joint: 'foot_r', limb: 'leg', side: 'r' },
];

export interface ViewportEvents {
  onSelect(joint: string | null): void;
  onEditStart(): void;
  onEditChange(): void;
  onEditEnd(): void;
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly overlay = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;
  readonly materials: StyleMaterials;
  readonly grid: THREE.GridHelper;
  style: RenderStyle = 'manga';
  gizmoMode: GizmoMode = 'rotate';
  selected: string | null = null;
  /** When set, the canvas keeps this aspect ratio (to line up with the reference image). */
  lockedAspect: number | null = null;
  cameraLocked = false;
  pinFeet = true;
  highlightSelection = true;
  /** Screentone cell size in CSS pixels. */
  halftoneCell = 4.5;

  private outline: OutlineEffect;
  private rt: THREE.WebGLRenderTarget;
  private halftone = createHalftoneMaterial();
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private effectorObjs = new Map<string, THREE.Mesh>();
  private dragging = false;
  private footTargets: Record<Side, { pos: THREE.Vector3; quat: THREE.Quaternion }> | null = null;
  private resizeObserver: ResizeObserver;
  private frameEl: HTMLElement;

  constructor(
    private container: HTMLElement,
    private figure: Figure,
    private events: ViewportEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.frameEl = document.createElement('div');
    this.frameEl.className = 'viewport-frame';
    this.frameEl.appendChild(this.renderer.domElement);
    container.appendChild(this.frameEl);

    this.materials = createMaterials();
    this.outline = new OutlineEffect(this.renderer, { defaultThickness: 0.0042, defaultColor: [0.05, 0.05, 0.07] });
    this.rt = new THREE.WebGLRenderTarget(2, 2, { samples: 4, type: THREE.HalfFloatType });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.halftone);
    quad.frustumCulled = false;
    this.postScene.add(quad);

    this.scene.background = new THREE.Color(0xffffff);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x9a9aa8, 1.1);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(3, 2, -4);
    // The key light rides on the camera so the toon shading reads the same from any angle.
    key.position.set(-1.2, 1.6, 0.6);
    this.camera.add(key, key.target);
    key.target.position.set(0, 0, -1);
    this.scene.add(hemi, rim, this.camera);

    this.grid = new THREE.GridHelper(12, 48, 0x8f7dff, 0xc9c0ff);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.85;
    this.scene.add(this.grid);
    this.scene.add(figure.root);

    this.camera.position.set(0.4, 1.3, 3.6);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.target.set(0, 1.0, 0);
    this.orbit.enableDamping = true;
    this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSpace('local');
    this.gizmo.setSize(0.8);
    this.overlay.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const on = Boolean((e as unknown as { value: boolean }).value);
      this.dragging = on;
      this.orbit.enabled = !on && !this.cameraLocked;
      if (on) {
        this.captureFootTargets();
        this.events.onEditStart();
      } else {
        this.footTargets = null;
        this.events.onEditEnd();
      }
    });
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());

    for (const e of EFFECTORS) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(e.name === 'pelvis' ? 0.05 : 0.04, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xff3d7f, transparent: true, opacity: 0.55, depthTest: false }),
      );
      m.name = `effector_${e.name}`;
      m.userData.effector = e.name;
      m.visible = false;
      m.renderOrder = 10;
      this.overlay.add(m);
      this.effectorObjs.set(e.name, m);
    }

    this.bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  /** Called every frame before rendering (e.g. to re-skin construction lines). */
  beforeRender: (() => void) | null = null;

  /** Material used for the body in the current style. */
  skinMaterial(): THREE.Material {
    return this.style === 'clay' ? this.materials.clay : this.materials.skin;
  }

  setStyle(style: RenderStyle): void {
    this.style = style;
    const bg = style === 'blueprint' ? 0x2a17f5 : style === 'clay' ? 0xe9e7e4 : 0xffffff;
    this.scene.background = new THREE.Color(bg);
    this.grid.visible = style !== 'blueprint';
    this.refreshMaterials();
  }

  setLineWeight(thickness: number): void {
    this.materials.skin.userData.outlineParameters = { thickness, visible: thickness > 0 };
  }

  /** Applies the style's material and tints the selected joint's region. */
  refreshMaterials(): void {
    const fig = this.figure;
    fig.mesh.material = this.skinMaterial();
    const color = fig.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const sel = this.highlightSelection && this.selected ? fig.order.findIndex((j) => j.name === this.selected) : -1;
    const hl = new THREE.Color(0xffc94d);
    for (let i = 0; i < fig.dominant.length; i++) {
      if (fig.dominant[i] === sel) color.setXYZ(i, hl.r, hl.g, hl.b);
      else color.setXYZ(i, 1, 1, 1);
    }
    color.needsUpdate = true;
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.select(this.selected);
  }

  setCameraLocked(locked: boolean): void {
    this.cameraLocked = locked;
    this.orbit.enabled = !locked;
  }

  select(joint: string | null): void {
    this.selected = joint;
    this.gizmo.detach();
    for (const m of this.effectorObjs.values()) m.visible = this.gizmoMode === 'move';
    if (joint) {
      const eff = this.gizmoMode === 'move' ? this.effectorFor(joint) : null;
      if (eff) {
        this.gizmo.setMode('translate');
        this.gizmo.setSpace('world');
        this.gizmo.attach(this.effectorObjs.get(eff)!);
      } else {
        this.gizmo.setMode('rotate');
        this.gizmo.setSpace('local');
        this.gizmo.attach(this.figure.get(joint).obj);
      }
    }
    this.refreshMaterials();
    this.events.onSelect(joint);
  }

  /** Points the orbit camera at the figure from the front (or keeps the current direction). */
  frameFigure(keepDirection = true): void {
    const box = new THREE.Box3().setFromObject(this.figure.mesh, true);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.y, size.x, size.z) * 0.62;
    const dist = radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const dir = keepDirection ? this.camera.position.clone().sub(this.orbit.target).normalize() : new THREE.Vector3(0.15, 0.12, 1).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(center);
    this.orbit.update();
  }

  /** Changes FOV while keeping the subject the same size (dolly zoom), so only perspective changes. */
  dollyZoom(fov: number): void {
    const target = this.cameraLocked ? this.lockedTarget() : this.orbit.target;
    const oldHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const newHalf = Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const offset = this.camera.position.clone().sub(target);
    offset.multiplyScalar(oldHalf / newHalf);
    this.camera.position.copy(target).add(offset);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  private lockedTarget(): THREE.Vector3 {
    const hip = this.figure.worldPos('pelvis');
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const d = hip.clone().sub(this.camera.position).dot(fwd);
    return this.camera.position.clone().addScaledVector(fwd, d);
  }

  /** After a locked (matched) camera is released, orbit around the figure without a jump. */
  syncOrbitTarget(): void {
    const t = this.lockedTarget();
    this.orbit.target.copy(t);
    this.orbit.update();
  }

  screenshot(): string {
    this.render(true);
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Renders a clean JPEG (no gizmo/effectors) for sending to Claude. */
  captureForAnalysis(maxSize = 1024): { media_type: 'image/jpeg'; data: string } {
    this.render(true);
    const src = this.renderer.domElement;
    const scale = Math.min(1, maxSize / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * scale);
    c.height = Math.round(src.height * scale);
    c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
    return { media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.9).split(',')[1] };
  }

  get aspect(): number {
    return this.camera.aspect;
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect();
    let w = Math.max(1, rect.width);
    let h = Math.max(1, rect.height);
    if (this.lockedAspect) {
      if (w / h > this.lockedAspect) w = h * this.lockedAspect;
      else h = w / this.lockedAspect;
    }
    w = Math.floor(w);
    h = Math.floor(h);
    this.frameEl.style.width = `${w}px`;
    this.frameEl.style.height = `${h}px`;
    this.renderer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.rt.setSize(w * pr, h * pr);
    this.halftone.uniforms.resolution.value.set(w * pr, h * pr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get frame(): HTMLElement {
    return this.frameEl;
  }

  private effectorFor(joint: string): string | null {
    if (joint === 'pelvis' || joint === 'spine') return 'pelvis';
    const m = joint.match(/_(l|r)$/);
    if (!m) return null;
    if (/^(hand|forearm|thumb|index|middle|ring|pinky)/.test(joint)) return `hand_${m[1]}`;
    if (/^(foot|shin)/.test(joint)) return `foot_${m[1]}`;
    return null;
  }

  private captureFootTargets(): void {
    this.footTargets = {
      l: { pos: this.figure.worldPos('foot_l'), quat: this.figure.worldQuat('foot_l') },
      r: { pos: this.figure.worldPos('foot_r'), quat: this.figure.worldQuat('foot_r') },
    };
  }

  private onGizmoChange(): void {
    const obj = this.gizmo.object;
    if (!obj) return;
    const eff = obj.userData.effector as string | undefined;
    if (eff) {
      const def = EFFECTORS.find((e) => e.name === eff)!;
      const target = obj.getWorldPosition(new THREE.Vector3());
      if (def.limb && def.side) {
        solveLimbIK(this.figure, def.side, def.limb, target);
      } else {
        // Move the pelvis; keep the feet planted.
        const pelvis = this.figure.get('pelvis').obj;
        pelvis.position.copy(this.figure.root.worldToLocal(target.clone()));
        this.figure.root.updateMatrixWorld(true);
        if (this.pinFeet && this.footTargets) {
          for (const s of ['l', 'r'] as Side[]) {
            solveLimbIK(this.figure, s, 'leg', this.footTargets[s].pos);
            this.figure.setWorldQuat(`foot_${s}`, this.footTargets[s].quat);
          }
        }
      }
    }
    this.figure.root.updateMatrixWorld(true);
    this.events.onEditChange();
  }

  private bindPointer(): void {
    const el = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (!down || this.dragging) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      if (this.gizmoMode === 'move') {
        const hitsE = ray.intersectObjects([...this.effectorObjs.values()], false);
        if (hitsE.length) {
          this.select(EFFECTORS.find((x) => x.name === hitsE[0].object.userData.effector)!.joint);
          return;
        }
      }
      this.select(this.pickJoint(ray));
    });
  }

  /** Joint whose region of the skinned mesh is under the ray. */
  private pickJoint(ray: THREE.Raycaster): string | null {
    const mesh = this.figure.mesh;
    mesh.computeBoundingSphere();
    const hit = ray.intersectObject(mesh, false)[0];
    if (!hit?.face) return null;
    const v = new THREE.Vector3();
    let best = hit.face.a;
    let bestD = Infinity;
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const d = this.figure.vertexWorld(i, v).distanceToSquared(hit.point);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return this.figure.order[this.figure.dominant[best]].name;
  }

  private syncEffectors(): void {
    if (this.dragging) return;
    for (const e of EFFECTORS) {
      const m = this.effectorObjs.get(e.name)!;
      this.figure.worldPos(e.joint, m.position);
    }
  }

  render(clean = false): void {
    if (!this.cameraLocked) this.orbit.update();
    this.syncEffectors();
    this.beforeRender?.();
    const gizmoHelper = this.gizmo.getHelper();
    const gizmoWasVisible = gizmoHelper.visible;
    if (clean) gizmoHelper.visible = false;
    const effVis = [...this.effectorObjs.values()].map((m) => m.visible);
    if (clean) for (const m of this.effectorObjs.values()) m.visible = false;

    const r = this.renderer;
    r.autoClear = true;
    if (this.style === 'manga') {
      r.setRenderTarget(this.rt);
      this.outline.render(this.scene, this.camera);
      r.setRenderTarget(null);
      this.halftone.uniforms.tDiffuse.value = this.rt.texture;
      this.halftone.uniforms.cell.value = this.halftoneCell * r.getPixelRatio();
      r.render(this.postScene, this.postCam);
    } else if (this.style === 'clay') {
      r.render(this.scene, this.camera);
    } else {
      this.outline.render(this.scene, this.camera);
    }
    r.autoClear = false;
    r.clearDepth();
    r.render(this.overlay, this.camera);
    r.autoClear = true;

    if (clean) {
      gizmoHelper.visible = gizmoWasVisible;
      [...this.effectorObjs.values()].forEach((m, i) => (m.visible = effVis[i]));
    }
  }
}
