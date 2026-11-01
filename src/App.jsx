import { useEffect, useState, useSyncExternalStore } from 'react';
import { Simulation } from './engine.js';
import { useToast } from './useToast.js';
import Sky from './components/Sky.jsx';
import ClockControls from './components/ClockControls.jsx';
import ScenarioPicker from './components/ScenarioPicker.jsx';
import LaunchPicker from './components/LaunchPicker.jsx';
import SelectedBody from './components/SelectedBody.jsx';
import ViewOptions from './components/ViewOptions.jsx';
import ThingsToTry from './components/ThingsToTry.jsx';

/**
 * Root component: the sky canvas on the left and the instrument panel on the right.
 *
 * Creates one {@link Simulation} for the app's lifetime (lazy useState, so it isn't
 * rebuilt on re-render) and subscribes to its snapshots with useSyncExternalStore.
 * Panel components get the snapshot to display and the `sim` instance to act on.
 * Also installs global keyboard shortcuts: Space toggles play/pause, + / = zooms in,
 * - zooms out. Shortcuts are ignored while a form control has focus, so Space still
 * presses buttons and arrow keys still move sliders.
 */
export default function App() {
  const [toast, showToast] = useToast();
  const [sim] = useState(() => new Simulation({ onToast: showToast }));
  const snap = useSyncExternalStore(sim.subscribe, sim.getSnapshot);

  // Keyboard: space toggles play, +/- zoom (ignored while a control has focus).
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, select, textarea, button')) return;
      if (e.code === 'Space') { e.preventDefault(); sim.toggleRunning(); }
      if (e.key === '+' || e.key === '=') sim.zoomBy(1.25);
      if (e.key === '-') sim.zoomBy(1 / 1.25);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sim]);

  return (
    <div className="app">
      <Sky sim={sim} toast={toast} />

      <aside className="panel">
        <header>
          <h1>Orbit <em>Lab</em></h1>
          <p className="lede">
            Every body pulls on every other body with Newton's law of gravity. Nothing here is scripted: the orbits come
            out of the math.
          </p>
        </header>

        <ClockControls sim={sim} snap={snap} />
        <ScenarioPicker sim={sim} current={snap.scenario} />
        <LaunchPicker sim={sim} massKind={snap.massKind} />
        <SelectedBody sim={sim} info={snap.selected} />
        <ViewOptions sim={sim} snap={snap} />
        <ThingsToTry />

        <p className="foot">
          Units: 1 AU = Earth–Sun distance. Planets start on circular orbits at their real distances. Sizes are not to
          scale. Integrator: leapfrog with adaptive time steps.
        </p>
      </aside>
    </div>
  );
}
