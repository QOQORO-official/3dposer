import './style.css';
import * as THREE from 'three';
import type { AnalyzeRequest, AnalyzeResponse, DetectorLandmark, KeypointName, PoseAnalysis } from '../shared/schema';
import { Figure, type PoseSnapshot } from './figure/rig';
import { loadHumanAsset } from './figure/human';
import { GuideLines, createGuideMaterial } from './figure/lines';
import { applyPreset, defaultParams, SIDES, type FigureParams, type HandParams, type Side } from './figure/params';
import { figureKeypoints, solveFromKeypoints, solveLimbIK } from './figure/solver';
import { liftLimbsToImage } from './figure/lift';
import { analysisFromDetector, keypointsToWorld, worldToKeypoints } from './pose/keypoints';
import { detectPose } from './pose/detect';
import { Viewport } from './render/viewport';
import { cameraOrientation, matchCamera, type FitPoint } from './render/cameraFit';
import { buildGui } from './ui/gui';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------------------------------------------------------------- state
let asset;
try {
  asset = await loadHumanAsset();
} catch (err) {
  document.querySelector('#status')!.textContent = (err as Error).message;
  throw err;
}
const figure = new Figure(asset, defaultParams());
const settings = { guides: true, outline: 0.0055, halftone: 4.5, dolly: true };
let refImage: HTMLImageElement | null = null;
let refAspect = 1;
let detector: DetectorLandmark[] | null = null;
let analysis: PoseAnalysis | null = null;
let busy = false;

interface HistoryEntry {
  pose: PoseSnapshot;
  hands: Record<Side, HandParams>;
}
const history: HistoryEntry[] = [];
let historyIndex = -1;

// ---------------------------------------------------------------- viewport
const viewport = new Viewport($('#viewport'), figure, {
  onSelect: () => gui.refreshJoint(),
  onEditStart: () => {},
  onEditChange: () => gui.refreshJoint(),
  onEditEnd: () => pushHistory(),
});
const overlayImg = document.createElement('img');
overlayImg.className = 'ref-overlay';
overlayImg.alt = '';
overlayImg.hidden = true;
viewport.frame.appendChild(overlayImg);

const guides = new GuideLines(figure, createGuideMaterial());
viewport.beforeRender = () => guides.update();

let rebuildQueued = false;
/** Re-evaluates body shape and proportions (keeps the pose). */
function rebuild(): void {
  figure.updateShape();
  guides.build();
  viewport.refreshMaterials();
}
function queueShapeRebuild(): void {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    rebuildQueued = false;
    const wasOnFloor = Math.abs(lowestPoint()) < 0.01;
    rebuild();
    if (wasOnFloor) snapToFloor();
    saveLocal();
  });
}

function lowestPoint(): number {
  figure.root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(figure.mesh, true).min.y;
}

function snapToFloor(): void {
  const minY = lowestPoint();
  if (!Number.isFinite(minY)) return;
  const pelvis = figure.get('pelvis').obj;
  pelvis.position.y -= minY / figure.root.scale.y;
  figure.root.updateMatrixWorld(true);
}

const gui = buildGui($('#right'), {
  figure,
  viewport,
  settings,
  onShapeChange: queueShapeRebuild,
  onPoseChange: (final) => {
    if (final) pushHistory();
  },
  onStyleChange: () => {
    viewport.setLineWeight(settings.outline);
    viewport.halftoneCell = settings.halftone;
    guides.object.visible = settings.guides;
    guides.update();
    viewport.refreshMaterials();
  },
});

// ---------------------------------------------------------------- history & persistence
function pushHistory(): void {
  history.splice(historyIndex + 1);
  history.push({ pose: figure.snapshot(), hands: structuredClone(figure.params.hands) });
  if (history.length > 100) history.shift();
  historyIndex = history.length - 1;
  updateHistoryButtons();
  saveLocal();
}

function restoreHistory(i: number): void {
  const h = history[i];
  if (!h) return;
  historyIndex = i;
  figure.params.hands = structuredClone(h.hands);
  figure.restore(h.pose);
  gui.refreshAll();
  updateHistoryButtons();
  saveLocal();
}

function updateHistoryButtons(): void {
  $<HTMLButtonElement>('[data-action=undo]').disabled = historyIndex <= 0;
  $<HTMLButtonElement>('[data-action=redo]').disabled = historyIndex >= history.length - 1;
}

