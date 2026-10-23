// Shared route types. Plain data, no React, no network.

export type LatLng = { lat: number; lng: number };

/** A point as [lat, lng], the order OpenStreetMap geometry comes in. */
export type Pt = [number, number];

export type Pattern = 'zigzag' | 'one_side' | 'walk_through';

/** A named road from OpenStreetMap (one OSM way). */
export type OsmStreet = {
  name: string;
  highway: string;
  maxspeed: string;
  lanes: string;
  points: Pt[];
};

/** A park, field, school, church or similar area. No lot fronts these. */
export type OsmArea = { name: string; kind: string; points: Pt[] };

/** Everything the route logic needs from one Overpass response. */
export type OsmData = { streets: OsmStreet[]; areas: OsmArea[]; sidewalks: Pt[][] };

export type NamedLine = { name: string; points: Pt[] };
