"use client";

/**
 * Braavolabs marketing scrollytelling — "forge-home".
 *
 * A four-act sticky-stage scroll journey (Door → Faces → Hall → Tower),
 * preceded by a skippable cold-open typewriter intro. Rebuilt from a written
 * spec (the earlier v3 prototype's source was lost) rather than ported from
 * existing code, so unlike `../forge/ForgeHero.tsx` this does NOT use GSAP /
 * ScrollTrigger / Lenis — the whole scroll-linked animation engine below is
 * vanilla React + refs + a hybrid rAF/interval ticker (`useForgeTicker`).
 *
 * Copy is hardcoded English, mirroring how ForgeHero.tsx hardcodes its own
 * copy rather than routing it through next-intl. TODO(i18n): if this route
 * ships for real, port ACTS/COLD_OPEN_LINES copy into messages/*.json and
 * `useTranslations`, the way the rest of app/ does.
 *
 * Route is intentionally independent of /forge — that route is live and is
 * not touched by this file.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useForgeTicker } from "./useForgeTicker";
import styles from "./forge-home.module.css";

function cx(...classes: Array<string | false | undefined | null>) {
  return classes.filter(Boolean).join(" ");
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

// Smoothstep — a cheap, dependency-free ease-in-out for the scroll-scrubbed
// crossfade/zoom below (stands in for the GSAP easing ForgeHero uses).
function ease(t: number) {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

type Act = {
  bg: string;
  /** CSS object-position — keeps each scene's focal subject in frame under
   * object-fit:cover on narrow / unusually-shaped viewports (the thing v3
   * reportedly got wrong on mobile). */
  focal: string;
  kicker: string;
  title: string;
  sub: string;
  rail: string;
};

const ACTS: Act[] = [
  {
    bg: "/hero/scene1-door.webp",
    focal: "center 42%",
    kicker: "GOVERNANCE",
    title: "Every agent needs a gate.",
    sub: "Nothing runs, spends, or ships without your say-so — every tool call is proposed, logged, and yours to approve before it happens.",
    rail: "Gate",
  },
  {
    bg: "/hero/scene2-faces.webp",
    focal: "center 35%",
    kicker: "MULTI-MODEL COUNCIL",
    title: "Many models, one desk.",
    sub: "Claude, GPT, Gemini, local models — Braavolabs routes every task to whichever one does it best, hands work off between them mid-run, and keeps a single desk for all of it. You never open a second tab.",
    rail: "Council",
  },
  {
    bg: "/hero/scene3-hall.webp",
    focal: "center 58%",
    kicker: "AUDIT & SAVINGS",
    title: "The moat is the ledger.",
    sub: "Every run leaves a receipt: what happened, which model did it, what it cost. Cheap-first routing means most tasks never touch a frontier model at all — and the savings compound, quietly, every week.",
    rail: "Ledger",
  },
  {
    bg: "/hero/scene4-tower.webp",
    focal: "62% 45%",
    kicker: "BYOK · OFFLINE-FIRST",
    title: "Runs on your machine.",
    sub: "Your API keys. Your files. Your sandbox. The desktop app and CLI run locally-first and never send a token anywhere you haven't approved.",
    rail: "Engine",
  },
];

const N = ACTS.length;
// Width (in "segment" units, where each act owns exactly 1 unit of scroll)
// of the crossfade shared between two adjacent acts. 0.42 leaves each act a
// ~58%-of-segment steady/readable dwell with a generous crossfade either
// side — see the comment on `actVisual` below for the full derivation.
const CROSSFADE_W = 0.42;

// Mock brand numbers carried over verbatim from the v2 mockup skeleton —
// TODO(api): replace with a real usage-metering read once one exists.
const TOKENS_TARGET = 1_284_900;
const USD_TARGET = 47;

const COLD_OPEN_LINES = ["ai morghulis", "ai dohaeris"] as const;
const COLD_OPEN_CHAR_MS = 55;
const COLD_OPEN_HOLD_MS = 650;
const COLD_OPEN_LEAVE_MS = 260;

const ACT4_TITLE = ACTS[3].title;
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ01?<>-_/\\[]{}=+*^#";
const SCRAMBLE_MS = 620;