interface SaveFile {
  app: '3dposer';
  version: 1;
  params: FigureParams;
  pose: PoseSnapshot;
  camera: { position: number[]; quaternion: number[]; fov: number; target: number[] };
  analysis: PoseAnalysis | null;
}

function serialize(): SaveFile {
  const c = viewport.camera;
  return {
    app: '3dposer',
    version: 1,
    params: structuredClone(figure.params),
    pose: figure.snapshot(),
    camera: { position: c.position.toArray(), quaternion: c.quaternion.toArray(), fov: c.fov, target: viewport.orbit.target.toArray() },
    analysis,
  };
}

function deserialize(data: SaveFile): void {
  if (data?.app !== '3dposer') throw new Error('Not a 3D Poser file.');
  const defaults = defaultParams();
  const pick = <T extends object>(base: T, src: Partial<T> | undefined): T => {
    const out = { ...base };
    for (const k of Object.keys(base) as (keyof T)[]) if (typeof src?.[k] === 'number') out[k] = src[k] as T[keyof T];
    return out;
  };
  Object.assign(figure.params.proportions, pick(defaults.proportions, data.params.proportions));
  Object.assign(figure.params.body, pick(defaults.body, data.params.body));
  Object.assign(figure.params.muscles, pick(defaults.muscles, data.params.muscles));
  for (const s of SIDES) Object.assign(figure.params.hands[s], pick(defaults.hands[s], data.params.hands?.[s]));
  rebuild();
  figure.restore(data.pose);
  analysis = data.analysis ?? null;
  const c = viewport.camera;
  c.position.fromArray(data.camera.position);
  c.quaternion.fromArray(data.camera.quaternion);
  c.fov = data.camera.fov;
  c.updateProjectionMatrix();
  viewport.orbit.target.fromArray(data.camera.target);
  setCameraLocked(false);
  showAnalysis();
  gui.refreshAll();
}

let saveTimer = 0;
function saveLocal(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem('3dposer:last', JSON.stringify(serialize()));
    } catch {
      /* storage unavailable */
    }
  }, 300);
}

