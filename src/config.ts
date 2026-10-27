// App-wide constants. Defaults come from the reference skill (reference/SKILL.md).

/** The Claude model Jack uses. Keep the model name here and nowhere else. */
export const CLAUDE_MODEL = 'claude-haiku-5-5';

/** Placeholder address for examples, tests and screenshots. Never use a real one. */
export const PLACEHOLDER_ADDRESS = '1428 Elm St, Springwood, OH';

/** Door time and walking pace are the main settings; every choice is always shown. */
export const DEFAULT_DOOR_SECONDS = 45;
export const DOOR_SECONDS_CHOICES = [60, 45, 35, 30] as const;

/** Walking pace between doors. Shown by label and description only, never mph. */
export const PACE_CHOICES = [
  { id: 'slow', label: 'Slow', description: 'little ones or a stroller', mph: 1.5 },
  { id: 'steady', label: 'Steady', description: 'most kids', mph: 2.0 },
  { id: 'quick', label: 'Quick', description: 'big kids', mph: 2.5 },
  { id: 'fast', label: 'Fast', description: 'teens', mph: 3.0 },
] as const;
export type PaceId = (typeof PACE_CHOICES)[number]['id'];
export const DEFAULT_PACE: PaceId = 'steady';
export const paceChoice = (id: PaceId) => PACE_CHOICES.find((p) => p.id === id) ?? PACE_CHOICES[1];
export const isPaceId = (v: unknown): v is PaceId => PACE_CHOICES.some((p) => p.id === v);
export const DEFAULT_LOT_WIDTH_FT = 55;
export const DEFAULT_BUFFER_MIN = 10;
/** Overpass gets the home point rounded to this many decimals (about 100 m). */
export const HOME_POINT_DECIMALS = 3;
