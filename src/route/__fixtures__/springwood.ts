// The made-up Springwood neighborhood (see make-springwood.mjs) and the placeholder home on it.

import { FT_PER_DEG } from '../geo';
import { fromOverpass } from '../osm';
import type { Pt } from '../types';
import raw from './springwood.overpass.json';

export const SPRINGWOOD = fromOverpass(raw);

const ORIGIN: Pt = [41.8, -82.1];
const KX = FT_PER_DEG * Math.cos((ORIGIN[0] * Math.PI) / 180);

/** 1428 Elm St, Springwood, OH (the placeholder): 30 ft north of Elm St, 100 ft west of Cedar St. */
export const HOME: Pt = [ORIGIN[0] + 30 / FT_PER_DEG, ORIGIN[1] - 100 / KX];

/** A point given in feet east/north of the fixture's origin (Elm St & Cedar St). */
export const ft = (x: number, y: number): Pt => [ORIGIN[0] + y / FT_PER_DEG, ORIGIN[1] + x / KX];