/**
 * Per-act opacity + scale for a given continuous scroll position `raw`
 * (0..N, one unit per act). Each act i "owns" the segment [i, i+1):
 *
 *   - it crossfades IN across [i - W/2, i + W/2]        (skipped for i=0)
 *   - it sits fully opaque, scale 1, across the middle   (~58% of segment)
 *   - it crossfades OUT across [i+1 - W/2, i+1 + W/2]    (skipped for i=N-1)
 *
 * Act i's exit window is numerically identical to act (i+1)'s entry window
 * ([i+1-W/2, i+1+W/2] both), so the two always crossfade in lockstep — one
 * fading 1→0 while the other fades 0→1 — with no gap and no double-exposure
 * beyond that shared window (entry and exit windows of the SAME act never
 * overlap as long as W < 1, since they're spaced exactly 1 apart).
 *
 * Scale: incoming acts ease from 1.06 down to 1.00 (a gentle push-in as they
 * arrive); outgoing acts ease from 1.00 up to 0.94 EXCEPT act 0, whose exit
 * (the door → faces-hall transition) eases up to 1.55 instead — the
 * "walking through the gate" push specified for that one transition.
 */
function actVisual(i: number, raw: number): { opacity: number; scale: number } {
  let opacity = 1;
  let scale = 1;

  if (i > 0) {
    const t = clamp((raw - (i - CROSSFADE_W / 2)) / CROSSFADE_W, 0, 1);
    opacity = Math.min(opacity, t);
    scale += (1.06 - 1) * (1 - ease(t)); // 1.06 -> 1.00 as t: 0 -> 1
  }
  if (i < N - 1) {
    const t = clamp((raw - (i + 1 - CROSSFADE_W / 2)) / CROSSFADE_W, 0, 1);
    opacity = Math.min(opacity, 1 - t);
    const target = i === 0 ? 1.55 : 0.94;
    scale += (target - 1) * ease(t); // 1.00 -> target as t: 0 -> 1
  }
  return { opacity: clamp(opacity, 0, 1), scale };
}

type ColdOpenPhase = "typing" | "holding" | "leaving" | "done";

