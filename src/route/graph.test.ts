import { describe, expect, it } from 'vitest';
import { HOME, SPRINGWOOD } from './__fixtures__/springwood';
import { key } from './geo';
import { buildGraph } from './graph';
import { findPocket } from './pocket';

describe('buildGraph on Springwood', () => {
  const pocket = findPocket(SPRINGWOOD, HOME);
  const g = buildGraph(SPRINGWOOD, pocket, HOME);

  it('splits streets at intersections like the reference', () => {
    expect(g.edges.map((e) => [e.name, Math.round(e.lengthFt), e.left, e.right])).toEqual([
      ['Elm St', 700, 11, 11], ['Elm St', 350, 0, 5], ['Elm St', 250, 0, 4], ['Elm St', 100, 0, 1],
      ['Elm St', 350, 5, 5], ['Elm St', 350, 5, 5], ['Elm St', 700, 11, 0],
      ['Cedar St', 601, 0, 10], ['Cedar St', 601, 10, 10],
      ['Park Ln', 601, 0, 0],
      ['Spruce St', 298, 4, 4],
      ['Willow Ct', 400, 6, 6],
      ['Maple Ave', 700, 11, 11], ['Maple Ave', 350, 5, 0], ['Maple Ave', 350, 5, 0],
      ['Maple Ave', 700, 11, 11], ['Maple Ave', 700, 11, 11],
      ['Walnut St', 601, 10, 0], ['Walnut St', 601, 10, 10],
      ['Birch St', 601, 10, 10], ['Birch St', 601, 10, 10],
    ]);
  });

  it('puts home on Elm St as a node', () => {
    const atHome = g.edges.filter((e) => e.u === g.home || e.v === g.home);
    expect(atHome.map((e) => e.name)).toEqual(['Elm St', 'Elm St']);
  });

  it('joins pieces only at shared street points', () => {
    for (const e of g.edges) {
      expect(key(e.points[0])).toBe(e.u);
      expect(key(e.points[e.points.length - 1])).toBe(e.v);
    }
  });

  it('marks ends that touch a busy road', () => {
    const walnutTop = g.edges.filter((e) => e.name === 'Walnut St').flatMap((e) => [...e.busyAt.values()]);
    expect(walnutTop).toEqual(['Ridge Rd']);
  });
});
