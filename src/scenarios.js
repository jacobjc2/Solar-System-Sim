/**
 * @file Preset starting systems, the masses available for launching, and launch colors.
 */
import { G, EARTH, JUP, mk } from './physics.js';

/**
 * Creates a body on a circular orbit around a central mass sitting at the origin.
 *
 * Circular orbital speed is v = √(G·M / a). The body is placed at angle `phase` on a
 * circle of radius `a`, and its velocity points 90° ahead of that, so it orbits
 * counter-clockwise.
 * @param {string} name   Display name.
 * @param {number} a      Orbital radius in AU.
 * @param {number} m      Body mass in solar masses.
 * @param {string} color  CSS hex color.
 * @param {number} r      Drawn radius in pixels.
 * @param {number} phase  Starting angle in radians.
 * @param {number} [M=1]  Central mass being orbited, in solar masses.
 * @returns {import('./physics.js').Body}
 */
function circ(name, a, m, color, r, phase, M = 1) {
  const v = Math.sqrt((G * M) / a);
  return mk({ name, m, color, r, x: a * Math.cos(phase), y: a * Math.sin(phase), vx: -v * Math.sin(phase), vy: v * Math.cos(phase) });
}

/**
 * Creates a 1 M☉ Sun at rest at the origin.
 * @returns {import('./physics.js').Body}
 */
const sun = () => mk({ name: 'Sun', m: 1, color: '#ffcb6b', r: 9, x: 0, y: 0, vx: 0, vy: 0 });

/**
 * The eight planets as arguments for {@link circ}:
 * [name, distance (AU), mass (M☉), color, drawn radius (px), starting angle (rad)].
 * Distances and masses are real; starting angles are arbitrary but fixed.
 */
const PLANETS = [
  ['Mercury', 0.387, 1.66e-7, '#b8b0a6', 2, 0.3],
  ['Venus', 0.723, 2.45e-6, '#e9cf98', 3, 2.1],
  ['Earth', 1.0, EARTH, '#5ea9ff', 3, 4.0],
  ['Mars', 1.524, 3.23e-7, '#e2704d', 2.5, 5.2],
  ['Jupiter', 5.203, JUP, '#d9a679', 6, 1.0],
  ['Saturn', 9.537, 2.858e-4, '#e6d197', 5, 3.3],
  ['Uranus', 19.19, 4.366e-5, '#9fe2e6', 4, 5.8],
  ['Neptune', 30.07, 5.15e-5, '#6f8bff', 4, 2.7],
];

/**
 * A preset starting system.
 * @typedef {object} Scenario
 * @property {string} label  Name shown on the scenario button.
 * @property {string} blurb  One-line description shown under the name.
 * @property {number} radius Initial view radius in AU (how much of the system fits on screen).
 * @property {number} speed  Initial simulation speed in years per second.
 * @property {() => import('./physics.js').Body[]} build Creates a fresh set of bodies.
 *   Called every time the scenario loads or restarts, so each run starts clean.
 */

/** @type {Record<string, Scenario>} All scenarios, keyed by id. Insertion order is display order. */
export const SCENARIOS = {
  solar: {
    label: 'Solar System',
    blurb: 'The Sun and eight planets at their real distances. Zoom out to find Saturn and beyond.',
    radius: 6,
    speed: 0.5,
    build: () => [sun(), ...PLANETS.map((p) => circ(...p))],
  },
  binary: {
    label: 'Binary Star',
    blurb: 'Two suns circling each other, with two planets orbiting the pair.',
    radius: 5,
    speed: 0.4,
    /**
     * Two 1 M☉ stars 1 AU apart in a circular mutual orbit (each moves at half the
     * relative circular speed), plus two planets orbiting the pair's combined 2 M☉.
     */
    build: () => {
      const v = Math.sqrt((G * 2) / 1) / 2;
      return [
        mk({ name: 'Sun A', m: 1, color: '#ffcb6b', r: 8, x: 0.5, y: 0, vx: 0, vy: v }),
        mk({ name: 'Sun B', m: 1, color: '#ffa25c', r: 8, x: -0.5, y: 0, vx: 0, vy: -v }),
        circ('Inner world', 1.8, EARTH, '#7fd1ff', 3, 0.8, 2),
        circ('Outer world', 4.0, EARTH, '#b5f27a', 3, 3.6, 2),
      ];
    },
  },
  eight: {
    label: 'Figure-Eight',
    blurb: 'Three equal stars chasing each other along one path. Discovered in 1993.',
    radius: 1.5,
    speed: 0.15,
    /**
     * The Chenciner–Montgomery figure-eight solution. The published initial conditions
     * use G = 1; with masses of 1 M☉ and lengths of 1 AU, velocities scale by √G = 2π
     * to convert to AU/yr.
     */
    build: () => {
      const s = 2 * Math.PI;
      const x1 = 0.97000436, y1 = -0.24308753, vx3 = -0.93240737 * s, vy3 = -0.86473146 * s;
      return [
        mk({ name: 'Star A', m: 1, color: '#ffcb6b', r: 7, x: x1, y: y1, vx: -vx3 / 2, vy: -vy3 / 2 }),
        mk({ name: 'Star B', m: 1, color: '#9fc3ff', r: 7, x: -x1, y: -y1, vx: -vx3 / 2, vy: -vy3 / 2 }),
        mk({ name: 'Star C', m: 1, color: '#ff9b7a', r: 7, x: 0, y: 0, vx: vx3, vy: vy3 }),
      ];
    },
  },
  rogue: {
    label: 'Rogue Star Flyby',
    blurb: 'A star half the Sun’s mass passes through the Solar System.',
    radius: 14,
    speed: 1,
    /**
     * The Sun and the first six planets, plus a 0.5 M☉ star starting at (-32, 9) AU and
     * moving at 6 AU/yr (~28 km/s) toward the point (0, 3) AU, so it passes just
     * outside the inner system.
     */
    build: () => {
      const sx = -32, sy = 9, tx = 0, ty = 3, d = Math.hypot(tx - sx, ty - sy), v = 6;
      return [
        sun(),
        ...PLANETS.slice(0, 6).map((p) => circ(...p)),
        mk({ name: 'Rogue star', m: 0.5, color: '#ff8a5c', r: 8, x: sx, y: sy, vx: (v * (tx - sx)) / d, vy: (v * (ty - sy)) / d }),
      ];
    },
  },
  sandbox: {
    label: 'Empty Sun',
    blurb: 'Just the Sun. Launch your own planets and try to make them orbit.',
    radius: 3,
    speed: 0.5,
    build: () => [sun()],
  },
};

/**
 * A body type the user can launch.
 * @typedef {object} MassKind
 * @property {number} m     Mass in solar masses.
 * @property {number} r     Drawn radius in pixels.
 * @property {string} kind  Prefix for auto-generated names ("Planet 3").
 * @property {string} label Name on the picker button.
 * @property {string} sub   Small caption under the label.
 */

/** @type {Record<string, MassKind>} Launchable body types, keyed by id. */
export const MASSES = {
  rock: { m: EARTH, r: 3, kind: 'Planet', label: 'Rocky', sub: '1 Earth' },
  giant: { m: JUP, r: 6, kind: 'Giant', label: 'Giant', sub: '1 Jupiter' },
  star: { m: 0.3, r: 7, kind: 'Red dwarf', label: 'Red dwarf', sub: '0.3 Sun' },
};

/** Colors given to launched bodies, used in rotation. */
export const COLORS = ['#7fd1ff', '#ff9fb8', '#b5f27a', '#c9a7ff', '#ffd27a', '#7affd9', '#ffb38a'];
