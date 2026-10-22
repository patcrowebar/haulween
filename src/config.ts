// App-wide constants. Defaults come from the reference skill (reference/SKILL.md).

/** The Claude model Jack uses. Keep the model name here and nowhere else. */
export const CLAUDE_MODEL = 'claude-sonnet-5-5';

/** Placeholder address for examples, tests and screenshots. Never use a real one. */
export const PLACEHOLDER_ADDRESS = '1428 Elm St, Springwood, OH';

export const DEFAULT_DOOR_SECONDS = 60;
export const DOOR_SECONDS_CHOICES = [60, 45, 35, 30] as const;
/** Ask about door time when the youngest walker is this age or older. */
export const ASK_DOOR_TIME_FROM_AGE = 10;
export const DEFAULT_LOT_WIDTH_FT = 55;
export const DEFAULT_BUFFER_MIN = 10;
/** Overpass gets the home point rounded to this many decimals (about 100 m). */
export const HOME_POINT_DECIMALS = 3;
