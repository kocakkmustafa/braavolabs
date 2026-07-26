"use client";

import { useEffect, useRef } from "react";

/**
 * Hybrid requestAnimationFrame + setInterval animation engine.
 *
 * rAF alone is the right tool for anything scroll- or pointer-driven (it's
 * synced to the compositor and pauses automatically when there's nothing to
 * paint), but browsers throttle or fully suspend it in backgrounded /
 * unfocused tabs — sometimes down to ~1 callback/sec, sometimes to zero.
 * That's invisible for purely scroll-linked visuals (nothing needs to move
 * while the user isn't looking), but it would make time-based state — the
 * cold-open typewriter, the "live" tokens-saved counter, the tower-scene
 * scramble-text — look frozen or jump discontinuously the moment the tab
 * regains focus.
 *
 * This hook drives one callback from two clocks:
 *  - an rAF loop, for the normal ~60fps case;
 *  - a low-frequency `setInterval` watchdog that fires the SAME callback if
 *    the rAF loop hasn't ticked recently (i.e. the tab was backgrounded),
 *    so time-based effects keep making forward progress instead of stalling.
 *
 * The callback receives `dt` (ms since its last invocation, from whichever
 * clock fired) and `now` (a `performance.now()` timestamp) — callers do
 * their own elapsed-time bookkeeping against `now` so a late/coalesced tick
 * from the interval watchdog just resolves in one larger step rather than
 * skipping animation state entirely.
 */
export function useForgeTicker(
  callback: (dt: number, now: number) => void,
  intervalMs = 1000,
  /**
   * When false NOTHING is scheduled — no rAF loop, no watchdog. Reduced-motion
   * and narrow-viewport visitors must not have the main thread woken ~60x/s to
   * run a callback that immediately returns.
   */
  enabled = true,
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let rafId = 0;
    let last = performance.now();

    const rafLoop = (now: number) => {
      if (!alive) return;
      const dt = now - last;
      last = now;
      callbackRef.current(dt, now);
      rafId = requestAnimationFrame(rafLoop);
    };
    rafId = requestAnimationFrame(rafLoop);

    // Watchdog: if a full `intervalMs` has passed with no rAF tick landing
    // (background-tab throttling), drive one manually so the callback's
    // own dt-based math still advances.
    const watchdog = window.setInterval(() => {
      const now = performance.now();
      if (now - last >= intervalMs * 0.9) {
        const dt = now - last;
        last = now;
        callbackRef.current(dt, now);
      }
    }, intervalMs);

    return () => {
      alive = false;
      cancelAnimationFrame(rafId);
      window.clearInterval(watchdog);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled]);
}