// ---------------------------------------------------------------- UI helpers
function setStatus(text: string, kind: 'busy' | 'error' | 'ok' | '' = ''): void {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function setBusy(on: boolean): void {
  busy = on;
  updateButtons();
}

function updateButtons(): void {
  $<HTMLButtonElement>('#btnDetect').disabled = busy || !refImage;
  $<HTMLButtonElement>('#btnClaude').disabled = busy || !refImage;
  $<HTMLButtonElement>('#btnRefine').disabled = busy || !refImage || !analysis;
  $<HTMLButtonElement>('[data-action=camera-match]').disabled = !refImage || !analysis;
}

function setCameraLocked(locked: boolean): void {
  viewport.setCameraLocked(locked);
  if (!locked) {
    viewport.lockedAspect = null;
    viewport.resize();
    viewport.syncOrbitTarget();
  }
  $('[data-action=camera-free]').classList.toggle('on', !locked);
  $('[data-action=camera-match]').classList.toggle('on', locked);
  updateOverlay();
}

function updateOverlay(): void {
  const show = Boolean(refImage) && viewport.cameraLocked && $<HTMLInputElement>('#overlayToggle').checked;
  overlayImg.hidden = !show;
  overlayImg.style.opacity = $<HTMLInputElement>('#overlayOpacity').value;
}

function showAnalysis(extra: Record<string, string> = {}): void {
  const card = $('#analysisCard');
  card.hidden = !analysis;
  if (!analysis) return;
  $('#anDesc').textContent = analysis.description;
  $('#anFore').textContent = analysis.foreshortening_notes;
  const rows: Record<string, string> = {
    'Lens FOV': `${viewport.camera.fov.toFixed(0)}° (est. ${analysis.camera.fov_deg.toFixed(0)}°)`,
    Elevation: `${analysis.camera.elevation_deg.toFixed(0)}°`,
    Roll: `${analysis.camera.roll_deg.toFixed(0)}°`,
    Body: `${analysis.body.sex}, muscle ${analysis.body.muscularity.toFixed(2)}, fat ${analysis.body.body_fat.toFixed(2)}`,
    ...extra,
  };
  const dl = $('#anCam');
  dl.replaceChildren();
  for (const [k, v] of Object.entries(rows)) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

// ---------------------------------------------------------------- reference image
const BONES: [KeypointName, KeypointName][] = [
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
  ['left_ankle', 'left_foot_index'],
  ['right_ankle', 'right_foot_index'],
  ['left_ear', 'nose'],
  ['right_ear', 'nose'],
];

function drawReference(): void {
  const canvas = $<HTMLCanvasElement>('#refCanvas');
  if (!refImage) {
    canvas.hidden = true;
    return;
  }
  const maxW = 300;
  const scale = Math.min(maxW / refImage.naturalWidth, 340 / refImage.naturalHeight, 1) * 2;
  canvas.width = Math.round(refImage.naturalWidth * scale);
  canvas.height = Math.round(refImage.naturalHeight * scale);
  canvas.hidden = false;
  $('#dropText').hidden = true;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(refImage, 0, 0, canvas.width, canvas.height);
  if (!analysis) return;
  const kp = analysis.keypoints;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    if (kp[a].confidence < 0.1 || kp[b].confidence < 0.1) continue;
    const side = a.startsWith('left') ? 'left' : a.startsWith('right') ? 'right' : 'mid';
    ctx.strokeStyle = side === 'left' ? '#2f6bff' : side === 'right' ? '#ff3d5a' : '#ffb000';
    ctx.globalAlpha = Math.max(0.35, Math.min(kp[a].confidence, kp[b].confidence));
    ctx.beginPath();
    ctx.moveTo(kp[a].u * canvas.width, kp[a].v * canvas.height);
    ctx.lineTo(kp[b].u * canvas.width, kp[b].v * canvas.height);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

async function loadImage(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    setStatus('Could not read that image.', 'error');
    return;
  }
  refImage = img;
  refAspect = img.naturalWidth / img.naturalHeight;
  overlayImg.src = url;
  detector = null;
  analysis = null;
  showAnalysis();
  drawReference();
  updateButtons();
  setStatus('Image loaded. Detect the pose, or go straight to Claude.', 'ok');
}

/** JPEG of the reference, long side capped (Claude downsamples larger images anyway). */
function encodeReference(maxSide = 1568): { media_type: 'image/jpeg'; data: string } {
  const img = refImage!;
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.9).split(',')[1] };
}

// ---------------------------------------------------------------- applying an analysis
function applyBodySuggestion(body: PoseAnalysis['body']): void {
  const b = figure.params.body;
  const clamp01 = (v: number) => THREE.MathUtils.clamp(v, 0, 1);
  b.gender = body.sex === 'female' ? 0 : body.sex === 'male' ? 1 : 0.5;
  b.muscle = clamp01(0.3 + 0.7 * body.muscularity);
  b.weight = clamp01(0.15 + 0.85 * body.body_fat);
  if (body.sex === 'female') b.breastSize = Math.max(b.breastSize, 0.5);
  figure.params.proportions.height = body.sex === 'female' ? 0.95 : 1;
  figure.params.proportions.headSize = THREE.MathUtils.clamp(7.4 / Math.max(4, body.heads_tall), 0.8, 1.6);
  rebuild();
}

function applyAnalysis(a: PoseAnalysis, opts: { applyBody: boolean }): void {
  if (opts.applyBody) applyBodySuggestion(a.body);
  for (const s of SIDES) {
    const h = s === 'l' ? a.hands.left : a.hands.right;
    const clamp01 = (v: number) => THREE.MathUtils.clamp(v, 0, 1);
    figure.params.hands[s] = { curl: clamp01(h.finger_curl), thumbCurl: clamp01(h.thumb_curl), spread: clamp01(h.spread) };
  }
  const q = cameraOrientation(a.camera.elevation_deg, a.camera.roll_deg);
  const hipMid = () => figure.worldPos('thigh_l').add(figure.worldPos('thigh_r')).multiplyScalar(0.5);
  solveFromKeypoints(figure, keypointsToWorld(a.keypoints, q, hipMid()));
  figure.applyHands();
  snapToFloor();
  analysis = a;
  if (refImage) {
    matchToReference();
    if (viewport.cameraLocked && $<HTMLInputElement>('#optLift').checked) {
      // Alternate between lifting limbs onto the image rays and refitting the camera.
      for (let i = 0; i < 3; i++) {
        const world = keypointsToWorld(a.keypoints, q, hipMid());
        solveFromKeypoints(figure, liftLimbsToImage(figure, a.keypoints, world, viewport.camera));
        snapToFloor();
        matchToReference(false);
      }
    }
  } else {
    viewport.frameFigure();
  }
  showAnalysis();
  drawReference();
  updateButtons();
  gui.refreshAll();
  pushHistory();
}

