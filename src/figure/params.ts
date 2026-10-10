export type Side = 'l' | 'r';
export const SIDES: Side[] = ['l', 'r'];

/** Length / width multipliers. 1 = the base 1.78 m athletic adult. */
export interface Proportions {
  height: number;
  headSize: number;
  neckLength: number;
  torsoLength: number;
  shoulderWidth: number;
  chestWidth: number;
  waistWidth: number;
  hipWidth: number;
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

/** Muscle volume multipliers (0 = flat, 1 = athletic, 2 = huge) plus body-shape controls. */
export interface Muscles {
  neck: number;
  traps: number;
  deltoids: number;
  chest: number;
  lats: number;
  abs: number;
  obliques: number;
  biceps: number;
  triceps: number;
  forearms: number;
  glutes: number;
  quads: number;
  hamstrings: number;
  calves: number;
  /** 0 = shredded, 1 = soft/heavy. Thickens the core volumes and softens muscle separation. */
  bodyFat: number;
  breasts: number;
}

export interface HandParams {
  curl: number;
  thumbCurl: number;
  spread: number;
}

export interface FigureParams {
  proportions: Proportions;
  muscles: Muscles;
  hands: Record<Side, HandParams>;
}

export const DEFAULT_PROPORTIONS: Proportions = {
  height: 1,
  headSize: 1,
  neckLength: 1,
  torsoLength: 1,
  shoulderWidth: 1,
  chestWidth: 1,
  waistWidth: 1,
  hipWidth: 1,
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

export const DEFAULT_MUSCLES: Muscles = {
  neck: 1,
  traps: 1,
  deltoids: 1,
  chest: 1,
  lats: 1,
  abs: 1,
  obliques: 1,
  biceps: 1,
  triceps: 1,
  forearms: 1,
  glutes: 1,
  quads: 1,
  hamstrings: 1,
  calves: 1,
  bodyFat: 0.25,
  breasts: 0,
};

export function defaultParams(): FigureParams {
  return {
    proportions: { ...DEFAULT_PROPORTIONS },
    muscles: { ...DEFAULT_MUSCLES },
    hands: {
      l: { curl: 0.25, thumbCurl: 0.2, spread: 0.15 },
      r: { curl: 0.25, thumbCurl: 0.2, spread: 0.15 },
    },
  };
}

type Preset = { proportions?: Partial<Proportions>; muscles?: Partial<Muscles> };

const allMuscles = (v: number): Partial<Muscles> => ({
  neck: v,
  traps: v,
  deltoids: v,
  chest: v,
  lats: v,
  abs: v,
  obliques: v,
  biceps: v,
  triceps: v,
  forearms: v,
  glutes: v,
  quads: v,
  hamstrings: v,
  calves: v,
});

export const PRESETS: Record<string, Preset> = {
  'Athletic male': {},
  'Heroic (comic)': {
    proportions: { height: 1.05, headSize: 0.92, shoulderWidth: 1.15, chestWidth: 1.1, waistWidth: 0.95, neckLength: 1.05 },
    muscles: { ...allMuscles(1.45), bodyFat: 0.12 },
  },
  Bodybuilder: {
    proportions: { shoulderWidth: 1.12, chestWidth: 1.12, waistWidth: 1.02 },
    muscles: { ...allMuscles(1.9), bodyFat: 0.08 },
  },
  Slim: {
    proportions: { shoulderWidth: 0.95, chestWidth: 0.92, waistWidth: 0.9, hipWidth: 0.95 },
    muscles: { ...allMuscles(0.55), bodyFat: 0.2 },
  },
  'Athletic female': {
    proportions: { height: 0.94, headSize: 0.97, shoulderWidth: 0.88, chestWidth: 0.88, waistWidth: 0.86, hipWidth: 1.12, neckLength: 1.05 },
    muscles: { ...allMuscles(0.75), glutes: 1.15, bodyFat: 0.35, breasts: 0.9 },
  },
  'Curvy female': {
    proportions: { height: 0.93, headSize: 0.97, shoulderWidth: 0.86, chestWidth: 0.9, waistWidth: 0.85, hipWidth: 1.22 },
    muscles: { ...allMuscles(0.6), glutes: 1.4, quads: 0.8, bodyFat: 0.55, breasts: 1.4 },
  },
  'Stylized (anime)': {
    proportions: { height: 0.96, headSize: 1.12, neckLength: 1.1, shoulderWidth: 0.9, chestWidth: 0.88, waistWidth: 0.85, thigh_l: 1.06, thigh_r: 1.06, shin_l: 1.08, shin_r: 1.08 },
    muscles: { ...allMuscles(0.65), bodyFat: 0.2 },
  },
  Heavy: {
    proportions: { waistWidth: 1.3, chestWidth: 1.12, hipWidth: 1.12 },
    muscles: { ...allMuscles(1.1), bodyFat: 1 },
  },
};

export function applyPreset(params: FigureParams, name: string): void {
  const preset = PRESETS[name];
  if (!preset) return;
  Object.assign(params.proportions, DEFAULT_PROPORTIONS, preset.proportions);
  Object.assign(params.muscles, DEFAULT_MUSCLES, preset.muscles);
}
