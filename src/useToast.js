import { useCallback, useEffect, useRef, useState } from 'react';

const SHOW_MS = 3200;
const FADE_MS = 400;

/**
 * State for a single transient notification that fades out on its own.
 *
 * Calling `show(msg)` displays the message immediately, sets `visible` to false after
 * SHOW_MS (the CSS opacity transition fades it), then clears `msg` FADE_MS later so the
 * element can be hidden. Showing a new message cancels the old timers, so the latest
 * message always gets its full display time. Pending timers are cleared on unmount.
 *
 * `show` keeps the same identity for the component's lifetime, so it is safe to hand to
 * non-React code such as the simulation engine.
 * @returns {[{msg: string, visible: boolean}, (msg: string) => void]}
 */
export function useToast() {
  const [state, setState] = useState({ msg: '', visible: false });
  const timers = useRef([]);

  const show = useCallback((msg) => {
    timers.current.forEach(clearTimeout);
    setState({ msg, visible: true });
    timers.current = [
      setTimeout(() => setState((s) => ({ ...s, visible: false })), SHOW_MS),
      setTimeout(() => setState({ msg: '', visible: false }), SHOW_MS + FADE_MS),
    ];
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return [state, show];
}
