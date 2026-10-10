import * as THREE from 'three';
import GUI, { type Controller } from 'lil-gui';
import type { Figure } from '../figure/rig';
import { PRESETS, SIDES, applyPreset, type Muscles, type Proportions } from '../figure/params';
import type { Viewport } from '../render/viewport';
import type { RenderStyle } from '../render/style';

const JOINT_LABELS: Record<string, string> = {
  pelvis: 'Hips / pelvis',
  spine: 'Abdomen',
  chest: 'Chest',
  neck: 'Neck',
  head: 'Head',
  clavicle: 'Shoulder (clavicle)',
  upperarm: 'Upper arm',
  forearm: 'Forearm',
  hand: 'Hand',
  thigh: 'Thigh',
  shin: 'Shin',
  foot: 'Foot',
};

export function jointLabel(name: string): string {
  const m = name.match(/^([a-z]+?)(\d)?_(l|r)$/);
  if (!m) return JOINT_LABELS[name] ?? name;
  const side = m[3] === 'l' ? 'Left' : 'Right';
  const base = JOINT_LABELS[m[1]] ?? `${m[1][0].toUpperCase()}${m[1].slice(1)}${m[2] ? ` ${m[2]}` : ''}`;
  return `${side} ${base.toLowerCase()}`;
}

export interface GuiContext {
  figure: Figure;
  viewport: Viewport;
  /** Anatomy shapes must be rebuilt (proportions or muscles changed). */
  onShapeChange(): void;
  /** Pose changed through a slider; `final` is true when the user releases it. */
  onPoseChange(final: boolean): void;
  onStyleChange(): void;
  settings: { guides: boolean; outline: number; halftone: number; dolly: boolean };
}

export interface GuiHandle {
  gui: GUI;
  refreshJoint(): void;
  refreshAll(): void;
}

const PROPORTION_LABELS: [keyof Proportions, string, number, number][] = [
  ['height', 'Overall height', 0.6, 1.4],
  ['headSize', 'Head size', 0.7, 1.5],
  ['neckLength', 'Neck length', 0.5, 1.8],
  ['torsoLength', 'Torso length', 0.75, 1.3],
  ['shoulderWidth', 'Shoulder width', 0.7, 1.4],
  ['chestWidth', 'Chest width', 0.75, 1.4],
  ['waistWidth', 'Waist width', 0.7, 1.5],
  ['hipWidth', 'Hip width', 0.75, 1.4],
];

const LIMB_LABELS: [string, string, number, number][] = [
  ['upperArm', 'Upper arm', 0.6, 1.5],
  ['forearm', 'Forearm', 0.6, 1.5],
  ['hand', 'Hand', 0.6, 1.5],
  ['thigh', 'Thigh', 0.6, 1.5],
  ['shin', 'Shin', 0.6, 1.5],
  ['foot', 'Foot', 0.6, 1.5],
];

const MUSCLE_LABELS: [keyof Muscles, string, number, number][] = [
  ['neck', 'Neck', 0, 2],
  ['traps', 'Trapezius', 0, 2],
  ['deltoids', 'Deltoids', 0, 2],
  ['chest', 'Pectorals', 0, 2],
  ['lats', 'Lats / back', 0, 2],
  ['abs', 'Abs', 0, 2],
  ['obliques', 'Obliques', 0, 2],
  ['biceps', 'Biceps', 0, 2],
  ['triceps', 'Triceps', 0, 2],
  ['forearms', 'Forearms', 0, 2],
  ['glutes', 'Glutes', 0, 2],
  ['quads', 'Quadriceps', 0, 2],
  ['hamstrings', 'Hamstrings', 0, 2],
  ['calves', 'Calves', 0, 2],
  ['bodyFat', 'Body fat', 0, 1],
  ['breasts', 'Breasts', 0, 2],
];

