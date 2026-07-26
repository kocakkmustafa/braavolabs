"use client";

/**
 * Braavolabs marketing scrollytelling — "forge-home", v2.
 *
 * Three sticky acts (Door → Hall → Tower) preceded by a skippable cold-open
 * typewriter. Ported from the approved Claude Design comp ("Forge Home"),
 * which replaced the earlier four-act draft: fewer, longer acts, each backed
 * by one of the founder-approved scene renders and — where the file exists —
 * a scroll-scrubbed video of the journey between them.
 *
 * Engine: vanilla React + refs + the hybrid rAF/interval ticker
 * (`useForgeTicker`). No GSAP / ScrollTrigger / Lenis — `../forge/ForgeHero.tsx`
 * (live route) keeps those; this route stays dependency-free.
 *
 * Video is progressive enhancement. `public/hero/video/*.mp4` may be absent
 * (they're large, founder-generated, and land out-of-band); every act falls
 * back to its still + a CSS zoom/beam treatment, so the page is complete
 * without them. See `scrubbable()`.
 *
 * Copy is hardcoded English, mirroring ForgeHero.tsx.
 * TODO(i18n): port ACT copy into messages/*.json + `useTranslations` if this
 * route ships for real.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useForgeTicker } from "./useForgeTicker";
import styles from "./forge-home.module.css";

const SCENES = {
  door: "/hero/scene1-door.webp",
  faces: "/hero/scene2-faces.webp",
  hall: "/hero/scene3-hall.webp",
  tower: "/hero/scene4-tower.webp",
} as const;

/** Optional, founder-generated. Absent files degrade to the still above. */
const INSTALL_CMD = "curl -fsSL braavolabs.com/install | sh";

const VIDEOS = {
  door: "/hero/video/v1-door-open.mp4",
  hall: "/hero/video/v2-hall.mp4",
  tower: "/hero/video/v3-tower-loop.mp4",
} as const;

const COLD_OPEN = ["ai morghulis", "ai dohaeris"] as const;
/** Comp: `transition: opacity .8s ease`, then `display:none` at 850ms. */
const FADE_OUT_MS = 850;
const CHAR_MS = 80;
const LINE_GAP_MS = 600;
const HOLD_MS = 1000;

const RAIL = ["Gate", "Hall", "Tower"] as const;
const N = RAIL.length;

