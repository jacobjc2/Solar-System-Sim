/**
 * The "View" section: what the camera stays centered on (center of mass, heaviest body
 * or selected body), and toggles for trails and name labels. Every control is
 * controlled from the snapshot, so changes the engine makes itself (such as dropping out
 * of "Selected body" when a scenario reloads) show up here.
 * @param {object} props
 * @param {import('../engine.js').Simulation} props.sim
 * @param {import('../engine.js').Snapshot} props.snap
 */
export default function ViewOptions({ sim, snap }) {
  return (
    <section className="view">
      <h2 style={{ margin: 0 }}>View</h2>
      <label htmlFor="follow" style={{ fontSize: 13, color: 'var(--muted)' }}>Keep centered on</label>
      <select id="follow" value={snap.followMode} onChange={(e) => sim.setFollowMode(e.target.value)}>
        <option value="com">Center of mass</option>
        <option value="star">Heaviest body</option>
        <option value="selected">Selected body</option>
      </select>
      <label className="check">
        <input type="checkbox" checked={snap.showTrails} onChange={(e) => sim.setShowTrails(e.target.checked)} /> Show
        trails
      </label>
      <label className="check">
        <input type="checkbox" checked={snap.showLabels} onChange={(e) => sim.setShowLabels(e.target.checked)} /> Show
        names
      </label>
    </section>
  );
}
