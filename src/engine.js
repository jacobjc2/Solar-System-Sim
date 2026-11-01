/**
 * @file The simulation engine: owns the bodies, runs the frame loop, draws the canvas and
 * handles pointer input. It is deliberately independent of React; the UI reads it through
 * a small external-store interface (see {@link Simulation#subscribe}).
 */
import { G, KMS, EARTH, JUP, mk, computeAcc, collR, chooseDt, step, energy, com, heaviest } from './physics.js';
import { SCENARIOS, MASSES, COLORS } from './scenarios.js';

/** @typedef {import('./physics.js').Body} Body */

/** Maximum integration steps per animation frame, so a tight encounter can't freeze the tab. */
const MAX_STEPS = 4000;
/** Launch speed per pixel of drag, in AU/yr. */
const LAUNCH_K = 0.05;
/** Minimum time between snapshots pushed to React from the frame loop, in ms. */
const PANEL_MS = 120;

/**
 * Maps the speed slider's 0–100 position to a simulation speed on a log scale,
 * from 0.02 to 20 years per second.
 * @param {number} v Slider value, 0–100.
 * @returns {number} Speed in years per second.
 */
export const sliderToSpeed = (v) => 0.02 * Math.pow(1000, v / 100);

/**
 * Inverse of {@link sliderToSpeed}: converts a speed back to a slider position.
 * @param {number} s Speed in years per second.
 * @returns {number} Slider value, 0–100.
 */
export const speedToSlider = (s) => (100 * Math.log(s / 0.02)) / Math.log(1000);

/**
 * One row of the selected-body card.
 * @typedef {object} InfoRow
 * @property {string} label
 * @property {string} value
 * @property {'ok'|'bad'} [tone] Optional color hint: 'ok' (green) or 'bad' (orange).
 */

/**
 * Everything the panel needs to show the selected body.
 * @typedef {object} SelectedInfo
 * @property {number} id
 * @property {string} name
 * @property {string} color
 * @property {InfoRow[]} rows
 * @property {string} note Explanatory sentence, or '' for none.
 */

/**
 * Immutable view of the engine's state for React. A new object is made on every emit.
 * @typedef {object} Snapshot
 * @property {number} simT       Elapsed simulated time in years.
 * @property {number} count      Number of bodies.
 * @property {number} drift      Relative energy error since the last reset, in percent.
 * @property {boolean} running
 * @property {number} speed      Years per second.
 * @property {string} scenario   Key into SCENARIOS.
 * @property {'com'|'star'|'selected'} followMode
 * @property {boolean} showTrails
 * @property {boolean} showLabels
 * @property {string} massKind   Key into MASSES.
 * @property {SelectedInfo|null} selected
 */

/**
 * The gravity simulation and its canvas renderer.
 *
 * State lives in plain mutable fields that the frame loop updates many times per frame.
 * React never holds this state; it calls action methods (load, setSpeed, ...) and
 * reads {@link Snapshot}s via `useSyncExternalStore(sim.subscribe, sim.getSnapshot)`.
 */
export class Simulation {
  /**
   * Creates the simulation and loads the Solar System scenario. Nothing is drawn or
   * animated until {@link Simulation#attach} is given a canvas.
   * @param {object} [opts]
   * @param {(msg: string) => void} [opts.onToast] Called with a short message when a
   *   notable event happens (collision, escape).
   */
  constructor({ onToast } = {}) {
    this.onToast = onToast || (() => {});
    /** @type {Set<() => void>} */
    this.listeners = new Set();

    // Simulation state
    /** @type {Body[]} */
    this.bodies = [];
    this.simT = 0;
    this.E0 = 0;

    // Settings
    this.running = true;
    this.speed = 0.5;
    this.scenario = 'solar';
    /** @type {number|null} */
    this.selectedId = null;
    /** @type {'com'|'star'|'selected'} */
    this.followMode = 'com';
    this.showTrails = true;
    this.showLabels = true;
    this.massKind = 'rock';

    // Camera: `scale` is pixels per AU, (cx, cy) is the world point at the screen center.
    // `pendingRadius` holds a requested view radius until the canvas has a size.
    this.view = { scale: 60, cx: 0, cy: 0, pendingRadius: 6 };
    this.launchCount = 0;

    // Canvas and input
    /** @type {HTMLCanvasElement|null} */
    this.canvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this.ctx = null;
    this.W = 0;
    this.H = 0;
    this.DPR = 1;
    /** @type {HTMLCanvasElement|null} */
    this.starLayer = null;
    this.drag = null;
    this.pinch = null;
    /** @type {Map<number, {x: number, y: number}>} */
    this.pointers = new Map();

    this.load('solar');
  }

