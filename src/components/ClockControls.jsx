import { fmtTime, sliderToSpeed, speedToSlider } from '../engine.js';

/**
 * The "Elapsed" section: simulated time, body count, energy error, the
 * Play/Pause, Restart and Clear trails buttons, and the speed slider.
 *
 * The slider is controlled: its position is derived from `snap.speed` on a log scale,
 * so when a scenario load changes the speed, the slider moves with it.
 * @param {object} props
 * @param {import('../engine.js').Simulation} props.sim
 * @param {import('../engine.js').Snapshot} props.snap
 */
export default function ClockControls({ sim, snap }) {
  const { simT, count, drift, running, speed } = snap;
  return (
    <section>
      <h2>Elapsed</h2>
      <div className="clock">
        <div className="t">{fmtTime(simT)}</div>
        <div className="meta">
          {count} bodies
          <br />
          <span title="How much the total energy has changed. Real physics conserves it, so this measures simulation error.">
            energy error {drift < 0.0001 ? '<0.0001' : drift.toFixed(4)}%
          </span>
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" onClick={() => sim.toggleRunning()}>{running ? 'Pause' : 'Play'}</button>
        <button onClick={() => sim.restart()}>Restart</button>
        <button onClick={() => sim.clearTrails()}>Clear trails</button>
      </div>
      <div className="speed">
        <label htmlFor="speed">
          Simulation speed <output>{speed < 1 ? speed.toFixed(2) : speed.toFixed(1)} yr/s</output>
        </label>
        <input
          type="range"
          id="speed"
          min="0"
          max="100"
          step="0.5"
          value={speedToSlider(speed)}
          onChange={(e) => sim.setSpeed(sliderToSpeed(+e.target.value))}
        />
      </div>
    </section>
  );
}
