# Orbit Lab

An interactive N-body gravity simulator. Every body pulls on every other body with Newton's law of gravity; nothing is scripted, so orbits, slingshots, collisions and escapes all come out of the math.

```
npm install
npm run dev       # development server
npm run build     # production build into dist/
```

This document explains how the simulation engine and physics work, and how they are wired into React.

---

## Contents

1. [Project layout](#project-layout)
2. [Architecture: two worlds](#architecture-two-worlds)
3. [The physics (`physics.js`)](#the-physics-physicsjs)
4. [Scenarios and launchable bodies (`scenarios.js`)](#scenarios-and-launchable-bodies-scenariosjs)
5. [The engine (`engine.js`)](#the-engine-enginejs)
6. [How React uses the engine](#how-react-uses-the-engine)
7. [Walkthroughs: what happens when…](#walkthroughs-what-happens-when)
8. [Extending the app](#extending-the-app)
9. [Tuning constants](#tuning-constants)
10. [Performance and limitations](#performance-and-limitations)

---

## Project layout

```
src/
├── physics.js          Pure math: gravity, integrator, energy, center of mass. No DOM.
├── scenarios.js        Preset systems, launchable masses, launch colors. Data + builders.
├── engine.js           Simulation class: state, frame loop, canvas rendering, input,
│                       and the snapshot interface React reads from.
├── useToast.js         Hook for the auto-fading notification.
├── App.jsx             Creates the engine, subscribes to it, lays out the page.
├── main.jsx            Mounts <App /> in StrictMode.
├── index.css           All styles (ported unchanged from the original orbit.html).
└── components/
    ├── Sky.jsx             Canvas + zoom buttons + toast. Hands the canvas to the engine.
    ├── ClockControls.jsx   Elapsed time, energy error, play/restart, speed slider.
    ├── ScenarioPicker.jsx  Scenario buttons.
    ├── LaunchPicker.jsx    Mass selector for launched bodies.
    ├── SelectedBody.jsx    Orbit readout card for the selected body.
    ├── ViewOptions.jsx     Camera follow mode, trails and labels toggles.
    └── ThingsToTry.jsx     Static suggestions.
```

The dependency direction is strictly one way:

```
physics.js  ←  scenarios.js  ←  engine.js  ←  App.jsx / components
```

`physics.js` knows nothing about the engine; the engine knows nothing about React.

---

## Architecture: two worlds

The app is split into two parts that run at very different rates.

| | Engine (`Simulation`) | React |
|---|---|---|
| Updates | Every animation frame (~60/s), often thousands of physics steps per frame | ~8 times per second, plus on user actions |
| State | Plain mutable objects, changed in place | Immutable snapshots |
| Draws | Directly to a `<canvas>` with the 2D context | The side panel's DOM |
| Owns | Bodies, physics, camera, canvas input | Layout, buttons, sliders, text |

If body positions were React state, React would re-render the whole tree 60 times a second and allocate new arrays for every step. Instead, the engine mutates its own data and draws it itself, and React only sees a small summary.

```
                   ┌──────────────────────────── Simulation (engine.js) ─────────────────────────────┐
                   │                                                                                 │
 requestAnimation  │   frame(now)                                                                    │
 Frame ──────────▶ │     ├─ physics steps (chooseDt → step → collisions → trails) ×N                 │
                   │     ├─ removeEscapes, camera follow                                             │
                   │     ├─ draw() ─────────────────────────────────────────────▶ <canvas>          │
                   │     └─ every 120 ms: emit() ──┐                                                 │
                   │                               │                                                 │
 pointer / wheel ─▶│   onPointerDown/Move/End      │   snap = { simT, count, drift, speed, ... }     │
 (on the canvas)   │     └─ launch() / select ─▶ emit()                                              │
                   │                               │                                                 │
                   │   load, setSpeed, setFollowMode, removeSelected, zoomBy ... ─▶ emit()           │
                   └───────────────────────────────┼─────────────────────────────────────────────────┘
                              ▲                    │ notify subscribers
               action methods │                    ▼
                   ┌──────────┴────────── React ─────────────────────────────────────────┐
                   │  App: snap = useSyncExternalStore(sim.subscribe, sim.getSnapshot)   │
                   │  <ClockControls snap sim/>  <ScenarioPicker/>  <SelectedBody/> ...  │
                   └─────────────────────────────────────────────────────────────────────┘
```

Data flows down as snapshots; actions flow up as method calls. React never writes engine fields directly.

---

## The physics (`physics.js`)

### Units

The simulation uses astronomical units throughout:

| Quantity | Unit |
|---|---|
| Distance | AU (Earth–Sun distance, ~150 million km) |
| Time | years |
| Mass | solar masses (M☉) |
| Velocity | AU/yr (×4.74 = km/s, see `KMS`) |

In these units the gravitational constant is **G = 4π²**. That choice makes Kepler's third law come out as P² = a³ / M: a body 1 AU from a 1 M☉ star orbits in exactly 1 year. Numbers stay close to 1, which keeps floating-point error small and the code readable.

### Bodies

A body is a plain object (see the `Body` typedef):

```js
{ id, name, m, color, r, x, y, vx, vy, ax, ay, trail, star }
```

- `x, y, vx, vy` are physical state; `ax, ay` are scratch space filled in by `computeAcc`.
- `r` is the **drawn** radius in pixels. Physical sizes are not to scale; a true-scale Sun would be invisible at Solar System zoom.
- `trail` is a flat number array `[x0, y0, x1, y1, …]`, which avoids allocating one object per point.
- `star` is true for masses ≥ 0.05 M☉. It controls drawing (glow) and collision radius.

`mk(o)` creates a body with a unique `id`, zero acceleration, an empty trail and `star` derived from mass.

### Gravity: `computeAcc`

For every pair of bodies *a* and *b*:

```
a accelerates toward b by   G·m_b / r²
b accelerates toward a by   G·m_a / r²
```

In vector form the acceleration on *a* is `G·m_b·(b − a) / r³`. The code computes `1/r³` once per pair and applies it to both bodies, so each pair is visited only once (n(n−1)/2 pairs).

**Softening.** `r²` has a tiny constant `EPS2 = 1e-6 AU²` added before use. Without it, two bodies passing through the same point would produce an infinite force. The value corresponds to ~0.001 AU, far smaller than any orbit in the app, so it doesn't measurably change normal motion.

### Integration: `step` (leapfrog)

Positions and velocities are advanced with the **kick–drift–kick leapfrog** method:

```
v ← v + a·dt/2        (half kick, using old accelerations)
x ← x + v·dt          (drift)
a ← computeAcc(x)     (forces at new positions)
v ← v + a·dt/2        (half kick, using new accelerations)
```

Why leapfrog instead of the simpler Euler method (`x += v·dt; v += a·dt`)?

- **Euler** adds a small amount of energy every orbit. Planets slowly spiral outward and eventually escape.
- **Leapfrog** is *symplectic*: it exactly preserves a quantity very close to the true energy. Energy wobbles slightly within each orbit but does not drift over thousands of orbits.
- It costs one force evaluation per step, the same as Euler.

`step` assumes `ax/ay` already hold accelerations for the current positions. That's why the engine calls `computeAcc` (via `resetEnergy`) whenever bodies are added, removed or merged.

### Adaptive time steps: `chooseDt`

A fixed step can't serve both Neptune (165-year orbit) and a planet skimming a star (an orbit of hours). `chooseDt` looks at every pair and estimates its **dynamical time**, the time scale of their mutual orbit:

```
t_pair = √( r³ / (G·(m_a + m_b)) )
```

The step is `0.015 × min(t_pair)`, so the tightest pair always gets roughly 400 steps per orbit (2π / 0.015). It is capped at `BASE_DT` (0.0005 yr, ~4.4 hours) and floored at `2e-7` yr so a near-collision can't drive the step to zero and stall the loop.

`chooseDt` also reports whether any pair is inside collision range, since it is already computing every pair distance.

The optional `onlyId` argument restricts the check to pairs involving one body, and disables collision reporting. The launch preview passes `-1`, the id of its probe, so the preview's step size adapts to the probe's closest approach only. That is cheaper, and the other bodies' orbits are already well resolved by the `horizon / 900` cap on the preview's steps.

### Energy: `energy`

```
E = Σ ½·m·v²  −  Σ_pairs G·m_a·m_b / r
```

Real gravity conserves E exactly, so the engine records `E0` at the start and the panel shows `|E − E0| / |E0|` as **energy error**. It is a live accuracy gauge: it should sit far below 0.01% in normal scenarios, and jumps during very close encounters.

### Center of mass: `com`

Returns the mass-weighted mean position and velocity. Used to:

- shift every scenario so the system's center of mass starts at the origin, at rest (otherwise e.g. the Sun–Jupiter system would slowly drift off screen);
- give the camera its default target;
- decide when a body has escaped (distance from the center of mass);
- measure a star's "wobble" speed.

### Collisions

`collR(b)` gives each body a collision radius in AU: 0.02 for stars (several solar radii, so grazing passes merge instead of producing extreme slingshots), 0.0005 for giants, 0.0002 for small planets. Two bodies collide when their centers are closer than the sum of their radii. Merging happens in the engine (see [`resolveCollisions`](#collisions-and-escapes)).

---

## Scenarios and launchable bodies (`scenarios.js`)

### `circ(name, a, m, color, r, phase, M)`

Builds a body on a circular orbit of radius `a` around mass `M` at the origin. Circular speed is `v = √(G·M / a)`, directed perpendicular to the radius so the orbit runs counter-clockwise.

### `SCENARIOS`

Each scenario is `{ label, blurb, radius, speed, build }`:

- `build()` returns a **fresh** array of bodies every call, so Restart never reuses mutated objects.
- `radius` is how many AU should fit on screen initially.
- `speed` is the initial years-per-second.

| Key | What it builds |
|---|---|
| `solar` | Sun + 8 planets on circular orbits at real distances and masses. |
| `binary` | Two 1 M☉ stars 1 AU apart in a circular mutual orbit; two planets orbiting the 2 M☉ pair. |
| `eight` | The Chenciner–Montgomery figure-eight three-body orbit. Published in G = 1 units; velocities are multiplied by √G = 2π to convert. |
| `rogue` | Sun + 6 planets, plus a 0.5 M☉ star approaching at ~28 km/s. |
| `sandbox` | Just the Sun. |

### `MASSES` and `COLORS`

`MASSES` defines what a drag launches (`rock`, `giant`, `star`): mass, drawn radius, name prefix and UI labels. `COLORS` is the rotating palette for launched bodies.

---

## The engine (`engine.js`)

`Simulation` is a plain class. It owns:

| Group | Fields |
|---|---|
| Simulation | `bodies`, `simT` (elapsed years), `E0` (energy baseline) |
| Settings | `running`, `speed`, `scenario`, `selectedId`, `followMode`, `showTrails`, `showLabels`, `massKind` |
| Camera | `view.scale` (pixels per AU), `view.cx/cy` (world point at screen center), `view.pendingRadius` |
| Canvas | `canvas`, `ctx`, `W`, `H` (CSS pixels), `DPR`, `starLayer` |
| Input | `drag`, `pinch`, `pointers` |
| Store | `listeners`, `snap` |

The constructor loads the Solar System immediately, so a valid snapshot exists before any component renders. No canvas is needed yet; the requested zoom is stored in `view.pendingRadius` and applied on the first resize.

### The frame loop: `frame(now)`

Called once per animation frame by the loop that `attach` starts.

1. **Real time elapsed.** `fdt = min(0.05, (now − last) / 1000)`. The 50 ms cap means a tab that was in the background doesn't try to simulate minutes of catch-up in one frame.
2. **Simulated time to cover.** `target = speed × fdt`. At 0.5 yr/s and 60 fps that's ~0.0083 years per frame.
3. **Step until covered** (at most `MAX_STEPS` = 4000 per frame):
   - `chooseDt` → step size and collision flag. The last step is trimmed so the total lands exactly on `target`.
   - `step` → advance everything.
   - If the collision flag was set → `resolveCollisions()`.
   - **Trails:** each body appends its position only if it moved more than 1.5 screen pixels since its last point (Manhattan distance, for speed). That keeps trail density tied to what's visible, not to step count. When a trail exceeds 1800 points, the oldest 300 are dropped in one splice (cheaper than shifting one at a time).
4. `simT += done`, then `removeEscapes()`.
5. **Camera.** `followTarget()` returns the center of mass, heaviest body or selected body; `view.cx/cy` are set to it.
6. `draw()`.
7. If 120 ms have passed since the last one, `emit()` a snapshot to React.

When paused, steps 2–4 are skipped but the camera, drawing and snapshots continue, so you can still zoom, select and aim.

### Collisions and escapes

**`resolveCollisions()`** merges every touching pair, repeating until none remain. The surviving body is the heavier one; it takes:

- combined mass `M = m_a + m_b`
- mass-weighted position and velocity (so **momentum is conserved**; kinetic energy is not, as in a real inelastic collision)
- star status if it now exceeds 0.05 M☉

Selection transfers to the survivor, a toast is shown, and `resetEnergy()` sets a new energy baseline (the merge legitimately changed the system's energy).

**`removeEscapes()`** deletes bodies more than 2000 AU from the center of mass, with a toast.

### Coordinates and the camera

Two helpers convert world coordinates (AU) to screen coordinates (CSS pixels):

```js
sx(x) = W/2 + (x − view.cx) · view.scale
sy(y) = H/2 − (y − view.cy) · view.scale   // flipped: world y is up, screen y is down
```

Zoom changes `view.scale` (clamped to 0.3–4000 px/AU). Panning is never manual; the camera always tracks the follow target.

### Rendering: `draw()`

The canvas buffer is `W·DPR × H·DPR` device pixels for crisp high-DPI output. Each frame:

1. Reset the transform, fill the background, copy in the **starfield**. `buildStars()` draws the stars once per resize into an offscreen canvas using a seeded random generator, so they stay put and each frame copies them in a single `drawImage`.
2. Set a `DPR` transform so everything else is drawn in CSS pixels.
3. Trails (`drawTrail`): split into 6 segments of increasing opacity, so trails fade with age without per-point styling.
4. Launch preview, if a drag is in progress.
5. Bodies (`drawBody`): stars get a radial-gradient glow, pale core and colored rim; planets are a filled circle; the selected body gets an orange ring. Off-screen bodies are skipped.
6. Labels and the scale bar (largest 1-2-5 × 10ⁿ AU length that fits in 130 px).

### Launching bodies

**`launchState()`** converts the drag into initial conditions:

```
position = screen→world(press point)
velocity = (drag vector in px) × LAUNCH_K   (0.05 AU/yr per px, y flipped)
         + velocity of the camera target
```

Adding the camera target's velocity makes launches relative to what you're watching. In the Binary Star scenario following Sun A, a sideways drag gives a planet that orbits Sun A, not one that has Sun A's motion subtracted.

**`escapeInfo()`** powers the speed bubble. It sums the gravitational potential at the launch point:

```
φ = −Σ G·m_i / r_i
v_escape = √(−2φ)
bound  ⇔  v²/2 + φ < 0        (v measured relative to the center of mass)
```

**`drawLaunchPreview()`** predicts the dashed path by actually simulating it:

1. Copy every body into lightweight objects (no names or trails) and add a **probe** for the new body.
2. Integrate the copy forward with the same `computeAcc`/`step` used by the real simulation, for a horizon of 1–12 years (longer when zoomed out, `1.3 · viewRadius^1.5`, which tracks the orbital period at the edge of the screen), up to 1500 steps.
3. Record the probe's position **relative to the camera target inside the copy**, then offset by where the target is now. The path is therefore drawn in the same moving frame the camera uses, so it lines up with what will actually happen on screen.
4. Stop early if the probe hits a star.

This runs every frame during a drag, so the path reacts live as you aim, and it includes perturbations from every body, not only the nearest star.

**`launch()`** creates the real body with `mk`, names it ("Planet 3"), picks its color, appends it, calls `resetEnergy()` and selects it.

### Input

Pointer events (mouse, pen and touch share one code path):

| Event | Behavior |
|---|---|
| `pointerdown` | Capture the pointer. With 2 pointers down, start a **pinch** (record finger distance and zoom). Otherwise start a **drag**, remembering the body under the pointer (`pickBody`). |
| `pointermove` | Pinch: `scale = startScale × currentDistance / startDistance`. Drag: track position; past 6 px it becomes a launch and the preview appears. |
| `pointerup` | If a pinch was active, end it without launching. Moved drag → `launch()`. Unmoved → **tap**: select the body under it, or deselect. Then `emit()`. |
| `pointercancel` | Abandon the gesture. |
| `wheel` | `scale × e^(−deltaY · 0.0015)`. Registered non-passive so it can prevent page scroll. |

`pickBody` measures distance from each body's drawn edge and accepts anything within 16 px, so tiny planets are still tappable.

### The selected-body readout: `selectedInfo()`

1. **Find the host**: among bodies heavier than the selected one, the one with the strongest pull (`m / r²`). That's what it orbits.
2. **Two-body orbital elements**, relative to the host, with `μ = G·(M + m)`:

   | Quantity | Formula | Shown as |
   |---|---|---|
   | Specific orbital energy | `ε = v²/2 − μ/r` | negative → "bound", positive → "escaping" |
   | Semi-major axis | `a = −μ / (2ε)` | (used for period) |
   | Period | `P = √(a³ / (M + m))` (Kepler III in these units) | "One lap takes" |
   | Specific angular momentum | `h = rₓ·v_y − r_y·vₓ` | (used for eccentricity) |
   | Eccentricity | `e = √(1 + 2εh²/μ²)` | "Shape", plus a word like "slightly oval" |

3. **No heavier host** (e.g. the Sun): show its speed relative to the center of mass, the "wobble" used by astronomers to detect exoplanets via radial velocity.

The result is plain data, `{ id, name, color, rows: [{label, value, tone}], note }`, so React decides how it looks.

This is an *osculating* (instantaneous) two-body approximation: it ignores every body except the host. In multi-body systems the numbers drift as other bodies perturb the orbit; that's real physics, not a bug.

---

## How React uses the engine

### 1. One engine per app

```jsx
const [toast, showToast] = useToast();
const [sim] = useState(() => new Simulation({ onToast: showToast }));
```

The lazy `useState` initializer runs only on the first render, so the engine survives re-renders. (A `useRef` would also work; `useState` without a setter is the idiomatic "create once" form.) `showToast` is stable for the component's life, so the engine can safely hold on to it.

### 2. Reading state: `useSyncExternalStore`

```jsx
const snap = useSyncExternalStore(sim.subscribe, sim.getSnapshot);
```

This is React's built-in hook for state that lives outside React. The engine satisfies its contract:

- **`subscribe(fn)`** adds `fn` to a listener set and returns an unsubscribe function.
- **`getSnapshot()`** returns `this.snap`, the *same object* until the next `emit()`. React compares snapshots by identity, so returning a new object each call would cause an infinite render loop.
- **`emit()`** builds a new snapshot object and calls every listener, which tells React to re-render.

`subscribe` and `getSnapshot` are arrow-function class fields, so they are bound to the instance and can be passed directly without `.bind`.

The snapshot (`Snapshot` typedef) contains only what the panel displays:

```js
{ simT, count, drift, running, speed, scenario, followMode,
  showTrails, showLabels, massKind, selected }
```

Body positions, trails and the camera are **not** in it; only the canvas needs those.

### 3. When snapshots are emitted

| Trigger | Why |
|---|---|
| Every 120 ms from `frame()` | Keeps the clock, energy error and orbit readout ticking (~8 updates/s is plenty for text). |
| After every action method (`load`, `setSpeed`, `setRunning`, `setMassKind`, `setFollowMode`, `removeSelected`, ...) | Buttons and controls respond on the same frame instead of waiting up to 120 ms. |
| After a tap or launch (`onPointerEnd`) | The selection card appears immediately. |

Zoom methods and `clearTrails` don't emit, since nothing in the panel depends on them.

### 4. Writing state: action methods

Components never modify engine fields; they call methods:

```jsx
<button onClick={() => sim.toggleRunning()}>…</button>
<input type="range" value={speedToSlider(snap.speed)}
       onChange={e => sim.setSpeed(sliderToSpeed(+e.target.value))} />
```

Each method updates the engine and calls `emit()`, which produces a new snapshot, which re-renders the control with its new value. All form controls are **controlled** from the snapshot. That matters because the engine also changes settings on its own: loading a scenario sets a new speed (the slider moves), and switches follow mode away from "Selected body" (the dropdown updates).

### 5. Handing over the canvas: `attach`

```jsx
// Sky.jsx
const canvasRef = useRef(null);
useEffect(() => sim.attach(canvasRef.current), [sim]);
return <canvas ref={canvasRef} className="sky" />;
```

React creates the `<canvas>` element and never touches it again. `attach`:

1. stores the canvas and its 2D context;
2. starts a `ResizeObserver` (calls `resize()` on size changes, which resizes the pixel buffer and rebuilds the starfield);
3. registers pointer and wheel listeners;
4. starts the `requestAnimationFrame` loop;
5. **returns a cleanup function** that cancels the loop, disconnects the observer, removes the listeners and drops the canvas reference.

Returning that function straight from the effect means React runs it on unmount. In development, `<StrictMode>` mounts, unmounts and remounts every component to surface missing cleanup; without it you'd end up with two animation loops running the physics at double speed.

Because the canvas listeners are attached natively (not as React `onPointerDown` props), the per-frame input path never goes through React.

### 6. Toasts

The engine raises events it can't display itself (collisions, escapes) through the `onToast` callback. `useToast` turns that into React state:

```
show(msg) → { msg, visible: true }
  +3200 ms → visible: false        (CSS opacity transition fades it)
  +400 ms  → msg: ''               (element gets the `hidden` attribute)
```

A new message cancels pending timers, so it always gets its full display time.

### 7. Keyboard shortcuts

`App` adds one `window` `keydown` listener in an effect (with cleanup): Space toggles play, `+`/`=` and `-` zoom. Keys are ignored when focus is inside a button, input, select or textarea, so Space still presses focused buttons and arrows still move the slider.

---

## Walkthroughs: what happens when…

### …you click "Binary Star"

1. `ScenarioPicker` calls `sim.load('binary')`.
2. `load` builds fresh bodies, re-centers them on the center of mass, calls `resetEnergy()`, resets `simT`/selection/launch counter, sets `speed = 0.4`, rescales the view to fit 5 AU, and calls `emit()`.
3. React re-renders: the Binary Star button gets `aria-pressed`, the slider jumps to 0.40 yr/s, the clock reads "0 days", and the Selected card empties.
4. On the next animation frame the engine draws the new system.

### …you drag on the sky to launch a planet

1. `pointerdown` → `drag = { sx, sy, x, y, hit, moved: false }`.
2. `pointermove` updates `drag.x/y`; after 6 px, `moved = true`.
3. Each frame, `draw()` sees `drag.moved` and calls `drawLaunchPreview()`: it forward-simulates a copy with a probe and draws the dashed path, arrow and speed bubble. React isn't involved.
4. `pointerup` → `launch()` adds the body, resets the energy baseline and selects it → `emit()`.
5. React re-renders: body count increments, and the Selected card shows the new planet's orbit.

### …two bodies collide mid-frame

1. Inside the step loop, `chooseDt` reports `collision: true`.
2. `resolveCollisions()` merges the pair, transfers selection, calls `onToast("Planet 2 crashed into Sun.")` and resets the energy baseline.
3. `showToast` sets React state; the toast appears immediately.
4. The next 120 ms snapshot updates the body count and Selected card.

---

## Extending the app

### Add a scenario

Add an entry to `SCENARIOS` in `scenarios.js`:

```js
trojans: {
  label: 'Trojan Asteroids',
  blurb: 'Jupiter leads and trails clusters of asteroids at the L4 and L5 points.',
  radius: 7,
  speed: 1,
  build: () => [
    sun(),
    circ('Jupiter', 5.203, JUP, '#d9a679', 6, 0),
    circ('L4', 5.203, 1e-12, '#c9a7ff', 2, Math.PI / 3),
    circ('L5', 5.203, 1e-12, '#c9a7ff', 2, -Math.PI / 3),
  ],
},
```

The picker renders it automatically. `build` must create new bodies each call (use `mk`/`circ`, never shared objects). You don't need to center the system; `load` does that.

### Add a launchable body type

Add an entry to `MASSES`. `LaunchPicker` renders it automatically. Masses ≥ 0.05 M☉ become stars.

### Show a new number in the panel

1. Compute it in `emit()` (or in `selectedInfo()` for per-body values) and add it to the snapshot.
2. Add the field to the `Snapshot` typedef.
3. Read it from `snap` in a component.

Keep snapshot fields cheap to compute: `emit()` runs ~8 times a second. `energy()` is O(n²) and is fine at these body counts.

### Add a new setting

1. Add a field in the constructor.
2. Add a setter that assigns it and calls `this.emit()`.
3. Include it in the snapshot.
4. Render a control whose value comes from `snap` and whose `onChange` calls the setter.
5. Read the field wherever the engine needs it (`frame`, `draw`, ...).

### Change the physics

Everything numerical is in `physics.js` and is independent of the engine and DOM, so it can be unit-tested directly with plain arrays of bodies. If you change how forces are computed, keep `computeAcc` writing into `ax/ay` and keep `step` assuming accelerations are current on entry. Use the energy error readout as a regression check: Solar System at default speed should stay well under 0.01%.

---

## Tuning constants

| Constant | File | Value | Effect |
|---|---|---|---|
| `EPS2` | physics.js | `1e-6` AU² | Force softening. Larger = gentler close encounters, less accurate. |
| `BASE_DT` | physics.js | `0.0005` yr | Maximum step. Smaller = more accurate, slower. |
| `0.015` in `chooseDt` | physics.js | | Step as a fraction of the tightest pair's dynamical time (~400 steps/orbit). |
| `2e-7` in `chooseDt` | physics.js | yr | Minimum step; prevents stalls at near-zero distance. |
| `collR` | physics.js | 0.02 / 0.0005 / 0.0002 AU | Collision radii for stars / giants / small bodies. |
| `MAX_STEPS` | engine.js | `4000` | Per-frame step budget. When hit, the simulation runs slower than requested instead of freezing. |
| `LAUNCH_K` | engine.js | `0.05` AU/yr per px | Launch speed sensitivity (~0.24 km/s per pixel). |
| `PANEL_MS` | engine.js | `120` ms | Snapshot rate to React. |
| `2000` in `removeEscapes` | engine.js | AU | Escape cutoff distance. |
| `3600` / `600` in `frame` | engine.js | numbers | Trail cap (1800 points) and trim size (300 points). |
| `sliderToSpeed` | engine.js | 0.02–20 yr/s | Speed slider range (logarithmic). |

---

## Performance and limitations

- **O(n²) forces.** Every step visits every pair. This is ideal for tens of bodies; hundreds would need a Barnes–Hut tree or similar.
- **Close encounters are expensive.** Adaptive steps shrink near a tight pair, so a planet grazing a star can consume the whole 4000-step budget. The simulation then visibly slows rather than losing accuracy or freezing.
- **Global time step.** All bodies share the smallest step. Per-body (block) time steps would be faster for systems with one tight pair and many distant bodies.
- **2D only.** All motion is in a plane.
- **Point masses.** No tides, radiation or relativity; collisions are perfectly inelastic merges.
- **Preview cost.** The launch preview re-simulates the whole system every frame during a drag (up to 1500 steps × n² pairs). It is bounded, but on very slow devices the frame rate may dip while aiming.
- **Sizes not to scale.** Drawn radii are for visibility; collision radii are separate and physical-ish.