  // ---------- Store interface ----------

  /**
   * Registers a callback that runs whenever a new snapshot is available.
   * Defined as an arrow property so it can be passed unbound to useSyncExternalStore.
   * @param {() => void} fn
   * @returns {() => void} Unsubscribe function.
   */
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /**
   * Returns the latest snapshot. Returns the same object until the next emit, as
   * useSyncExternalStore requires.
   * @returns {Snapshot}
   */
  getSnapshot = () => this.snap;

  /**
   * Builds a fresh {@link Snapshot} from the current state and notifies all subscribers.
   * Called after every user action, and every {@link PANEL_MS} ms from the frame loop.
   */
  emit() {
    this.snap = {
      simT: this.simT,
      count: this.bodies.length,
      drift: this.E0 ? Math.abs((energy(this.bodies) - this.E0) / this.E0) * 100 : 0,
      running: this.running,
      speed: this.speed,
      scenario: this.scenario,
      followMode: this.followMode,
      showTrails: this.showTrails,
      showLabels: this.showLabels,
      massKind: this.massKind,
      selected: this.selectedInfo(),
    };
    for (const l of this.listeners) l();
  }

  // ---------- Actions ----------

  /**
   * Replaces all bodies with a fresh copy of a scenario.
   *
   * Shifts the system so its center of mass sits at the origin and is at rest (otherwise
   * the whole system would drift off screen), resets the clock, energy baseline,
   * selection and launch counter, and applies the scenario's speed and zoom.
   * Follow mode falls back to center of mass if it was following a now-deleted body.
   * @param {string} key Key into SCENARIOS.
   */
  load(key) {
    this.scenario = key;
    const s = SCENARIOS[key];
    this.bodies = s.build();
    const c = com(this.bodies);
    for (const b of this.bodies) { b.x -= c.x; b.y -= c.y; b.vx -= c.vx; b.vy -= c.vy; }
    this.resetEnergy();
    this.simT = 0;
    this.selectedId = null;
    this.launchCount = 0;
    this.speed = s.speed;
    this.setViewRadius(s.radius);
    if (this.followMode === 'selected') this.followMode = 'com';
    this.emit();
  }

  /** Reloads the current scenario from its starting state. */
  restart() { this.load(this.scenario); }

  /**
   * Sets the simulation speed.
   * @param {number} s Years per second.
   */
  setSpeed(s) { this.speed = s; this.emit(); }

  /**
   * Pauses or resumes the simulation. Drawing continues while paused, so you can
   * still zoom, select and aim launches.
   * @param {boolean} r
   */
  setRunning(r) { this.running = r; this.emit(); }

  /** Flips between paused and running. */
  toggleRunning() { this.setRunning(!this.running); }

  /** Erases every body's trail. No emit needed; trails aren't part of the snapshot. */
  clearTrails() { for (const b of this.bodies) b.trail = []; }

  /**
   * Chooses what kind of body the next drag launches.
   * @param {string} k Key into MASSES.
   */
  setMassKind(k) { this.massKind = k; this.emit(); }

  /** @param {boolean} v Whether to draw trails. */
  setShowTrails(v) { this.showTrails = v; this.emit(); }

  /** @param {boolean} v Whether to draw body names. */
  setShowLabels(v) { this.showLabels = v; this.emit(); }

  /**
   * Changes what the camera stays centered on. Trails are cleared, because they are
   * stored in world coordinates and would look jumbled in the new reference frame.
   * @param {'com'|'star'|'selected'} m
   */
  setFollowMode(m) {
    this.followMode = m;
    this.clearTrails();
    this.emit();
  }

  /** Centers the camera on the selected body. Trails are kept so the jump is visible. */
  followSelected() { this.followMode = 'selected'; this.emit(); }

  /** Deletes the selected body and resets the energy baseline for the new system. */
  removeSelected() {
    this.bodies = this.bodies.filter((x) => x.id !== this.selectedId);
    this.selectedId = null;
    this.resetEnergy();
    this.emit();
  }

  /**
   * Sets the zoom level, clamped to a sensible range.
   * @param {number} s Pixels per AU.
   */
  zoomTo(s) { this.view.scale = Math.min(4000, Math.max(0.3, s)); }

  /**
   * Multiplies the zoom level by a factor (>1 zooms in, <1 zooms out).
   * @param {number} f
   */
  zoomBy(f) { this.zoomTo(this.view.scale * f); }

  /**
   * Zooms so the farthest body from the screen center fits on screen. Bodies beyond
   * 300 AU are ignored so one distant escapee doesn't shrink everything else to a dot.
   */
  zoomFit() {
    let r = 0.5;
    for (const b of this.bodies) {
      const d = Math.hypot(b.x - this.view.cx, b.y - this.view.cy);
      if (d < 300) r = Math.max(r, d);
    }
    this.zoomTo((0.44 * Math.min(this.W, this.H)) / r);
  }

