import { MASSES } from '../scenarios.js';

/**
 * Segmented radio group for choosing what the next drag launches (rocky, giant or red
 * dwarf), plus instructions. The radio inputs are visually hidden; the styled <span> after
 * each one shows the selection through the `input:checked + span` CSS rule.
 * @param {object} props
 * @param {import('../engine.js').Simulation} props.sim
 * @param {string} props.massKind Key into MASSES for the current choice.
 */
export default function LaunchPicker({ sim, massKind }) {
  return (
    <section>
      <h2>Launch</h2>
      <div className="seg" role="radiogroup" aria-label="Mass of launched body">
        {Object.entries(MASSES).map(([key, m]) => (
          <label key={key}>
            <input
              type="radio"
              name="mass"
              value={key}
              checked={massKind === key}
              onChange={() => sim.setMassKind(key)}
            />
            <span>
              {m.label}
              <small>{m.sub}</small>
            </span>
          </label>
        ))}
      </div>
      <p className="note">
        Press on the sky and drag in the direction you want it to go. A longer drag means a faster launch. The dashed
        line predicts its path.
      </p>
    </section>
  );
}
