/**
 * @file Pure N-body physics: Newtonian gravity, a leapfrog integrator and helpers.
 *
 * Units are chosen so the numbers stay small and readable:
 * distance in AU (Earth–Sun distance), time in years, mass in solar masses.
 * In these units G = 4π², which makes a 1 AU orbit around 1 solar mass take exactly 1 year.
 *
 * Nothing in this file touches the DOM; every function works on plain arrays of {@link Body}.
 */

/** Gravitational constant in AU³ / (M☉ · yr²). */
export const G = 4 * Math.PI * Math.PI;
/** Conversion factor: 1 AU/yr expressed in km/s. */
export const KMS = 4.740470;
/** Earth's mass in solar masses. */
export const EARTH = 3.003e-6;
/** Jupiter's mass in solar masses. */
export const JUP = 9.546e-4;
/** Softening term (AU²) added to r² so the force never divides by zero when two bodies overlap. */
const EPS2 = 1e-6;
/** Largest allowed integration step in years (~4.4 hours); chooseDt only ever shrinks it. */
export const BASE_DT = 0.0005;

/**
 * A simulated body. Positions and velocities are in AU and AU/yr.
 * @typedef {object} Body
 * @property {number} id     Unique, stable identifier (used for selection and following).
 * @property {string} name   Display name.
 * @property {number} m      Mass in solar masses.
 * @property {string} color  CSS hex color (#rrggbb) used for the body and its trail.
 * @property {number} r      Drawn radius in screen pixels (not physical; sizes are not to scale).
 * @property {number} x      Position x (AU).
 * @property {number} y      Position y (AU).
 * @property {number} vx     Velocity x (AU/yr).
 * @property {number} vy     Velocity y (AU/yr).
 * @property {number} ax     Acceleration x (AU/yr²), filled in by {@link computeAcc}.
 * @property {number} ay     Acceleration y (AU/yr²), filled in by {@link computeAcc}.
 * @property {number[]} trail Flat list of past positions: [x0, y0, x1, y1, ...].
 * @property {boolean} star  True for bodies of at least 0.05 M☉; stars glow and have a larger collision radius.
 */

let nextId = 1;

/**
 * Creates a body with defaults filled in: a fresh unique id, zero acceleration,
 * an empty trail, and `star` set from the mass. Any field in `o` overrides the defaults.
 * @param {Partial<Body> & {name: string, m: number, color: string, r: number, x: number, y: number, vx: number, vy: number}} o
 * @returns {Body}
 */
export const mk = (o) => Object.assign({ id: nextId++, ax: 0, ay: 0, trail: [], star: o.m >= 0.05 }, o);

/**
 * Computes the gravitational acceleration on every body from every other body and
 * writes it into each body's `ax`/`ay`.
 *
 * Uses direct summation over each pair once (O(n²)): for a pair (a, b) the same
 * distance term is reused, a is pulled toward b by b's mass and b toward a by a's mass.
 * A small softening term keeps the force finite at very short range.
 * @param {Body[]} bs Bodies to update in place.
 */