  // ---------- Internals ----------

  /**
   * Recomputes accelerations and records the current total energy as the new baseline.
   * Must be called whenever bodies are added, removed or merged: leapfrog needs valid
   * accelerations before its first step, and the energy error is only meaningful
   * relative to an unchanged system.
   */
  resetEnergy() {
    computeAcc(this.bodies);
    this.E0 = energy(this.bodies);
  }

  /**
   * Zooms so a circle of the given radius around the center fits on screen. If the
   * canvas hasn't been measured yet, remembers the radius and applies it on first resize.
   * @param {number} r Radius in AU.
   */
  setViewRadius(r) {
    if (!this.W || !this.H) { this.view.pendingRadius = r; return; }
    this.view.scale = (0.46 * Math.min(this.W, this.H)) / r;
  }

  /**
   * Returns the point the camera should center on, depending on follow mode: the
   * selected body, the heaviest body, or the center of mass. Falls back to the center
   * of mass if the selected body no longer exists.
   * @param {Body[]} bs
   * @returns {{x: number, y: number, vx: number, vy: number}}
   */
  followTarget(bs) {
    if (this.followMode === 'selected') {
      const b = bs.find((b) => b.id === this.selectedId);
      if (b) return b;
    }
    if (this.followMode === 'star' && bs.length) return heaviest(bs);
    return com(bs);
  }

