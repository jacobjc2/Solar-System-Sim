/**
 * Static list of suggested experiments. It has no props or state, so it renders the same
 * every time.
 */
export default function ThingsToTry() {
  return (
    <section>
      <h2>Things to try</h2>
      <ol className="try">
        <li>In <b>Empty Sun</b>, launch a rocky planet sideways at about 30 km/s, roughly 1 AU from the Sun. That's Earth's orbit.</li>
        <li>Launch faster than the escape speed shown while you drag. The planet leaves and never comes back.</li>
        <li>Drop a <b>Giant</b> near Earth in <b>Solar System</b> and watch the inner planets get pushed around.</li>
        <li>In <b>Binary Star</b>, keep an eye on the inner world. Orbits too close to a pair of suns don't last.</li>
        <li>Tap the <b>Sun</b>. The planets tug it around at a few meters per second. Astronomers use that wobble to find exoplanets.</li>
      </ol>
    </section>
  );
}