export function computeAcc(bs) {
  const n = bs.length;
  for (const b of bs) { b.ax = 0; b.ay = 0; }
  for (let i = 0; i < n; i++) {
    const a = bs[i];
    for (let j = i + 1; j < n; j++) {
      const b = bs[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const r2 = dx * dx + dy * dy + EPS2;
      const inv = 1 / (r2 * Math.sqrt(r2)); // 1 / r³
      const fa = G * b.m * inv, fb = G * a.m * inv;
      a.ax += dx * fa; a.ay += dy * fa;
      b.ax -= dx * fb; b.ay -= dy * fb;
    }
  }
}

/**
 * Collision radius of a body in AU. Bodies merge when their centers are closer than
 * the sum of their collision radii. Stars are given a generous 0.02 AU (several solar radii)
 * so that grazing encounters merge instead of slingshotting at absurd speeds.
 * @param {Body} b
 * @returns {number} Radius in AU.
 */
export const collR = (b) => (b.star ? 0.02 : b.m >= 1e-4 ? 0.0005 : 0.0002);

/**
 * Picks a time step small enough to resolve the tightest pair of bodies.
 *
 * For each pair the local dynamical time is roughly √(r³ / G(m₁+m₂)), the time scale
 * of their mutual orbit. The step is 1.5% of the smallest such time, capped at
 * {@link BASE_DT} and floored at 2e-7 years so a near-collision can't stall the loop.
 *
 * @param {Body[]} bs Bodies to examine.
 * @param {number|null} [onlyId=null] If given, only pairs involving the body with this id
 *   are considered (used by the launch preview to follow its probe cheaply). Collision
 *   detection is skipped in that mode.
 * @returns {{dt: number, collision: boolean}} The step in years, and whether any pair
 *   is currently within collision range.
 */
export function chooseDt(bs, onlyId = null) {
  let dt = BASE_DT, collision = false;
  const n = bs.length;
  for (let i = 0; i < n; i++) {
    const a = bs[i];
    for (let j = i + 1; j < n; j++) {
      const b = bs[j];
      if (onlyId != null && a.id !== onlyId && b.id !== onlyId) continue;
      const dx = b.x - a.x, dy = b.y - a.y, r = Math.sqrt(dx * dx + dy * dy);
      if (onlyId == null && r < collR(a) + collR(b)) collision = true;
      const t = 0.015 * Math.sqrt((r * r * r) / (G * (a.m + b.m)));
      if (t < dt) dt = t;
    }
  }
  return { dt: Math.max(dt, 2e-7), collision };
}

/**
 * Advances all bodies by one time step using the leapfrog (kick–drift–kick) method:
 * half-step velocity update, full-step position update, recompute forces, then the
 * second half-step velocity update.
 *
 * Leapfrog is symplectic, so total energy oscillates around its true value instead of
 * drifting away, which keeps orbits closed over thousands of revolutions.
 * Assumes `ax`/`ay` already hold the accelerations for the current positions.
 * @param {Body[]} bs Bodies to update in place.
 * @param {number} dt Step size in years.
 */
export function step(bs, dt) {
  for (const b of bs) { b.vx += (b.ax * dt) / 2; b.vy += (b.ay * dt) / 2; b.x += b.vx * dt; b.y += b.vy * dt; }
  computeAcc(bs);
  for (const b of bs) { b.vx += (b.ax * dt) / 2; b.vy += (b.ay * dt) / 2; }
}

/**
 * Total mechanical energy of the system: kinetic energy of every body plus the
 * gravitational potential energy of every pair. Real gravity conserves this exactly,
 * so comparing it with the starting value measures numerical error.
 * @param {Body[]} bs
 * @returns {number} Energy in M☉·AU²/yr² (usually negative for a bound system).
 */
export function energy(bs) {
  let E = 0;
  for (let i = 0; i < bs.length; i++) {
    const a = bs[i];
    E += 0.5 * a.m * (a.vx * a.vx + a.vy * a.vy);
    for (let j = i + 1; j < bs.length; j++) {
      const b = bs[j];
      E -= (G * a.m * b.m) / Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return E;
}

/**
 * Mass-weighted center of mass of a set of bodies, along with its velocity.
 * Returns all zeros for an empty list.
 * @param {Body[]} bs
 * @returns {{x: number, y: number, vx: number, vy: number, M: number}} Position (AU),
 *   velocity (AU/yr) and total mass (M☉).
 */
export function com(bs) {
  let M = 0, x = 0, y = 0, vx = 0, vy = 0;
  for (const b of bs) { M += b.m; x += b.m * b.x; y += b.m * b.y; vx += b.m * b.vx; vy += b.m * b.vy; }
  return M ? { x: x / M, y: y / M, vx: vx / M, vy: vy / M, M } : { x: 0, y: 0, vx: 0, vy: 0, M: 0 };
}

/**
 * Returns the most massive body. The list must not be empty.
 * @param {Body[]} bs
 * @returns {Body}
 */
export const heaviest = (bs) => bs.reduce((a, b) => (b.m > a.m ? b : a));
