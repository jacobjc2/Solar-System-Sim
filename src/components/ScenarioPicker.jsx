import { SCENARIOS } from '../scenarios.js';

/**
 * One button per preset scenario. Clicking a button loads that scenario. The active one
 * is marked with aria-pressed, which also drives its highlighted style.
 * @param {object} props
 * @param {import('../engine.js').Simulation} props.sim
 * @param {string} props.current Key of the loaded scenario.
 */
export default function ScenarioPicker({ sim, current }) {
  return (
    <section>
      <h2>Scenario</h2>
      <div className="scenarios">
        {Object.entries(SCENARIOS).map(([key, s]) => (
          <button key={key} aria-pressed={key === current} onClick={() => sim.load(key)}>
            <b>{s.label}</b>
            <span>{s.blurb}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