/** Shared crossfade width, in segment units (1 segment = 1 act of scroll). */
const W = 0.26;

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Smoothstep — dependency-free ease-in-out for the scrubbed crossfades. */
function ease(t: number) {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

/**
 * A <video> can only be scrubbed once it has a known duration AND a seekable
 * range — otherwise `currentTime =` either throws or silently no-ops, and we
 * must keep showing the still instead.
 */
function scrubbable(v: HTMLVideoElement | null): v is HTMLVideoElement {
  return !!(v && v.duration > 0 && v.seekable.length > 0 && v.seekable.end(0) > 0);
}

export default function ForgeHomeScroll() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const actRefs = useRef<Array<HTMLDivElement | null>>([]);
  const bgRefs = useRef<Array<HTMLDivElement | null>>([]);
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([]);
  const beamRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const torchRef = useRef<HTMLDivElement>(null);
  const dotRefs = useRef<Array<HTMLElement | null>>([]);
  const copyARef = useRef<HTMLDivElement>(null);
  const copyBRef = useRef<HTMLDivElement>(null);
  const moatsRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const magnetRefs = useRef<Array<HTMLElement | null>>([]);

  // Torch: target follows the pointer instantly, position lerps toward it —
  // the lag is what makes the light feel like a carried object, not a cursor.
  const torch = useRef({ x: -600, y: -600, tx: -600, ty: -600 });
  // Seek targets are written by the scroll handler and applied by the ticker,
  // eased, so a fast flick doesn't fire one hard seek per frame.
  const seek = useRef<Array<{ target: number | null; cur: number | null }>>([
    { target: null, cur: null },
    { target: null, cur: null },
    { target: null, cur: null },
  ]);
  const moatsShown = useRef(false);

  /**
   * `null` until the media queries have actually been evaluated — NOT `false`.
   *
   * It used to start `false`, and that silently killed the cold open: on mount
   * the intro effect read `cinematic === false`, concluded "narrow viewport,
   * skip the intro", and set `coldDone` before the width was ever measured. The
   * media query resolved a tick later and set `cinematic = true`, but by then
   * the intro was marked done and never rendered a single frame. Anything that
   * decides "no motion for this visitor" has to wait for the measurement rather
   * than assume the pre-measurement default means no.
   */
  const [cinematic, setCinematic] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [coldDone, setColdDone] = useState(false);
  const [coldGone, setColdGone] = useState(false);
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [line2Visible, setLine2Visible] = useState(false);

  /**
   * The cinematic layer (sticky acts, scrubbed video, torch cursor) is desktop
   * + full-motion only. Narrow viewports and reduced-motion users get the same
   * content as plain stacked sections — which is also what ships if JS never
   * hydrates, since `cinematic` starts false.
   */
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 901px)");
    const motionOk = window.matchMedia("(prefers-reduced-motion: no-preference)");
    const sync = () => setCinematic(wide.matches && motionOk.matches);
    sync();
    wide.addEventListener("change", sync);
    motionOk.addEventListener("change", sync);
    return () => {
      wide.removeEventListener("change", sync);
      motionOk.removeEventListener("change", sync);
    };
  }, []);

  /**
   * `coldDone` starts the 0.8s fade the comp specifies; `coldGone` unmounts the
   * overlay once it has finished. Two flags because unmounting on `coldDone`
   * alone deletes the element mid-transition — which is what happened here, so
   * the intro vanished in one frame instead of dissolving into act 1.
   */
  const endCold = useCallback(() => {
    setLine1(COLD_OPEN[0]);
    setLine2(COLD_OPEN[1]);
    setLine2Visible(true);
    setColdDone(true);
    window.setTimeout(() => setColdGone(true), FADE_OUT_MS);
  }, []);

  // Cold open. Runs on its own timers rather than the ticker so the two lines
  // keep their cadence even if the tab is backgrounded mid-type.
  useEffect(() => {
    if (coldDone) return;
    // Not measured yet — hold. Deciding here is what used to skip the intro.
    if (cinematic === null) return;
    if (!cinematic) {
      endCold();
      return;
    }
    let cancelled = false;
    const timers: number[] = [];
    let i = 0;
    let j = 0;

    const typeSecond = () => {
      if (cancelled) return;
      setLine2Visible(true);
      const iv = window.setInterval(() => {
        if (cancelled) return window.clearInterval(iv);
        j += 1;
        setLine2(COLD_OPEN[1].slice(0, j));
        if (j >= COLD_OPEN[1].length) {
          window.clearInterval(iv);
          timers.push(window.setTimeout(endCold, HOLD_MS));
        }
      }, CHAR_MS);
      timers.push(iv);
    };

    const iv1 = window.setInterval(() => {
      if (cancelled) return window.clearInterval(iv1);
      i += 1;
      setLine1(COLD_OPEN[0].slice(0, i));
      if (i >= COLD_OPEN[0].length) {
        window.clearInterval(iv1);
        timers.push(window.setTimeout(typeSecond, LINE_GAP_MS));
      }
    }, CHAR_MS);
    timers.push(iv1);

    return () => {
      cancelled = true;
      timers.forEach((t) => {
        window.clearInterval(t);
        window.clearTimeout(t);
      });
    };
  }, [cinematic, coldDone, endCold]);

  // Skip on space / escape (click is wired on the overlay itself).
  useEffect(() => {
    if (coldDone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "Escape") {
        e.preventDefault();
        endCold();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [coldDone, endCold]);

  // Video sources are attached only in cinematic mode, so narrow / reduced-
  // motion visitors never pay for the download.
  useEffect(() => {
    if (!cinematic) return;
    const sources = [VIDEOS.door, VIDEOS.hall, VIDEOS.tower];
    videoRefs.current.forEach((v, idx) => {
      if (!v || v.src) return;
      v.src = sources[idx];
    });
    // Swap still → video the moment the media is seekable. Without this the
    // swap waits for the next scroll event, so a visitor who reads act 1
    // without scrolling never sees the scrubbed hero at all.
    const ready = () => applyScrollRef.current?.();
    const attached = videoRefs.current.filter((v): v is HTMLVideoElement => !!v);
    for (const v of attached) v.addEventListener("loadedmetadata", ready);

    const tower = videoRefs.current[2];
    const onCanPlay = () => {
      void tower?.play().catch(() => {});
      if (tower) tower.style.opacity = "1";
    };
    tower?.addEventListener("canplay", onCanPlay, { once: true });

    return () => {
      for (const v of attached) v.removeEventListener("loadedmetadata", ready);
      tower?.removeEventListener("canplay", onCanPlay);
      // Leaving cinematic mode (narrow resize / OS reduce-motion toggled mid
      // visit) must stop the decode AND abort in-flight downloads — otherwise
      // exactly the visitors promised "no video" keep paying for three.
      for (const v of attached) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
    };
  }, [cinematic]);

  // Latest applyScroll, callable from listeners registered in another effect
  // without making that effect depend on (and re-run for) every change.
  const applyScrollRef = useRef<(() => void) | null>(null);

  /** One-tap copy for the install command (the chip read as a button before). */
  const copyInstall = useCallback(() => {
    void navigator.clipboard
      ?.writeText(INSTALL_CMD)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* clipboard blocked (insecure context / permission) — chip just stays */
      });
  }, []);

  /** Scroll-linked layout: opacity/scale per act + per-act video seek target. */
  const applyScroll = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc || !cinematic) return;
    const vh = window.innerHeight;
    const total = sc.offsetHeight - vh;
    const y = clamp(-sc.getBoundingClientRect().top, 0, total);
    // Nudge off the exact top end: at p === N the last act's `local` is 1,
    // which falls outside BOTH branches below and would leave the whole CTA
    // act invisible + click-through for the last band of the page.
    const p = total ? Math.min((y / total) * N, N - 1e-4) : 0;
    const active = Math.min(N - 1, Math.floor(p));

    for (let i = 0; i < N; i += 1) {
      const el = actRefs.current[i];
      if (!el) continue;
      const local = p - i;
      let opacity = 0;
      let scale = 1;
      if (local >= 0 && local < 1) {
        const out = Math.max(0, (local - (1 - W)) / W);
        opacity = i === N - 1 ? 1 : 1 - ease(out);
        scale = i === N - 1 ? 1 : 1 + ease(out) * 0.1;
      } else if (local >= -1 && local < 0) {
        const inK = (local + W) / W;
        opacity = local > -W ? ease(inK) : 0;
        scale = local > -W ? 1 + (1 - ease(inK)) * 0.05 : 1.05;
      }
      el.style.opacity = String(clamp(opacity, 0, 1));
      el.style.transform = `scale(${scale})`;
      el.style.pointerEvents = opacity > 0.5 ? "auto" : "none";
    }

    // Act 1 — the door. With video: scrub it. Without: zoom the still and
    // widen the light beam so the gate still reads as opening.
    {
      const local = clamp(p, 0, 1);
      const v = videoRefs.current[0];
      const has = scrubbable(v);
      if (has) seek.current[0].target = local * (v.duration - 0.05);
      if (v) v.style.opacity = has ? "1" : "0";
      const bg = bgRefs.current[0];
      if (bg) {
        bg.style.opacity = has ? "0" : "1";
        bg.style.transform = has ? "none" : `scale(${1 + local * 0.22})`;
      }
      const beam = beamRef.current;
      if (beam) {
        beam.style.opacity = has ? "0" : String(0.4 + local * 0.6);
        beam.style.width = `${26 + local * 34}%`;
        beam.style.transform = `translateX(${-8 - local * 14}%)`;
      }
      const flash = flashRef.current;
      if (flash) flash.style.opacity = String(Math.pow(Math.max(0, (local - 0.55) / 0.45), 2) * 0.85);
      const hint = hintRef.current;
      if (hint) hint.style.opacity = String(clamp(1 - local * 2.5, 0, 1));
    }

    // Act 2 — the hall. Copy swaps at the midpoint: the corridor sells the
    // council, the columned hall behind it sells the cascade.
    {
      const local = clamp(p - 1, 0, 1);
      const v = videoRefs.current[1];
      const has = scrubbable(v);
      if (has) seek.current[1].target = local * (v.duration - 0.05);
      if (v) v.style.opacity = has ? "1" : "0";
      const bg = bgRefs.current[1];
      if (bg) {
        bg.style.opacity = has ? "0" : "1";
        bg.style.transform = has ? "none" : `scale(${1 + local * 0.14})`;
      }
      const second = local > 0.5;
      const a = copyARef.current;
      const b = copyBRef.current;
      const m = moatsRef.current;
      if (a) {
        a.style.opacity = second ? "0" : "1";
        a.style.pointerEvents = second ? "none" : "auto";
      }
      if (b) {
        b.style.opacity = second ? "1" : "0";
        b.style.pointerEvents = second ? "auto" : "none";
      }
      if (m) {
        m.style.opacity = second ? "0" : "1";
        m.style.pointerEvents = second ? "none" : "auto";
      }
    }

    dotRefs.current.forEach((d, i) => {
      if (!d) return;
      d.classList.toggle(styles.dotOn, i === active);
    });

    if (active === 1 && !moatsShown.current) {
      moatsShown.current = true;
      moatsRef.current?.querySelectorAll<HTMLElement>(`.${styles.moat}`).forEach((card, i) => {
        window.setTimeout(() => {
          card.style.opacity = "1";
          card.style.transform = "translateY(0)";
        }, i * 80);
      });
    }
  }, [cinematic]);

  useEffect(() => {
    applyScrollRef.current = applyScroll;
  }, [applyScroll]);

  useEffect(() => {
    if (!cinematic) return;
    applyScroll();
    const onScroll = () => applyScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [cinematic, applyScroll]);

  // One ticker drives torch easing + eased video seeking. Scroll itself is
  // event-driven above; this loop only smooths what the events set.
  useForgeTicker(() => {
    if (!cinematic) return;
    const t = torch.current;
    t.x += (t.tx - t.x) * 0.12;
    t.y += (t.ty - t.y) * 0.12;
    const el = torchRef.current;
    if (el) {
      el.style.left = `${t.x}px`;
      el.style.top = `${t.y}px`;
    }
    seek.current.forEach((s, i) => {
      const v = videoRefs.current[i];
      if (!v || s.target == null || !scrubbable(v) || i === 2) return;
      if (s.cur == null) s.cur = v.currentTime || 0;
      s.cur += (s.target - s.cur) * 0.22;
      if (Math.abs(s.target - s.cur) < 0.01) s.cur = s.target;
      if (!v.seeking && Math.abs(v.currentTime - s.cur) > 0.016) {
        try {
          v.currentTime = s.cur;
        } catch {
          /* seek raced a reload — the next tick retries */
        }
      }
    });
    // `=== true`: the ticker must stay off while the measurement is still
    // pending (null), same as when it resolves to "not cinematic".
  }, 1000, cinematic === true);

  const onPointerMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!cinematic) return;
      const stage = stageRef.current;
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      torch.current.tx = e.clientX - r.left;
      torch.current.ty = e.clientY - r.top;
      if (torchRef.current) torchRef.current.style.opacity = "1";
      // Magnetic CTAs: pull toward the pointer, capped, released on leave.
      magnetRefs.current.forEach((btn) => {
        if (!btn) return;
        const b = btn.getBoundingClientRect();
        const dx = e.clientX - (b.left + b.width / 2);
        const dy = e.clientY - (b.top + b.height / 2);
        const d = Math.hypot(dx, dy) || 1;
        const reach = 80 + b.width / 2;
        if (d < reach) {
          const f = Math.min(6, 6 * (1 - d / reach) * 2);
          btn.style.transform = `translate(${(dx / d) * f}px, ${(dy / d) * f}px)`;
        } else {
          btn.style.transform = "translate(0,0)";
        }
      });
    },
    [cinematic],
  );

  const onPointerLeave = useCallback(() => {
    if (torchRef.current) torchRef.current.style.opacity = "0";
    magnetRefs.current.forEach((b) => b && (b.style.transform = "translate(0,0)"));
  }, []);

  const jumpTo = useCallback((i: number) => {
    const sc = scrollRef.current;
    if (!sc) return;
    const seg = (sc.offsetHeight - window.innerHeight) / N;
    const base = sc.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: base + seg * i + (i ? seg * 0.25 : 0), behavior: "smooth" });
  }, []);

  const setVideo = (i: number) => (el: HTMLVideoElement | null) => {
    videoRefs.current[i] = el;
  };
  const setAct = (i: number) => (el: HTMLDivElement | null) => {
    actRefs.current[i] = el;
  };
  const setBg = (i: number) => (el: HTMLDivElement | null) => {
    bgRefs.current[i] = el;
  };
  const setDot = (i: number) => (el: HTMLElement | null) => {
    dotRefs.current[i] = el;
  };
  const setMagnet = (i: number) => (el: HTMLElement | null) => {
    magnetRefs.current[i] = el;
  };

  return (
    <div className={cinematic ? styles.rootCinematic : styles.rootStatic}>
      <div ref={scrollRef} className={styles.scroll}>
        <div
          ref={stageRef}
          className={styles.stage}
          onMouseMove={onPointerMove}
          onMouseLeave={onPointerLeave}
        >
          {/* ACT 1 — the gate */}
          <div ref={setAct(0)} className={styles.act}>
            <div
              ref={setBg(0)}
              className={styles.bg}
              style={{ backgroundImage: `url(${SCENES.door})`, transformOrigin: "55% 46%" }}
            />
            <video ref={setVideo(0)} className={styles.video} muted playsInline preload="auto" />
            <div ref={beamRef} className={styles.beam} />
            <div ref={flashRef} className={styles.flash} />
            <div className={styles.shadeLeft} />
            <div className={styles.copy}>
              <span className={styles.kicker} lang="en">
                <span className={styles.caretMark}>&gt; </span>braavolabs
              </span>
              <h1 className={styles.h1}>
                Ai <span className={styles.accent}>Morghulis.</span>
              </h1>
              <p className={styles.lede}>
                Every task must die. Quietly, on your machine. The governed command center for your
                AI agents.
              </p>
            </div>
            <div ref={hintRef} className={styles.hint}>
              SCROLL — OPEN THE DOOR ▾
            </div>
          </div>

          {/* ACT 2 — the hall */}
          <div ref={setAct(1)} className={styles.act} style={{ opacity: 0 }}>
            <div
              ref={setBg(1)}
              className={styles.bg}
              style={{ backgroundImage: `url(${SCENES.faces})`, transformOrigin: "50% 45%" }}
            />
            <video ref={setVideo(1)} className={styles.video} muted playsInline preload="auto" />
            <div className={styles.nicheWaves} aria-hidden>
              <i style={{ left: "20%", top: "20%", width: "18%", height: "50%" }} />
              <i style={{ left: "44%", top: "22%", width: "16%", height: "46%", animationDelay: "1.2s" }} />
              <i style={{ left: "66%", top: "24%", width: "14%", height: "42%", animationDelay: "2.4s" }} />
            </div>
            <div className={styles.shadeLeft} />
            <div ref={copyARef} className={`${styles.copy} ${styles.copyHigh}`}>
              <span className={styles.kicker} lang="en">
                <span className={styles.caretMark}>&gt; </span>every agent, one hall
              </span>
              <h2 className={styles.h2}>
                One panel.
                <br />
                Every agent.
              </h2>
              <p className={styles.lede}>
                Claude, GPT, Gemini, your local models — hooded in their alcoves, waiting for a name.
                Hand a task to one; watch it pass the thread to the next.
              </p>
            </div>
            <div ref={copyBRef} className={`${styles.copy} ${styles.copyHigh} ${styles.copyHidden}`}>
              <span className={styles.kicker} lang="en">
                <span className={styles.caretMark}>&gt; </span>three lanes, one bill
              </span>
              <h2 className={styles.h2}>
                Route it to the cheapest
                <br />
                lane that works.
              </h2>
              <p className={styles.lede}>
                Local models handle the routine, your API keys take the hard parts, your own CLI
                subscription covers the rest — the cascade decides, you keep the difference.
              </p>
              <div className={styles.stats}>
                <div>
                  <b>38%</b>
                  cheaper avg. run
                  <br />
                  routing · caching · cascade
                </div>
                <div>
                  <b>0</b>
                  token markup
                  <br />
                  BYOK — your own keys
                </div>
                <div>
                  <b>3</b>
                  lanes
                  <br />
                  local · API · your CLI
                </div>
              </div>
            </div>
            <div ref={moatsRef} className={styles.moats}>
              <div className={styles.moat}>
                <b>Model-agnostic memory</b>
                <span>Your context stays yours, whichever model runs.</span>
              </div>
              <div className={styles.moat}>
                <b>Governance by default</b>
                <span>Every risky step passes an approval gate.</span>
              </div>
              <div className={styles.moat}>
                <b>Multi-model handoff</b>
                <span>One agent hands the thread to the next.</span>
              </div>
            </div>
          </div>

          {/* ACT 3 — the tower / CTA */}
          <div ref={setAct(2)} className={styles.act} style={{ opacity: 0 }}>
            <div
              ref={setBg(2)}
              className={styles.bg}
              style={{ backgroundImage: `url(${SCENES.tower})`, backgroundPosition: "62% 45%" }}
            />
            <video
              ref={setVideo(2)}
              className={styles.video}
              muted
              playsInline
              loop
              preload="auto"
              poster={SCENES.tower}
            />
            <div className={styles.shadeLeft} />
            <div className={`${styles.copy} ${styles.copyWide}`}>
              <span className={styles.kicker} lang="en">
                <span className={styles.caretMark}>&gt; </span>ai serves. you command.
              </span>
              <h2 className={styles.h2Big}>
                Ai <span className={styles.accent}>Dohaeris.</span>
              </h2>
              <p className={styles.lede}>
                Runs live on your machine and keep going while you walk away. The tower watches; you
                stay in command from anywhere.
              </p>
              <ol className={styles.points}>
                <li>
                  <span className={styles.num}>01</span>
                  <span>
                    <b>Approve from your pocket.</b> Risky steps ping your phone — allow, deny or
                    steer in one tap.
                  </span>
                </li>
                <li>
                  <span className={styles.num}>02</span>
                  <span>
                    <b>Every run is replayable.</b> Commands, diffs and tool calls recorded — audit
                    or rewind any step.
                  </span>
                </li>
                <li>
                  <span className={styles.num}>03</span>
                  <span>
                    <b>One kill switch.</b> Stop every session, host and vendor CLI at once —
                    nothing keeps running behind your back.
                  </span>
                </li>
              </ol>
              <div className={styles.ctas}>
                {/* Desktop builds aren't published yet (native signing +
                    notarization is a founder gate), so both platform CTAs go
                    to the account funnel rather than a 404 download. */}
                <a href="/register" ref={setMagnet(0)} className={styles.btnArc}>
                  Download for macOS
                </a>
                <a href="/register" ref={setMagnet(1)} className={styles.btnGhost}>
                  Windows
                </a>
                <button type="button" className={styles.install} onClick={copyInstall}>
                  {INSTALL_CMD} <i>{copied ? "COPIED" : "COPY"}</i>
                </button>
              </div>
              <div className={styles.coinRow}>
                <div className={styles.coinWrap}>
                  <div className={styles.coinGlow} />
                  <div className={styles.coin}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {/* The comp ships the "-a" coin artwork, not the earlier
                        .webp pair still sitting beside it in public/hero. */}
                    <img src="/hero/coin-front-a.png" alt="Braavolabs coin — obverse" />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/hero/coin-back-a.png"
                      alt="Braavolabs coin — reverse, circuit-line BL monogram"
                      className={styles.coinBack}
                    />
                  </div>
                </div>
                <span className={styles.coinNote}>hover to flip · reverse: circuit-line BL monogram</span>
              </div>
            </div>
          </div>

          <div className={styles.vignette} aria-hidden />
          <div className={styles.grain} aria-hidden />

          {/* NO top bar. The comp has none — the stage is meant to be edge to
              edge, and the founder's brief for this page is narrow: the only
              things it offers are the download and the install command. A
              pricing/sign-in rail would both break the frame and widen that
              offer. Account routes stay reachable from the footer. */}

          <nav className={styles.rail} aria-label="Scene navigation">
            {RAIL.map((label, i) => (
              <button
                key={label}
                type="button"
                ref={setDot(i)}
                className={`${styles.dot} ${i === 0 ? styles.dotOn : ""}`}
                onClick={() => jumpTo(i)}
                aria-label={`Jump to ${label}`}
              />
            ))}
          </nav>

          <div ref={torchRef} className={styles.torch} aria-hidden />

          {!coldGone && (
            <div
              className={`${styles.cold} ${coldDone ? styles.coldOut : ""}`}
              onClick={endCold}
              role="button"
              tabIndex={0}
              aria-label="Skip intro"
              onKeyDown={(e) => e.key === "Enter" && endCold()}
            >
              <div className={styles.coldLines}>
                <div>
                  <span className={styles.caretMark}>&gt;</span> {line1}
                </div>
                <div style={{ opacity: line2Visible ? 1 : 0 }}>
                  <span className={styles.caretMark}>&gt;</span> {line2}
                  <span className={styles.caret} />
                </div>
              </div>
              <div className={styles.skip}>SKIP — space / click</div>
            </div>
          )}
        </div>
      </div>

      <footer className={styles.footer}>
        <span>
          <span className={styles.caretMark}>&gt; </span>braavolabs · valar dohaeris
        </span>
        <div>
          {/* The comp's footer reads: "/ask web-lite · docs · github". The
              first one is deliberately NOT wired — founder decision W-0
              (2026-07-24), restated for this page: nothing on the site does
              AI or automation work; the site hands you the download and the
              install command, and the work happens on your own machine. An
              in-browser "/ask" surface is exactly the thing that is out of
              scope, so the link is dropped rather than pointed somewhere. */}
          <a href="/docs">docs</a>
          <a href="https://github.com/kocakkmustafa" rel="noreferrer">
            github
          </a>
        </div>
      </footer>
    </div>
  );
}