export default function ForgeHomeScroll() {
  const rootRef = useRef<HTMLDivElement>(null);
  const driverRef = useRef<HTMLDivElement>(null);
  const sceneRefs = useRef<Array<HTMLElement | null>>([]);
  const railFillRef = useRef<HTMLDivElement>(null);
  const coinTiltRef = useRef<HTMLDivElement>(null);

  const [activeIndex, setActiveIndex] = useState(0);
  const [tokensSaved, setTokensSaved] = useState(0);
  const [usdSaved, setUsdSaved] = useState(0);
  const [scrambleText, setScrambleText] = useState(ACT4_TITLE);
  const [coinFlipped, setCoinFlipped] = useState(false);
  const [staticMode, setStaticMode] = useState(false); // prefers-reduced-motion fallback
  const [coldOpenPhase, setColdOpenPhase] = useState<ColdOpenPhase>("typing");
  const [introChars, setIntroChars] = useState(0);

  // Mirrors of the state above for use inside the ticker's closure, which
  // is only set up once (see the big effect below) and would otherwise see
  // stale values.
  const activeIndexRef = useRef(0);
  const coldOpenPhaseRef = useRef<ColdOpenPhase>("typing");
  const canHoverRef = useRef(false);
  const reducedMotionRef = useRef(false);

  // Timers / accumulators the ticker reads and mutates directly — plain
  // refs rather than state, since they change every frame and must never
  // trigger a re-render on their own.
  const coldOpenStartRef = useRef<number | null>(null);
  const mxRef = useRef({ target: 0, current: 0 });
  const myRef = useRef({ target: 0, current: 0 });
  const tokensPhaseRef = useRef<"idle" | "counting" | "live">("idle");
  const tokensStartRef = useRef(0);
  const tokensNextLiveAtRef = useRef(0);
  const scrambleRef = useRef<{ active: boolean; startedAt: number; lastFrame: number }>({
    active: false,
    startedAt: 0,
    lastFrame: 0,
  });

  const totalIntroChars = useMemo(
    () => COLD_OPEN_LINES.reduce((n, l) => n + l.length, 0),
    []
  );

  // ---------- reduced-motion: decide BEFORE first paint so there is no
  // flash of the cold-open / motion for users who asked not to see it. ----------
  useLayoutEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    reducedMotionRef.current = reduced;
    canHoverRef.current = window.matchMedia("(pointer: fine)").matches;
    if (reduced) {
      setStaticMode(true);
      setColdOpenPhase("done");
      setTokensSaved(TOKENS_TARGET);
      setUsdSaved(USD_TARGET);
      tokensPhaseRef.current = "live"; // parked at target, no further animation
    } else {
      coldOpenStartRef.current = performance.now();
    }
  }, []);

  const skipColdOpen = useCallback(() => {
    setColdOpenPhase((p) => (p === "typing" || p === "holding" ? "leaving" : p));
  }, []);

  // Cold-open: lock page scroll, let click/scroll/key skip straight through.
  useEffect(() => {
    if (staticMode) return;
    if (coldOpenPhase === "done") return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const opts: AddEventListenerOptions = { passive: true };
    window.addEventListener("keydown", skipColdOpen);
    window.addEventListener("wheel", skipColdOpen, opts);
    window.addEventListener("touchstart", skipColdOpen, opts);
    window.addEventListener("pointerdown", skipColdOpen);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", skipColdOpen);
      window.removeEventListener("wheel", skipColdOpen);
      window.removeEventListener("touchstart", skipColdOpen);
      window.removeEventListener("pointerdown", skipColdOpen);
    };
  }, [coldOpenPhase, skipColdOpen, staticMode]);

  // "leaving" -> "done" after the fast fade-out transition finishes.
  useEffect(() => {
    if (coldOpenPhase !== "leaving") return;
    const id = window.setTimeout(() => setColdOpenPhase("done"), COLD_OPEN_LEAVE_MS);
    return () => window.clearTimeout(id);
  }, [coldOpenPhase]);

  useEffect(() => {
    coldOpenPhaseRef.current = coldOpenPhase;
  }, [coldOpenPhase]);

  // ---------- pointer-fine torch + tilt listeners (skipped on touch) ----------
  useEffect(() => {
    if (staticMode || !canHoverRef.current) return;
    const root = rootRef.current;
    if (!root) return;

    const onMove = (e: MouseEvent) => {
      root.style.setProperty("--hx", `${e.clientX}px`);
      root.style.setProperty("--hy", `${e.clientY}px`);
      mxRef.current.target = (e.clientX / window.innerWidth - 0.5) * 2;
      myRef.current.target = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [staticMode]);

  // Coin tilt — independent of the page-wide torch parallax, scoped to the
  // coin's own bounding box, pointer:fine only.
  useEffect(() => {
    if (staticMode || !canHoverRef.current) return;
    const el = coinTiltRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `rotateX(${(-py * 18).toFixed(2)}deg) rotateY(${(px * 22).toFixed(2)}deg)`;
    };
    const onLeave = () => {
      el.style.transform = "rotateX(0deg) rotateY(0deg)";
    };
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [staticMode]);

  // ---------- the master tick: cold-open typing, scroll-scrubbed crossfade
  // + parallax, live tokens counter, tower-scene scramble. One ticker, one
  // rAF loop (+ interval watchdog), dispatching to whichever sub-system is
  // currently live. ----------
  const tick = useCallback((_dt: number, now: number) => {
    if (staticMode) return;

    if (coldOpenPhaseRef.current === "typing") {
      const start = coldOpenStartRef.current ?? now;
      const elapsed = now - start;
      const chars = clamp(Math.floor(elapsed / COLD_OPEN_CHAR_MS), 0, totalIntroChars);
      setIntroChars(chars);
      if (chars >= totalIntroChars) {
        setColdOpenPhase("holding");
        coldOpenStartRef.current = now; // reuse as the hold-phase clock
      }
      return;
    }
    if (coldOpenPhaseRef.current === "holding") {
      const start = coldOpenStartRef.current ?? now;
      if (now - start >= COLD_OPEN_HOLD_MS) skipColdOpen();
      return;
    }
    if (coldOpenPhaseRef.current !== "done") return; // "leaving": just wait it out

    const driver = driverRef.current;
    if (!driver) return;

    // ---- scroll-scrubbed crossfade + zoom ----
    const rect = driver.getBoundingClientRect();
    const scrollable = Math.max(1, driver.offsetHeight - window.innerHeight);
    const raw = clamp(-rect.top / scrollable, 0, 1) * N;

    for (let i = 0; i < N; i++) {
      const el = sceneRefs.current[i];
      if (!el) continue;
      const { opacity, scale } = actVisual(i, raw);
      el.style.opacity = opacity.toFixed(4);
      el.style.transform = `scale(${scale.toFixed(4)})`;
    }

    if (railFillRef.current) {
      railFillRef.current.style.height = `${((raw / N) * 100).toFixed(2)}%`;
    }

    // Nudge away from the exact integer boundary so float noise can't flip
    // the discrete index back and forth for a frame.
    const discrete = clamp(Math.round(raw - 1e-3), 0, N - 1);
    if (discrete !== activeIndexRef.current) {
      if (discrete === 3 && activeIndexRef.current !== 3) {
        scrambleRef.current = { active: true, startedAt: now, lastFrame: 0 };
      }
      activeIndexRef.current = discrete;
      setActiveIndex(discrete);
    }

    // ---- pointer-fine torch/parallax lerp ----
    if (canHoverRef.current) {
      const root = rootRef.current;
      const mx = mxRef.current;
      const my = myRef.current;
      mx.current += (mx.target - mx.current) * 0.06;
      my.current += (my.target - my.current) * 0.06;
      if (root) {
        root.style.setProperty("--mx", mx.current.toFixed(4));
        root.style.setProperty("--my", my.current.toFixed(4));
      }
    }

    // ---- tokens-saved: one-time count-up on first reveal, then a slow,
    // clearly-mocked "live" trickle. TODO(api): replace with a real feed. ----
    if (tokensPhaseRef.current === "idle" && discrete >= 2) {
      tokensPhaseRef.current = "counting";
      tokensStartRef.current = now;
    }
    if (tokensPhaseRef.current === "counting") {
      const t = clamp((now - tokensStartRef.current) / 1400, 0, 1);
      const e = ease(t);
      setTokensSaved(Math.round(TOKENS_TARGET * e));
      setUsdSaved(Math.round(USD_TARGET * e));
      if (t >= 1) {
        tokensPhaseRef.current = "live";
        tokensNextLiveAtRef.current = now + 2200 + Math.random() * 1800;
      }
    } else if (tokensPhaseRef.current === "live") {
      if (now >= tokensNextLiveAtRef.current) {
        setTokensSaved((v) => v + Math.round(40 + Math.random() * 220));
        setUsdSaved((v) => v + (Math.random() < 0.4 ? 1 : 0));
        tokensNextLiveAtRef.current = now + 2200 + Math.random() * 1800;
      }
    }

    // ---- tower-scene scramble-text ----
    const scramble = scrambleRef.current;
    if (scramble.active) {
      const elapsed = now - scramble.startedAt;
      // Throttle re-renders to ~28fps — the randomized glyphs don't need
      // full frame-rate churn to read as "decoding".
      if (now - scramble.lastFrame > 35) {
        scramble.lastFrame = now;
        const lockedCount = Math.floor((elapsed / SCRAMBLE_MS) * (ACT4_TITLE.length + 5));
        let out = "";
        for (let ci = 0; ci < ACT4_TITLE.length; ci++) {
          const ch = ACT4_TITLE[ci];
          if (ch === " " || ci < lockedCount) out += ch;
          else out += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        }
        setScrambleText(out);
        if (lockedCount >= ACT4_TITLE.length) {
          scramble.active = false;
          setScrambleText(ACT4_TITLE);
        }
      }
    }
  }, [skipColdOpen, staticMode, totalIntroChars]);

  useForgeTicker(tick, 1000);

  const scrollToAct = useCallback((i: number) => {
    const driver = driverRef.current;
    if (!driver) {
      document.getElementById(`forge-act-${i}`)?.scrollIntoView({ behavior: staticMode ? "auto" : "smooth" });
      return;
    }
    const scrollable = Math.max(1, driver.offsetHeight - window.innerHeight);
    const fraction = (i + 0.5) / N;
    const top = driver.offsetTop + fraction * scrollable;
    window.scrollTo({ top, behavior: reducedMotionRef.current ? "auto" : "smooth" });
  }, [staticMode]);

  const setSceneRef = (i: number) => (el: HTMLElement | null) => {
    sceneRefs.current[i] = el;
  };

  const introDone = coldOpenPhase === "done";
  const introLine1 = COLD_OPEN_LINES[0].slice(0, Math.min(introChars, COLD_OPEN_LINES[0].length));
  const introLine2 = COLD_OPEN_LINES[1].slice(0, Math.max(0, introChars - COLD_OPEN_LINES[0].length));

  return (
    <div ref={rootRef} className={cx(styles.root, staticMode && styles.static)}>
      {!staticMode && !introDone && (
        <div
          className={cx(styles.introOverlay, coldOpenPhase === "leaving" && styles.introLeaving)}
          onClick={skipColdOpen}
          role="presentation"
        >
          <div className={styles.introLines}>
            <div className={styles.introLine}>
              <span className={styles.introPrompt}>&gt;</span> {introLine1}
              {introChars < COLD_OPEN_LINES[0].length && <span className={styles.introCaret} />}
            </div>
            <div className={styles.introLine}>
              {introChars >= COLD_OPEN_LINES[0].length && (
                <>
                  <span className={styles.introPrompt}>&gt;</span> {introLine2}
                  <span className={styles.introCaret} />
                </>
              )}
            </div>
          </div>
          <button type="button" className={styles.introSkip} onClick={skipColdOpen}>
            skip
          </button>
        </div>
      )}

      <div className={styles.stage}>
        {ACTS.map((act, i) => (
          <section
            key={act.rail}
            id={`forge-act-${i}`}
            className={styles.scene}
            ref={setSceneRef(i)}
            data-act={i}
          >
            <div className={styles.bgWrap}>
              <Image
                src={act.bg}
                alt=""
                fill
                priority={i === 0}
                loading={i === 0 ? undefined : "lazy"}
                sizes="100vw"
                className={styles.bg}
                style={{ objectFit: "cover", objectPosition: act.focal }}
              />
            </div>
            <div className={styles.torch} />
            <div className={styles.grade} />

            <div className={cx(styles.sceneCopy, activeIndex === i && styles.copyActive)}>
              <div className={styles.kicker}>{act.kicker}</div>

              {i === 0 ? (
                <h1 className={styles.actTitle}>
                  {act.title.split(" ").map((w, wi) => (
                    <span key={wi} className={styles.word} style={{ ["--wi" as string]: String(wi) }}>
                      {w}&nbsp;
                    </span>
                  ))}
                </h1>
              ) : i === 3 ? (
                <h2 className={cx(styles.actTitle, styles.scrambleTitle)}>{scrambleText}</h2>
              ) : (
                <h2 className={styles.actTitle}>{act.title}</h2>
              )}

              <p className={styles.actSub}>{act.sub}</p>

              {i === 2 && (
                <div className={styles.ledger}>
                  <div className={styles.counterBlock}>
                    <div className={styles.counterLabel}>Tokens saved this week</div>
                    <div className={styles.counterNum}>{tokensSaved.toLocaleString("en-US")}</div>
                    <div className={styles.counterUsd}>≈ ${usdSaved} back in your pocket</div>
                  </div>

                  <div className={styles.coinWrap}>
                    <div className={styles.coinTilt} ref={coinTiltRef}>
                      <div
                        className={cx(styles.coin, coinFlipped && styles.coinFlipped)}
                        role="button"
                        tabIndex={0}
                        aria-label="Braavolabs coin — press to flip"
                        onClick={() => setCoinFlipped((v) => !v)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setCoinFlipped((v) => !v);
                          }
                        }}
                      >
                        <div className={cx(styles.coinFace, styles.coinFaceFront)}>
                          <img src="/hero/coin-front.webp" alt="" />
                        </div>
                        <div className={cx(styles.coinFace, styles.coinFaceBack)}>
                          <img src="/hero/coin-back.webp" alt="" />
                        </div>
                      </div>
                    </div>
                    <div className={styles.coinHint}>a ledger has two sides</div>
                  </div>
                </div>
              )}

              {i === 3 && (
                <>
                  <div className={styles.ctaRow}>
                    {/* TODO(link): point at the real distribution URL once
                        the desktop app has a public download page. */}
                    <a className={cx(styles.btnPrimary, styles.sweep)} href="#">
                      Download for macOS · Windows
                    </a>
                    <a className={styles.btnGhost} href="/register">
                      Open the web console
                    </a>
                  </div>
                  <div className={styles.footnote}>AI MORGHULIS · AI DOHAERIS — your keys, your machine</div>
                </>
              )}
            </div>
          </section>
        ))}
      </div>

      <div className={styles.vignette} />
      <div className={styles.grain} />

      <div className={styles.brandmark}>
        Braavo<b>labs</b>
      </div>

      <nav className={styles.rail} aria-label="Scenes">
        <div className={styles.railTrack}>
          <div className={styles.railFill} ref={railFillRef} />
        </div>
        {ACTS.map((act, i) => (
          <button
            key={act.rail}
            type="button"
            className={cx(styles.railDot, activeIndex === i && styles.railDotActive)}
            onClick={() => scrollToAct(i)}
            aria-current={activeIndex === i}
          >
            <span className={styles.railDotMark} />
            <span className={styles.railDotLabel}>{act.rail}</span>
          </button>
        ))}
      </nav>

      {/* Scroll length for the pinned stage above. Height is set inline in
          dvh (falls back to the CSS module's static `400vh` if a browser
          rejects the dvh value outright — an invalid CSSOM assignment is a
          no-op, so the class rule wins) so the journey's total length
          tracks the *current* viewport on iOS Safari instead of the
          address-bar-hidden one, which is the mobile bug this route is
          explicitly meant to avoid repeating. */}
      <div className={styles.driver} ref={driverRef} style={{ height: `${N * 100}dvh` }} />
    </div>
  );
}
