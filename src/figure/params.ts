export type Side = 'l' | 'r';
export const SIDES: Side[] = ['l', 'r'];

/** Length multipliers applied by stretching bones. 1 = the model's natural proportions. */
export interface Proportions {
  height: number;
  headSize: number;
  neckLength: number;
  torsoLength: number;
  upperArm_l: number;
  upperArm_r: number;
  forearm_l: number;
  forearm_r: number;
  hand_l: number;
  hand_r: number;
  thigh_l: number;
  thigh_r: number;
  shin_l: number;
  shin_r: number;
  foot_l: number;
  foot_r: number;
}

/** Whole-body shape, driven by MakeHuman's macro targets. */
export interface BodyShape {
  /** 0 = female, 1 = male. */
  gender: number;
  /** 0 = minimal, 0.5 = average, 1 = maximal muscle. */
  muscle: number;
  /** 0 = thin, 0.5 = average, 1 = heavy. */
  weight: number;
  /** 0 = regular, 1 = idealized ("heroic") proportions. */
  idealProportions: number;
  /** Surface detail sharpening: muscle separations, collarbones, ribcage (0 = off). */
  definition: number;
  /** 0 = small, 0.5 = average, 1 = large (female only). */
  breastSize: number;
  /** -1..1 */
  shoulders: number;
  chestWidth: number;
  hips: number;
}

/** Per-region muscle/volume offsets, -1..1 (0 = as the body shape gives it). */
export interface Muscles {
  neck: number;
  deltoids: number;
  chest: number;
  lats: number;
  vShape: number;
  abs: number;
  belly: number;
  upperArms: number;
  forearms: number;
  glutes: number;
  thighs: number;
  calves: number;
}

export interface HandParams {
  curl: number;
  thumbCurl: number;
  spread: number;
}

export interface FigureParams {
  proportions: Proportions;
  body: BodyShape;
  muscles: Muscles;
  hands: Record<Side, HandParams>;
}

export const DEFAULT_PROPORTIONS: Proportions = {
  height: 1,
  headSize: 1,
  neckLength: 1,
  torsoLength: 1,
  upperArm_l: 1,
  upperArm_r: 1,
  forearm_l: 1,
  forearm_r: 1,
  hand_l: 1,
  hand_r: 1,
  thigh_l: 1,
  thigh_r: 1,
  shin_l: 1,
  shin_r: 1,
  foot_l: 1,
  foot_r: 1,
};

export const DEFAULT_BODY: BodyShape = {
  gender: 1,
  muscle: 0.85,
  weight: 0.35,
  idealProportions: 0.8,
  definition: 0.6,
  breastSize: 0.5,
  shoulders: 0,
  chestWidth: 0,
  hips: 0,
};

export const DEFAULT_MUSCLES: Muscles = {
  neck: 0,
  deltoids: 0,
  chest: 0,
  lats: 0,
  vShape: 0,
  abs: 0,
  belly: 0,
  upperArms: 0,
  forearms: 0,
  glutes: 0,
  thighs: 0,
  calves: 0,
};

export function defaultParams(): FigureParams {
  return {
    proportions: { ...DEFAULT_PROPORTIONS },
    body: { ...DEFAULT_BODY },
    muscles: { ...DEFAULT_MUSCLES },
    hands: {
      l: { curl: 0.1, thumbCurl: 0.1, spread: 0.1 },
      r: { curl: 0.1, thumbCurl: 0.1, spread: 0.1 },
    },
  };
}

type Preset = { proportions?: Partial<Proportions>; body?: Partial<BodyShape>; muscles?: Partial<Muscles> };

export const PRESETS: Record<string, Preset> = {
  'Athletic male': {},
  'Heroic (comic)': {
    proportions: { height: 1.05, headSize: 0.93 },
    body: { muscle: 1, weight: 0.3, idealProportions: 1, definition: 0.8, shoulders: 0.5, chestWidth: 0.2 },
    muscles: { deltoids: 0.6, chest: 0.5, lats: 0.4, vShape: 0.5, abs: 0.5, upperArms: 0.4, thighs: 0.3, calves: 0.3 },
  },
  Bodybuilder: {
    body: { muscle: 1.12, weight: 0.4, idealProportions: 0.8, definition: 0.9, shoulders: 0.4, chestWidth: 0.3 },
    muscles: { neck: 0.7, deltoids: 0.8, chest: 0.8, lats: 0.6, vShape: 0.5, abs: 0.6, upperArms: 0.8, forearms: 0.6, glutes: 0.3, thighs: 0.8, calves: 0.6 },
  },
  'Slim male': {
    body: { muscle: 0.45, weight: 0.2, idealProportions: 0.5, definition: 0.4 },
  },
  'Average male': {
    body: { muscle: 0.5, weight: 0.5, idealProportions: 0.3, definition: 0.2 },
  },
  'Athletic female': {
    proportions: { height: 0.95 },
    body: { gender: 0, muscle: 0.7, weight: 0.35, idealProportions: 0.9, definition: 0.45, breastSize: 0.55 },
    muscles: { abs: 0.3, glutes: 0.3, thighs: 0.2 },
  },
  'Curvy female': {
    proportions: { height: 0.94 },
    body: { gender: 0, muscle: 0.45, weight: 0.65, idealProportions: 0.6, definition: 0.15, breastSize: 0.85, hips: 0.4 },
    muscles: { glutes: 0.6, belly: -0.2 },
  },
  'Stylized (anime)': {
    proportions: { height: 0.97, headSize: 1.1, neckLength: 1.1, thigh_l: 1.05, thigh_r: 1.05, shin_l: 1.08, shin_r: 1.08 },
    body: { muscle: 0.55, weight: 0.3, idealProportions: 1, definition: 0.3 },
  },
  Heavy: {
    body: { muscle: 0.5, weight: 1, idealProportions: 0.2, definition: 0 },
    muscles: { belly: 0.6 },
  },
};

export function applyPreset(params: FigureParams, name: string): void {
  const preset = PRESETS[name];
  if (!preset) return;
  Object.assign(params.proportions, DEFAULT_PROPORTIONS, preset.proportions);
  Object.assign(params.body, DEFAULT_BODY, preset.body);
  Object.assign(params.muscles, DEFAULT_MUSCLES, preset.muscles);
}
