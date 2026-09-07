"use client";

import { useEffect, useRef, useState } from "react";
import {
  createGesturePlayer, heldFrame, subscribeMotionEnvironment,
  type MotionState,
} from "../lib/brandMotion";
import styles from "./BrandMotion.module.css";

/** Decorative brand feedback. Keep the actual translated status next to it;
 * no live region, inferred capability, or control action belongs here. */
export default function BrandMotion({ state, size = 48, reducedMotion = false, active = true }: {
  state: MotionState;
  size?: number;
  reducedMotion?: boolean;
  active?: boolean;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const player = useRef<ReturnType<typeof createGesturePlayer<number>> | null>(null);
  const [environment, setEnvironment] = useState<boolean | null>(null);
  const [pose, setPose] = useState({ state, frame: heldFrame(state) });

  useEffect(() => {
    const node = root.current;
    if (!node || !window.matchMedia || !window.IntersectionObserver) {
      setEnvironment(false);
      return;
    }
    return subscribeMotionEnvironment({
      media: window.matchMedia("(prefers-reduced-motion: no-preference)"),
      page: document,
      observe(onVisible) {
        const observer = new IntersectionObserver(([entry]) => onVisible(entry.isIntersecting), { threshold: 0 });
        observer.observe(node);
        return () => observer.disconnect();
      },
    }, setEnvironment);
  }, []);

  useEffect(() => {
    const instance = createGesturePlayer((frame, currentState) => setPose({ state: currentState, frame }), {
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: (handle: number) => window.clearTimeout(handle),
    });
    player.current = instance;
    return () => { instance.dispose(); player.current = null; };
  }, []);

  const animate = environment === true && !reducedMotion && active;
  useEffect(() => {
    if (environment !== null) player.current?.update(state, animate);
  }, [state, animate, environment]);

  const frame = pose.state === state && animate ? pose.frame : heldFrame(state);
  return (
    <span ref={root} className={styles.root} aria-hidden="true" data-state={state} data-animate={animate}>
      <span
        className={styles.sprite}
        style={{ width: size, height: size, backgroundPosition: `${(frame % 4) * 100 / 3}% ${Math.floor(frame / 4) * 50}%` }}
      />
      {state === "thinking" && <span className={styles.coin} />}
    </span>
  );
}