function fitPoints(a: PoseAnalysis): FitPoint[] {
  const world = figureKeypoints(figure);
  const core = new Set(['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_elbow', 'right_elbow']);
  return (Object.keys(world) as KeypointName[]).map((name) => ({
    world: world[name],
    u: a.keypoints[name].u,
    v: a.keypoints[name].v,
    weight: THREE.MathUtils.clamp(a.keypoints[name].confidence, 0, 1) * (core.has(name) ? 1.5 : name.match(/index|pinky|thumb|heel/) ? 0.4 : 1),
  }));
}

function matchToReference(searchFov = $<HTMLInputElement>('#optFov').checked): void {
  if (!analysis || !refImage) return;
  viewport.lockedAspect = refAspect;
  viewport.resize();
  const q = cameraOrientation(analysis.camera.elevation_deg, analysis.camera.roll_deg);
  // Once a lens has been chosen for this analysis, refits keep it (searchFov = false).
  const fov = searchFov ? THREE.MathUtils.clamp(analysis.camera.fov_deg || 40, 10, 120) : viewport.camera.fov;
  const res = matchCamera(viewport.camera, fitPoints(analysis), q, { fov, aspect: refAspect, searchFov });
  if (!res) {
    setStatus('Could not fit the camera to the image (not enough confident keypoints).', 'error');
    setCameraLocked(false);
    viewport.frameFigure();
    return;
  }
  setCameraLocked(true);
  gui.refreshAll();
  showAnalysis({ 'Fit error': `${(Math.sqrt(res.error) * 100).toFixed(1)}% of frame` });
}

