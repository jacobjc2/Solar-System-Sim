/**
 * The "Selected" section: a card with the selected body's name, color, orbital readout
 * and actions (Center on it, Remove), or a prompt when nothing is selected.
 * All numbers are computed by the engine (Simulation#selectedInfo); this only lays them out.
 * @param {object} props
 * @param {import('../engine.js').Simulation} props.sim
 * @param {import('../engine.js').SelectedInfo|null} props.info
 */
export default function SelectedBody({ sim, info }) {
  return (
    <section>
      <h2>Selected</h2>
      {!info ? (
        <p className="empty">Tap any body to see its speed, distance and orbit.</p>
      ) : (
        <div className="card">
          <div className="name">
            <span className="dot" style={{ background: info.color }} />
            {info.name}
          </div>
          <dl>
            {info.rows.map((r) => (
              <Row key={r.label} {...r} />
            ))}
          </dl>
          {info.note && <p>{info.note}</p>}
          <div className="actions row">
            <button onClick={() => sim.followSelected()}>Center on it</button>
            <button onClick={() => sim.removeSelected()}>Remove</button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * One term/value pair in the card's definition list. When `tone` is set, the value is
 * wrapped in a span with that class ('ok' = green, 'bad' = orange).
 * @param {import('../engine.js').InfoRow} props
 */
function Row({ label, value, tone }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{tone ? <span className={tone}>{value}</span> : value}</dd>
    </>
  );
}