export function buildGui(container: HTMLElement, ctx: GuiContext): GuiHandle {
  const { figure, viewport } = ctx;
  const params = figure.params;
  const gui = new GUI({ container, title: 'Figure' });

  // ---------- selected joint ----------
  const jointFolder = gui.addFolder('Selected joint');
  const joint = { name: '(click the figure)', x: 0, y: 0, z: 0 };
  const nameCtrl = jointFolder.add(joint, 'name').name('Joint').disable();
  const angleCtrls: Controller[] = [];
  const applyJoint = (final: boolean) => {
    const sel = viewport.selected;
    if (!sel) return;
    const e = new THREE.Euler(
      THREE.MathUtils.degToRad(joint.x),
      THREE.MathUtils.degToRad(joint.y),
      THREE.MathUtils.degToRad(joint.z),
      'XYZ',
    );
    figure.setDelta(sel, new THREE.Quaternion().setFromEuler(e));
    ctx.onPoseChange(final);
  };
  for (const [k, label] of [
    ['x', 'Bend (X)'],
    ['y', 'Twist (Y)'],
    ['z', 'Side (Z)'],
  ] as const) {
    const c = jointFolder
      .add(joint, k, -180, 180, 0.5)
      .name(label)
      .onChange(() => applyJoint(false))
      .onFinishChange(() => applyJoint(true));
    angleCtrls.push(c);
  }
  jointFolder
    .add(
      {
        reset: () => {
          if (!viewport.selected) return;
          figure.setDelta(viewport.selected, new THREE.Quaternion());
          if (viewport.selected.match(/^(thumb|index|middle|ring|pinky)/)) figure.applyHands();
          refreshJoint();
          ctx.onPoseChange(true);
        },
      },
      'reset',
    )
    .name('Reset this joint');

  function refreshJoint() {
    const sel = viewport.selected;
    joint.name = sel ? jointLabel(sel) : '(click the figure)';
    if (sel) {
      const e = new THREE.Euler().setFromQuaternion(figure.getDelta(sel), 'XYZ');
      joint.x = +THREE.MathUtils.radToDeg(e.x).toFixed(1);
      joint.y = +THREE.MathUtils.radToDeg(e.y).toFixed(1);
      joint.z = +THREE.MathUtils.radToDeg(e.z).toFixed(1);
    }
    nameCtrl.updateDisplay();
    for (const c of angleCtrls) {
      c.enable(Boolean(sel));
      c.updateDisplay();
    }
  }

  // ---------- hands ----------
  const handsFolder = gui.addFolder('Hands');
  for (const s of SIDES) {
    const f = handsFolder.addFolder(s === 'l' ? 'Left hand' : 'Right hand');
    const hp = params.hands[s];
    const onHand = () => {
      figure.applyHands();
      ctx.onPoseChange(false);
    };
    f.add(hp, 'curl', 0, 1, 0.01).name('Finger curl').onChange(onHand).onFinishChange(() => ctx.onPoseChange(true));
    f.add(hp, 'thumbCurl', 0, 1, 0.01).name('Thumb curl').onChange(onHand).onFinishChange(() => ctx.onPoseChange(true));
    f.add(hp, 'spread', 0, 1, 0.01).name('Spread').onChange(onHand).onFinishChange(() => ctx.onPoseChange(true));
  }
  handsFolder.close();

  // ---------- body ----------
  const bodyFolder = gui.addFolder('Body type');
  const preset = { preset: 'Athletic male' };
  bodyFolder
    .add(preset, 'preset', Object.keys(PRESETS))
    .name('Preset')
    .onChange((name: string) => {
      applyPreset(params, name);
      refreshAll();
      ctx.onShapeChange();
    });

  const propFolder = gui.addFolder('Proportions');
  for (const [key, label, min, max] of PROPORTION_LABELS) {
    propFolder.add(params.proportions, key, min, max, 0.01).name(label).onChange(ctx.onShapeChange);
  }
  const link = { linked: true };
  propFolder.add(link, 'linked').name('Link left / right');
  const limbFolder = propFolder.addFolder('Limb lengths (L / R)');
  const limbCtrls: Controller[] = [];
  for (const [key, label, min, max] of LIMB_LABELS) {
    for (const s of SIDES) {
      const k = `${key}_${s}` as keyof Proportions;
      const other = `${key}_${s === 'l' ? 'r' : 'l'}` as keyof Proportions;
      const c = limbFolder
        .add(params.proportions, k, min, max, 0.01)
        .name(`${label} ${s.toUpperCase()}`)
        .onChange((v: number) => {
          if (link.linked) params.proportions[other] = v;
          for (const lc of limbCtrls) lc.updateDisplay();
          ctx.onShapeChange();
        });
      limbCtrls.push(c);
    }
  }

  const muscleFolder = gui.addFolder('Muscles');
  for (const [key, label, min, max] of MUSCLE_LABELS) {
    muscleFolder.add(params.muscles, key, min, max, 0.01).name(label).onChange(ctx.onShapeChange);
  }

  // ---------- camera ----------
  const camFolder = gui.addFolder('Camera & lens');
  const cam = { fov: viewport.camera.fov };
  const fovCtrl = camFolder
    .add(cam, 'fov', 10, 120, 1)
    .name('Field of view°')
    .onChange((v: number) => {
      if (ctx.settings.dolly) viewport.dollyZoom(v);
      else {
        viewport.camera.fov = v;
        viewport.camera.updateProjectionMatrix();
      }
    });
  camFolder.add(ctx.settings, 'dolly').name('Keep size (dolly zoom)');
  const lens = (fov: number) => () => {
    cam.fov = fov;
    fovCtrl.updateDisplay();
    viewport.dollyZoom(fov);
  };
  camFolder.add({ fisheye: lens(100) }, 'fisheye').name('Extreme wide (100°)');
  camFolder.add({ wide: lens(70) }, 'wide').name('Wide / dynamic (70°)');
  camFolder.add({ normal: lens(40) }, 'normal').name('Normal (40°)');
  camFolder.add({ tele: lens(18) }, 'tele').name('Telephoto (18°)');

  // ---------- render ----------
  const renderFolder = gui.addFolder('Render');
  const style = { style: viewport.style as RenderStyle };
  renderFolder
    .add(style, 'style', { 'Manga screentone': 'manga', 'Toon lines': 'toon', 'Sketch on blue': 'blueprint', Clay: 'clay' })
    .name('Style')
    .onChange((v: RenderStyle) => {
      viewport.setStyle(v);
      ctx.onStyleChange();
    });
  renderFolder.add(ctx.settings, 'guides').name('Construction lines').onChange(ctx.onShapeChange);
  renderFolder.add(ctx.settings, 'outline', 0, 0.012, 0.0005).name('Line weight').onChange(ctx.onStyleChange);
  renderFolder.add(ctx.settings, 'halftone', 2, 12, 0.5).name('Screentone size').onChange(ctx.onStyleChange);
  renderFolder.add(viewport.grid, 'visible').name('Floor grid');
  renderFolder.add(viewport, 'highlightSelection').name('Highlight selection').onChange(() => viewport.refreshMaterials());
  renderFolder.add(viewport, 'pinFeet').name('Pin feet when moving hips');
  renderFolder.close();

  function refreshAll() {
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    cam.fov = Math.round(viewport.camera.fov);
    refreshJoint();
  }

  refreshJoint();
  return { gui, refreshJoint, refreshAll };
}
