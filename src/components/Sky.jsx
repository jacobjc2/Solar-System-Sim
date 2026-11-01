import { useEffect, useRef } from 'react';

/**
 * The simulation viewport: the canvas, zoom buttons, toast and usage hint.
 *
 * React only creates the <canvas> element. On mount, the engine takes it over through
 * `sim.attach`, which runs the render loop and handles resizing and pointer input.
 * `attach` returns its own cleanup, which becomes the effect's cleanup on unmount.
 * @param {object} props
 * @param {import('../engine.js').Simulation} props.sim
 * @param {{msg: string, visible: boolean}} props.toast Current toast state from useToast.
 *   The element is hidden when there's no message, and `visible` drives the fade.
 */
export default function Sky({ sim, toast }) {
  const canvasRef = useRef(null);

  useEffect(() => sim.attach(canvasRef.current), [sim]);

  return (
    <div className="stage">
      <canvas
        ref={canvasRef}
        className="sky"
        aria-label="Gravity simulation. Drag to launch a body, tap a body to inspect it."
      />
      <div className="zoom">
        <button title="Zoom in" aria-label="Zoom in" onClick={() => sim.zoomBy(1.4)}>+</button>
        <button title="Zoom out" aria-label="Zoom out" onClick={() => sim.zoomBy(1 / 1.4)}>−</button>
        <button className="fit" title="Fit all bodies" aria-label="Fit all bodies" onClick={() => sim.zoomFit()}>
          FIT
        </button>
      </div>
      <div className="toast" role="status" hidden={!toast.msg} style={{ opacity: toast.visible ? 1 : 0 }}>
        {toast.msg}
      </div>
      <div className="hint">Drag on the sky to launch a body · Tap a body for details · Scroll or pinch to zoom</div>
    </div>
  );
}