// ---------------------------------------------------------------- actions
async function runDetect(): Promise<void> {
  if (!refImage) return;
  setBusy(true);
  setStatus('Loading MediaPipe and detecting the pose…', 'busy');
  try {
    detector = await detectPose(refImage);
    if (!detector) {
      setStatus('No person detected. Claude can still reconstruct the pose from the image alone.', 'error');
      return;
    }
    applyAnalysis(analysisFromDetector(detector), { applyBody: false });
    setStatus('Pose detected. Ask Claude to fix the depth and foreshortening.', 'ok');
  } catch (err) {
    console.error(err);
    setStatus(`Pose detection failed: ${(err as Error).message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function runClaude(refine: boolean): Promise<void> {
  if (!refImage) return;
  setBusy(true);
  const started = performance.now();
  const tick = window.setInterval(() => {
    const s = ((performance.now() - started) / 1000).toFixed(0);
    setStatus(`${refine ? 'Claude is comparing the render with the reference' : 'Claude is analyzing the anatomy, depth and camera'}… ${s}s`, 'busy');
  }, 500);
  try {
    const body: AnalyzeRequest = { image: encodeReference(), note: $<HTMLTextAreaElement>('#note').value };
    if (detector) body.detector = detector;
    if (refine && analysis) {
      if (!viewport.cameraLocked) matchToReference();
      body.render = viewport.captureForAnalysis();
      body.current = { ...analysis, keypoints: worldToKeypoints(figureKeypoints(figure), viewport.camera) };
      body.current.camera = { ...analysis.camera, fov_deg: viewport.camera.fov };
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const key = localStorage.getItem('3dposer:key');
    if (key) headers['x-anthropic-key'] = key;
    const res = await fetch('/api/analyze', { method: 'POST', headers, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Partial<AnalyzeResponse> & { error?: string };
    if (!res.ok || !json.analysis) throw new Error(json.error ?? `Server responded ${res.status}`);
    applyAnalysis(json.analysis, { applyBody: !refine && $<HTMLInputElement>('#optBody').checked });
    const secs = ((performance.now() - started) / 1000).toFixed(0);
    setStatus(`${refine ? 'Refined' : 'Reconstructed'} by ${json.model} in ${secs}s. Tweak anything on the right.`, 'ok');
  } catch (err) {
    setStatus((err as Error).message, 'error');
  } finally {
    clearInterval(tick);
    setBusy(false);
  }
}

function download(name: string, url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

const actions: Record<string, () => void> = {
  'mode-rotate': () => setMode('rotate'),
  'mode-move': () => setMode('move'),
  undo: () => restoreHistory(historyIndex - 1),
  redo: () => restoreHistory(historyIndex + 1),
  'mirror-l': () => {
    figure.mirrorPose('l');
    pushHistory();
  },
  'mirror-r': () => {
    figure.mirrorPose('r');
    pushHistory();
  },
  flip: () => {
    figure.mirrorPose('flip');
    pushHistory();
  },
  reset: () => {
    figure.naturalPose();
    snapToFloor();
    pushHistory();
    gui.refreshJoint();
  },
  floor: () => {
    snapToFloor();
    pushHistory();
  },
  'camera-match': () => matchToReference(),
  'camera-free': () => setCameraLocked(false),
  frame: () => {
    setCameraLocked(false);
    viewport.frameFigure();
  },
  export: () => download('pose.png', viewport.screenshot()),
  save: () => {
    const blob = new Blob([JSON.stringify(serialize(), null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    download('pose.json', url);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  load: () => $<HTMLInputElement>('#poseFile').click(),
};

function setMode(mode: 'rotate' | 'move'): void {
  viewport.setGizmoMode(mode);
  $('[data-action=mode-rotate]').classList.toggle('on', mode === 'rotate');
  $('[data-action=mode-move]').classList.toggle('on', mode === 'move');
}

document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => {
  b.addEventListener('click', () => actions[b.dataset.action!]?.());
});

$('#btnDetect').addEventListener('click', () => void runDetect());
$('#btnClaude').addEventListener('click', () => void runClaude(false));
$('#btnRefine').addEventListener('click', () => void runClaude(true));
$('#overlayToggle').addEventListener('change', updateOverlay);
$('#overlayOpacity').addEventListener('input', updateOverlay);

$<HTMLInputElement>('#file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void loadImage(f);
});
const drop = $('#dropzone');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('drag');
});
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('drag');
  const f = e.dataTransfer?.files?.[0];
  if (f?.type.startsWith('image/')) void loadImage(f);
});
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const f = item?.getAsFile();
  if (f) void loadImage(f);
});

$<HTMLInputElement>('#poseFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  try {
    deserialize(JSON.parse(await f.text()) as SaveFile);
    pushHistory();
    setStatus('Pose loaded.', 'ok');
  } catch (err) {
    setStatus(`Could not load: ${(err as Error).message}`, 'error');
  }
});

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.matches('input, textarea, select')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) actions.redo();
    else actions.undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    actions.redo();
  } else if (!mod && e.key === 'r') setMode('rotate');
  else if (!mod && e.key === 'g') setMode('move');
  else if (!mod && e.key === 'f') actions.frame();
  else if (e.key === 'Escape') viewport.select(null);
});

// API key (stored only in this browser) + server status.
const keyInput = $<HTMLInputElement>('#apiKey');
keyInput.value = localStorage.getItem('3dposer:key') ?? '';
keyInput.addEventListener('change', () => {
  const v = keyInput.value.trim();
  if (v) localStorage.setItem('3dposer:key', v);
  else localStorage.removeItem('3dposer:key');
});
fetch('/api/health')
  .then((r) => r.json())
  .then((h: { model: string; serverKey: boolean }) => {
    $('#keyInfo').textContent = h.serverKey
      ? `Server is configured (model ${h.model}). No key needed here.`
      : `The server has no ANTHROPIC_API_KEY. Paste a key to use Claude (kept in this browser only). Model: ${h.model}.`;
  })
  .catch(() => {
    $('#keyInfo').textContent = 'API server not reachable. Start it with `npm run dev`.';
  });

// ---------------------------------------------------------------- boot
viewport.setLineWeight(settings.outline);
rebuild();
figure.naturalPose();
snapToFloor();
try {
  const saved = localStorage.getItem('3dposer:last');
  if (saved) deserialize(JSON.parse(saved) as SaveFile);
  else viewport.frameFigure(false);
} catch {
  viewport.frameFigure(false);
}
pushHistory();
updateButtons();

// Expose for debugging from the console.
Object.assign(window, { poser: { figure, viewport, THREE, applyAnalysis, loadImage, runDetect, figureKeypoints, worldToKeypoints, applyPreset, solveLimbIK } });