  /**
   * Merges every pair of bodies that are within collision range, repeating until none
   * remain (one merge can create another).
   *
   * The merged body keeps the heavier body's identity, name and color; it takes the
   * combined mass and the mass-weighted average position and velocity, so momentum is
   * conserved. A body that grows past 0.05 M☉ becomes a star, and star–star mergers draw
   * slightly larger. Selection moves to the survivor and a toast announces the crash.
   */
  resolveCollisions() {
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < this.bodies.length; i++) {
        for (let j = i + 1; j < this.bodies.length; j++) {
          const a = this.bodies[i], b = this.bodies[j];
          if (Math.hypot(b.x - a.x, b.y - a.y) < collR(a) + collR(b)) {
            const big = a.m >= b.m ? a : b, small = big === a ? b : a, M = a.m + b.m;
            big.x = (a.m * a.x + b.m * b.x) / M; big.y = (a.m * a.y + b.m * b.y) / M;
            big.vx = (a.m * a.vx + b.m * b.vx) / M; big.vy = (a.m * a.vy + b.m * b.vy) / M;
            big.m = M;
            if (M >= 0.05 && !big.star) big.star = true;
            if (small.star && big.star) big.r = Math.min(14, big.r + 1);
            this.bodies = this.bodies.filter((x) => x !== small);
            if (this.selectedId === small.id) this.selectedId = big.id;
            this.onToast(`${small.name} crashed into ${big.name}.`);
            merged = true;
            break outer;
          }
        }
      }
    }
    this.resetEnergy();
  }

  /**
   * Deletes bodies more than 2000 AU from the center of mass. They have left for good,
   * and keeping them would waste computation and make "Fit" useless.
   */
  removeEscapes() {
    const c = com(this.bodies);
    const before = this.bodies.length;
    this.bodies = this.bodies.filter((b) => {
      if (Math.hypot(b.x - c.x, b.y - c.y) > 2000) {
        this.onToast(`${b.name} left the system for good.`);
        if (b.id === this.selectedId) this.selectedId = null;
        return false;
      }
      return true;
    });
    if (this.bodies.length !== before) this.resetEnergy();
  }

  /**
   * Runs one animation frame: advances the physics, updates the camera, draws, and
   * occasionally pushes a snapshot to React.
   *
   * Simulated time per frame is `speed × real elapsed seconds` (real time capped at 50 ms
   * so a backgrounded tab doesn't leap ahead on return). That interval is covered by as
   * many adaptive steps as needed, up to {@link MAX_STEPS}. After each step, collisions are
   * resolved and each body appends a trail point if it has moved at least 1.5 screen
   * pixels since its last one (trails are capped at 1800 points).
   * @param {DOMHighResTimeStamp} now Timestamp from requestAnimationFrame.
   */
  frame(now) {
    const fdt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.running && this.bodies.length) {
      const target = this.speed * fdt;
      let done = 0, steps = 0;
      const minD = 1.5 / this.view.scale;
      while (done < target && steps < MAX_STEPS) {
        const { dt: stepDt, collision } = chooseDt(this.bodies);
        const dt = Math.min(stepDt, target - done);
        step(this.bodies, dt);
        done += dt; steps++;
        if (collision) this.resolveCollisions();
        for (const b of this.bodies) {
          const t = b.trail, n = t.length;
          if (!n || Math.abs(t[n - 2] - b.x) + Math.abs(t[n - 1] - b.y) > minD) {
            t.push(b.x, b.y);
            if (t.length > 3600) t.splice(0, 600);
          }
        }
      }
      this.simT += done;
      this.removeEscapes();
    }
    const tgt = this.followTarget(this.bodies);
    this.view.cx = tgt.x; this.view.cy = tgt.y;
    this.draw();
    if (now - this.lastPanel > PANEL_MS) { this.emit(); this.lastPanel = now; }
  }

  // ---------- Canvas lifecycle ----------

  /**
   * Connects the engine to a canvas: starts the animation loop, watches the canvas size,
   * and listens for pointer and wheel input.
   *
   * Designed to be the body of a React effect: `useEffect(() => sim.attach(el), [sim])`.
   * The returned cleanup undoes everything, which keeps React StrictMode's
   * mount → unmount → mount cycle from leaving two loops running.
   * @param {HTMLCanvasElement} canvas
   * @returns {() => void} Detach function.
   */
  attach(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();

    const handlers = {
      pointerdown: (e) => this.onPointerDown(e),
      pointermove: (e) => this.onPointerMove(e),
      pointerup: (e) => this.onPointerEnd(e),
      pointercancel: (e) => this.onPointerEnd(e),
      wheel: (e) => { e.preventDefault(); this.zoomBy(Math.exp(-e.deltaY * 0.0015)); },
    };
    // The wheel listener must be non-passive so preventDefault can stop the page from scrolling.
    for (const [type, fn] of Object.entries(handlers)) canvas.addEventListener(type, fn, type === 'wheel' ? { passive: false } : undefined);

    this.last = performance.now();
    this.lastPanel = 0;
    const loop = (now) => { this.frame(now); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(this.raf);
      ro.disconnect();
      for (const [type, fn] of Object.entries(handlers)) canvas.removeEventListener(type, fn);
      this.canvas = null;
      this.ctx = null;
    };
  }

  /**
   * Matches the canvas's pixel buffer to its on-screen size times the device pixel ratio
   * (capped at 2), so drawing stays sharp on high-DPI screens. Applies any pending view
   * radius from {@link Simulation#setViewRadius} and regenerates the starfield.
   * Skips the update while the canvas has zero size (e.g. hidden).
   */
  resize() {
    const canvas = this.canvas;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.DPR = Math.min(2, window.devicePixelRatio || 1);
    this.W = r.width; this.H = r.height;
    canvas.width = Math.round(this.W * this.DPR); canvas.height = Math.round(this.H * this.DPR);
    if (this.view.pendingRadius) {
      this.view.scale = (0.46 * Math.min(this.W, this.H)) / this.view.pendingRadius;
      this.view.pendingRadius = 0;
    }
    this.buildStars();
  }

  /**
   * Paints the background starfield once into an offscreen canvas, which {@link draw}
   * then copies each frame in one cheap operation. Uses a seeded pseudo-random generator
   * (a linear congruential generator) so the stars land in the same places every time.
   * Density is about one star per 2200 square pixels; a few are larger and brighter,
   * and some are tinted warm or cool.
   */
  buildStars() {
    const layer = document.createElement('canvas');
    layer.width = this.canvas.width; layer.height = this.canvas.height;
    const s = layer.getContext('2d');
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const n = Math.round((this.W * this.H) / 2200);
    for (let i = 0; i < n; i++) {
      const x = rnd() * layer.width, y = rnd() * layer.height, big = rnd() > 0.97;
      s.globalAlpha = 0.15 + rnd() * (big ? 0.6 : 0.35);
      s.fillStyle = rnd() > 0.85 ? '#ffd9b0' : rnd() > 0.7 ? '#c8d8ff' : '#ffffff';
      s.fillRect(x, y, (big ? 2 : 1) * this.DPR, (big ? 2 : 1) * this.DPR);
    }
    this.starLayer = layer;
  }

  // ---------- Rendering ----------

  /**
   * Converts a world x coordinate (AU) to a screen x coordinate (CSS pixels).
   * @param {number} x
   * @returns {number}
   */
  sx(x) { return this.W / 2 + (x - this.view.cx) * this.view.scale; }

  /**
   * Converts a world y coordinate (AU) to a screen y coordinate (CSS pixels).
   * Flipped, because world y points up and screen y points down.
   * @param {number} y
   * @returns {number}
   */
  sy(y) { return this.H / 2 - (y - this.view.cy) * this.view.scale; }

  /**
   * Draws one complete frame, back to front: background and stars (in device pixels),
   * then trails, the launch preview, bodies, labels and the scale bar (in CSS pixels,
   * via a DPR transform). Does nothing if no canvas is attached.
   */
  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.starLayer) ctx.drawImage(this.starLayer, 0, 0);
    ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);

    if (this.showTrails) for (const b of this.bodies) this.drawTrail(b);
    if (this.drag && this.drag.moved) this.drawLaunchPreview();
    for (const b of this.bodies) this.drawBody(b);
    if (this.showLabels) this.drawLabels();
    this.drawScaleBar();
  }

  /**
   * Draws a body's trail as six consecutive segments with rising opacity, so it fades
   * out with age. The last segment connects to the body's current position so there's
   * no gap.
   * @param {Body} b
   */
  drawTrail(b) {
    const ctx = this.ctx, t = b.trail, n = t.length / 2;
    if (n < 2) return;
    const chunks = 6;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = b.color;
    for (let c = 0; c < chunks; c++) {
      const s = Math.floor((c * (n - 1)) / chunks), e = Math.floor(((c + 1) * (n - 1)) / chunks);
      if (e <= s) continue;
      ctx.globalAlpha = 0.06 + (0.42 * (c + 1)) / chunks;
      ctx.beginPath();
      ctx.moveTo(this.sx(t[2 * s]), this.sy(t[2 * s + 1]));
      for (let i = s + 1; i <= e; i++) ctx.lineTo(this.sx(t[2 * i]), this.sy(t[2 * i + 1]));
      if (c === chunks - 1) ctx.lineTo(this.sx(b.x), this.sy(b.y));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Draws one body, skipping it if it is well off screen. Stars get a radial glow, a pale
   * core and a colored rim; planets are a solid dot. The selected body gets an orange ring.
   * @param {Body} b
   */
  drawBody(b) {
    const ctx = this.ctx, x = this.sx(b.x), y = this.sy(b.y);
    if (x < -60 || y < -60 || x > this.W + 60 || y > this.H + 60) return;
    if (b.star) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, b.r * 4.5);
      // Appending two hex digits to #rrggbb sets the alpha channel.
      g.addColorStop(0, b.color + 'aa'); g.addColorStop(0.25, b.color + '33'); g.addColorStop(1, b.color + '00');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, b.r * 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff6e0';
      ctx.beginPath(); ctx.arc(x, y, b.r * 0.75, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = b.color; ctx.lineWidth = b.r * 0.35;
      ctx.beginPath(); ctx.arc(x, y, b.r * 0.75, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(x, y, b.r, 0, Math.PI * 2); ctx.fill();
    }
    if (b.id === this.selectedId) {
      ctx.strokeStyle = '#ffb547'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, b.r + 7, 0, Math.PI * 2); ctx.stroke();
    }
  }

  /** Draws each on-screen body's name just above and to the right of it. */
  drawLabels() {
    const ctx = this.ctx;
    ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillStyle = '#8790a4';
    ctx.textBaseline = 'middle';
    for (const b of this.bodies) {
      const x = this.sx(b.x), y = this.sy(b.y);
      if (x < -40 || y < -20 || x > this.W + 40 || y > this.H + 20) continue;
      ctx.fillText(b.name, x + b.r + 6, y - b.r - 4);
    }
  }

  /**
   * Draws a scale bar in the bottom-right corner. Picks the largest "nice" distance
   * (1, 2 or 5 × a power of ten AU) that is at most 130 pixels long at the current zoom.
   */
  drawScaleBar() {
    const ctx = this.ctx, { W, H } = this;
    const nice = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    let au = nice[0];
    for (const n of nice) if (n * this.view.scale <= 130) au = n;
    const len = au * this.view.scale, x1 = W - 16 - len, y = H - 18;
    ctx.strokeStyle = '#8790a4'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, y - 4); ctx.lineTo(x1, y); ctx.lineTo(x1 + len, y); ctx.lineTo(x1 + len, y - 4); ctx.stroke();
    ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillStyle = '#8790a4'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${au} AU`, W - 16, y - 6);
    ctx.textAlign = 'left';
  }

  // ---------- Launching ----------

  /**
   * Converts the current drag gesture into the new body's starting state.
   *
   * The press point becomes the position (screen → world). The drag vector becomes the
   * velocity at {@link LAUNCH_K} AU/yr per pixel, plus the velocity of the camera target,
   * so the launch is relative to what you're looking at (e.g. a moving binary).
   * Must only be called while a drag is in progress.
   * @returns {{kind: import('./scenarios.js').MassKind, x: number, y: number, vx: number, vy: number}}
   */
  launchState() {
    const kind = MASSES[this.massKind], drag = this.drag, view = this.view;
    const tgt = this.followTarget(this.bodies);
    const x = view.cx + (drag.sx - this.W / 2) / view.scale;
    const y = view.cy - (drag.sy - this.H / 2) / view.scale;
    const vx = (drag.x - drag.sx) * LAUNCH_K + (tgt.vx || 0);
    const vy = -(drag.y - drag.sy) * LAUNCH_K + (tgt.vy || 0);
    return { kind, x, y, vx, vy };
  }

  /**
   * Works out whether a body launched from (x, y) at (vx, vy) would stay in the system.
   *
   * Sums the gravitational potential φ = −Σ G·m / r from all existing bodies at that point.
   * Escape speed is √(−2φ). The body is bound if its specific energy v²/2 + φ is negative.
   * Speed is measured relative to the center of mass.
   * @param {number} x
   * @param {number} y
   * @param {number} vx
   * @param {number} vy
   * @returns {{v: number, vesc: number, bound: boolean}} Speed and escape speed in km/s,
   *   and whether it's bound.
   */
  escapeInfo(x, y, vx, vy) {
    let phi = 0;
    for (const b of this.bodies) phi -= (G * b.m) / Math.max(Math.hypot(b.x - x, b.y - y), 1e-4);
    const c = com(this.bodies);
    const v2 = (vx - c.vx) ** 2 + (vy - c.vy) ** 2;
    return { v: Math.sqrt(v2) * KMS, vesc: Math.sqrt(-2 * phi) * KMS, bound: v2 / 2 + phi < 0 };
  }

  /**
   * Draws the aiming overlay while the user drags: the predicted path (dashed), the
   * launch arrow, a ghost of the new body, and a speed / escape-speed readout.
   *
   * The prediction runs a throwaway copy of the whole system plus a "probe" for the new
   * body, for up to 1500 steps covering 1–12 years (longer when zoomed out). Points are
   * recorded relative to the camera target, so the path matches what you'll see on
   * screen. It stops early if the probe hits a star.
   */
  drawLaunchPreview() {
    const ctx = this.ctx, { W, H, drag, bodies } = this;
    const L = this.launchState();

    // Lightweight copies: no trails or names needed for prediction.
    const sim = bodies.map((b) => ({ id: b.id, m: b.m, x: b.x, y: b.y, vx: b.vx, vy: b.vy, ax: 0, ay: 0, star: b.star }));
    const probe = { id: -1, m: L.kind.m, x: L.x, y: L.y, vx: L.vx, vy: L.vy, ax: 0, ay: 0, star: L.kind.m >= 0.05 };
    sim.push(probe);
    const followId =
      this.followMode === 'selected' && bodies.some((b) => b.id === this.selectedId) ? this.selectedId
        : this.followMode === 'star' && bodies.length ? heaviest(bodies).id
          : null;
    // Where the camera target is inside the copy, so the path is drawn in the camera's frame.
    const ref = () => (followId != null ? sim.find((b) => b.id === followId) : com(sim.filter((b) => b !== probe)));
    const r0 = ref(), ox = r0.x, oy = r0.y;
    computeAcc(sim);
    const viewR = (0.5 * Math.min(W, H)) / this.view.scale;
    const horizon = Math.max(1, Math.min(12, 1.3 * Math.pow(viewR, 1.5)));
    const pts = [];
    let t = 0;
    for (let i = 0; i < 1500 && t < horizon; i++) {
      const dt = Math.min(horizon / 900, chooseDt(sim, -1).dt);
      step(sim, dt); t += dt;
      let hit = false;
      for (const b of sim) if (b !== probe && b.star && Math.hypot(b.x - probe.x, b.y - probe.y) < collR(b) + collR(probe)) hit = true;
      const r = ref();
      pts.push(probe.x - r.x + ox, probe.y - r.y + oy);
      if (hit) break;
    }
    ctx.setLineDash([4, 5]);
    ctx.strokeStyle = '#ffb547'; ctx.globalAlpha = 0.7; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(this.sx(L.x), this.sy(L.y));
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(this.sx(pts[i]), this.sy(pts[i + 1]));
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;

    // Launch arrow from press point to current pointer, with a two-stroke arrowhead.
    const ax = drag.sx, ay = drag.sy, bx = drag.x, by = drag.y, ang = Math.atan2(by - ay, bx - ax);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.moveTo(bx, by); ctx.lineTo(bx - 9 * Math.cos(ang - 0.4), by - 9 * Math.sin(ang - 0.4));
    ctx.moveTo(bx, by); ctx.lineTo(bx - 9 * Math.cos(ang + 0.4), by - 9 * Math.sin(ang + 0.4));
    ctx.stroke();
    ctx.fillStyle = COLORS[this.launchCount % COLORS.length];
    ctx.beginPath(); ctx.arc(ax, ay, L.kind.r, 0, Math.PI * 2); ctx.fill();

    // Readout bubble next to the pointer, flipped to the other side near screen edges.
    const e = this.escapeInfo(L.x, L.y, L.vx, L.vy);
    const line1 = `${e.v.toFixed(1)} km/s`;
    const line2 = e.bound ? `orbits · escape at ${e.vesc.toFixed(1)}` : `escapes (needs ${e.vesc.toFixed(1)})`;
    ctx.font = '12px "IBM Plex Mono", ui-monospace, monospace';
    const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 18;
    let bx2 = bx + 14, by2 = by + 14;
    if (bx2 + w > W - 8) bx2 = bx - 14 - w;
    if (by2 + 44 > H - 8) by2 = by - 14 - 44;
    ctx.fillStyle = 'rgba(13,18,28,0.92)'; ctx.strokeStyle = '#1e2737';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx2, by2, w, 44, 6); else ctx.rect(bx2, by2, w, 44);
    ctx.fill(); ctx.stroke();
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#e6e9f0'; ctx.fillText(line1, bx2 + 9, by2 + 7);
    ctx.fillStyle = e.bound ? '#72d6a4' : '#ff8f70'; ctx.fillText(line2, bx2 + 9, by2 + 24);
  }

  /**
   * Adds the body described by the current drag to the simulation and selects it.
   * It's named "<Kind> <n>" and colored from the rotating palette; stars are always orange.
   */
  launch() {
    const L = this.launchState();
    this.launchCount++;
    const b = mk({
      name: `${L.kind.kind} ${this.launchCount}`, m: L.kind.m, r: L.kind.r,
      color: COLORS[(this.launchCount - 1) % COLORS.length], x: L.x, y: L.y, vx: L.vx, vy: L.vy,
    });
    if (b.star) b.color = '#ff8a5c';
    this.bodies.push(b);
    this.resetEnergy();
    this.selectedId = b.id;
  }

  /**
   * Finds the body under a screen point. Distance is measured from the body's drawn edge,
   * and anything within 16 px counts, so small planets are still easy to tap.
   * @param {number} px Screen x (CSS pixels).
   * @param {number} py Screen y (CSS pixels).
   * @returns {Body|null} The closest body, or null if none is near.
   */
  pickBody(px, py) {
    let best = null, bd = 16;
    for (const b of this.bodies) {
      const d = Math.hypot(this.sx(b.x) - px, this.sy(b.y) - py) - b.r;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // ---------- Pointer input ----------

  /**
   * Starts a gesture. Captures the pointer so moves outside the canvas still arrive.
   * A second simultaneous pointer cancels any drag and starts a pinch-zoom, recording the
   * starting finger distance and zoom. Otherwise it starts a drag, remembering which body
   * (if any) is under the pointer in case this turns out to be a tap.
   * @param {PointerEvent} e
   */
  onPointerDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pointers.size === 2) {
      this.drag = null;
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: this.view.scale };
      return;
    }
    this.drag = { sx: e.offsetX, sy: e.offsetY, x: e.offsetX, y: e.offsetY, hit: this.pickBody(e.offsetX, e.offsetY), moved: false };
  }

  /**
   * Updates the gesture in progress. During a pinch, zoom scales with the ratio of the
   * current finger distance to the starting distance. During a drag, the pointer position
   * is tracked, and once it has moved more than 6 px the drag counts as a launch (which
   * makes the preview appear) rather than a tap.
   * @param {PointerEvent} e
   */
  onPointerMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      this.zoomTo((this.pinch.s * Math.hypot(a.x - b.x, a.y - b.y)) / this.pinch.d);
      return;
    }
    const drag = this.drag;
    if (drag) {
      drag.x = e.offsetX; drag.y = e.offsetY;
      if (Math.hypot(drag.x - drag.sx, drag.y - drag.sy) > 6) drag.moved = true;
    }
  }

  /**
   * Finishes a gesture on pointerup or pointercancel. Ending a pinch never launches or
   * selects. A completed drag launches a body; a completed tap selects the body under it,
   * or clears the selection on empty sky. A cancelled pointer just abandons the drag.
   * @param {PointerEvent} e
   */
  onPointerEnd(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      this.drag = null;
      return;
    }
    if (!this.drag) return;
    if (e.type === 'pointerup') {
      if (this.drag.moved) this.launch();
      else this.selectedId = this.drag.hit ? this.drag.hit.id : null;
      this.emit();
    }
    this.drag = null;
  }

  // ---------- Selected-body readout ----------

  /**
   * Builds the data for the selected-body card, or null if nothing is selected.
   *
   * The "host" is the heavier body exerting the strongest pull (mass / distance²). Relative
   * to the host, it computes the standard two-body orbital elements:
   * - specific energy ε = v²/2 − μ/r (negative means bound), where μ = G(M + m)
   * - semi-major axis a = −μ / 2ε, giving the period P = √(a³ / (M + m)) by Kepler's third law
   * - eccentricity e = √(1 + 2εh² / μ²), where h is the specific angular momentum
   *
   * A body with no heavier neighbor (e.g. the Sun) instead shows its wobble speed around
   * the center of mass, which is how real exoplanets are detected.
   * @returns {SelectedInfo|null}
   */
  selectedInfo() {
    const bodies = this.bodies;
    const b = bodies.find((x) => x.id === this.selectedId);
    if (!b) return null;

    let host = null, best = 0;
    for (const o of bodies) {
      if (o === b || o.m <= b.m) continue;
      const pull = o.m / ((o.x - b.x) ** 2 + (o.y - b.y) ** 2);
      if (pull > best) { best = pull; host = o; }
    }

    const rows = [{ label: 'Mass', value: fmtMass(b.m) }];
    let note = '';
    if (host) {
      const rx = b.x - host.x, ry = b.y - host.y, vx = b.vx - host.vx, vy = b.vy - host.vy;
      const r = Math.hypot(rx, ry), v2 = vx * vx + vy * vy, mu = G * (host.m + b.m);
      const en = v2 / 2 - mu / r, h = rx * vy - ry * vx;
      rows.push(
        { label: 'Orbiting', value: host.name },
        { label: 'Distance', value: `${r.toFixed(3)} AU` },
        { label: 'Speed', value: `${(Math.sqrt(v2) * KMS).toFixed(2)} km/s` },
      );
      if (en < 0) {
        const a = -mu / (2 * en), ecc = Math.sqrt(Math.max(0, 1 + (2 * en * h * h) / (mu * mu)));
        const P = Math.sqrt((a * a * a) / (host.m + b.m));
        rows.push(
          { label: 'Orbit', value: 'bound', tone: 'ok' },
          { label: 'One lap takes', value: P < 2 ? `${(P * 365.25).toFixed(0)} days` : `${P.toFixed(2)} years` },
          { label: 'Shape', value: `${ecc.toFixed(3)} · ${shapeWord(ecc)}` },
        );
      } else {
        rows.push({ label: 'Orbit', value: 'escaping', tone: 'bad' });
        note = 'It is moving faster than the escape speed, so it will not come back.';
      }
    } else {
      const c = com(bodies);
      const v = Math.hypot(b.vx - c.vx, b.vy - c.vy) * KMS * 1000;
      rows.push({ label: 'Wobble speed', value: v < 1000 ? `${v.toFixed(1)} m/s` : `${(v / 1000).toFixed(2)} km/s` });
      if (bodies.length > 1) note = 'Everything else pulls on it too, so it circles the shared center of mass. Astronomers measure this wobble in real stars to find hidden planets.';
    }
    return { id: b.id, name: b.name, color: b.color, rows, note };
  }
}

// ---------- Formatting ----------

/**
 * Formats a mass in the most natural unit: Suns for stars (≥ 0.05 M☉), Jupiters for
 * giants (≥ 100 Earths), otherwise Earths.
 * @param {number} m Mass in solar masses.
 * @returns {string} e.g. "1.00 Suns", "1.00 Jupiters", "0.107 Earths".
 */
function fmtMass(m) {
  if (m >= 0.05) return `${m.toFixed(2)} Suns`;
  const e = m / EARTH;
  return e >= 100 ? `${(m / JUP).toFixed(2)} Jupiters` : `${e < 1 ? e.toFixed(3) : e.toFixed(2)} Earths`;
}

/**
 * Formats elapsed simulated time: whole days under 2 years, otherwise years.
 * @param {number} t Time in years.
 * @returns {string} e.g. "214 days", "12.50 years", "340.2 years".
 */
export function fmtTime(t) {
  return t < 2 ? `${Math.floor(t * 365.25)} days` : `${t.toFixed(t < 100 ? 2 : 1)} years`;
}

/**
 * Describes an orbital eccentricity in plain words.
 * @param {number} e Eccentricity (0 = circle, approaching 1 = very elongated).
 * @returns {string}
 */
function shapeWord(e) {
  return e < 0.05 ? 'nearly circular' : e < 0.3 ? 'slightly oval' : e < 0.7 ? 'oval' : 'very stretched';
}
