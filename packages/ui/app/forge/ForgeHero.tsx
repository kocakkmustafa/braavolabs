"use client";

/**
 * Braavolabs cinematic hero — faithful port of
 * braavolabs-v2-workspace/hero-prototype/index.html into a Next.js client
 * component. Five fixed "scenes" (Kapı / Yüzler Salonu / İç Salon / Kule /
 * CTA) are crossfaded by a single GSAP ScrollTrigger-scrubbed timeline as
 * the user scrolls through a tall spacer ("driver"); Lenis provides the
 * smooth-scroll feel. See the source file for the original standalone
 * version — this file mirrors its behavior 1:1, just wired through React
 * refs instead of getElementById/querySelector and with proper effect
 * cleanup for React's dev-mode double-mount.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Geist, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import styles from "./forge-hero.module.css";

// next/font self-hosts these at build time — no CDN request, CSP-safe.
// Clash Display (the prototype's display face) is Fontshare-only, which is
// off-limits under this site's CSP, so Space Grotesk stands in as the
// display fallback and is wired to the same --display token the CSS
// expects.
const bodyFont = Geist({ subsets: ["latin"], variable: "--forge-font-body", display: "swap" });
const monoFont = JetBrains_Mono({ subsets: ["latin"], variable: "--forge-font-mono", display: "swap" });
const displayFont = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--forge-font-display", display: "swap" });

function cx(...classes: Array<string | false | undefined | null>) {
  return classes.filter(Boolean).join(" ");
}

type Particle = {
  id: number;
  ember: boolean;
  left: string;
  bottom: string;
  size: string;
  duration: string;
  delay: string;
};

const DOT_LABELS = ["Kapı", "Salon", "Ocak", "Gözcü", "Başla"];
const SCENE_COUNT = 5;

export default function ForgeHero() {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const driverRef = useRef<HTMLDivElement>(null);

  const sceneRefs = useRef<Array<HTMLElement | null>>([]);
  const copyRefs = useRef<Array<HTMLDivElement | null>>([]);
  const windswayRefs = useRef<Array<HTMLImageElement | null>>([]);

  const seamRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const watcherRef = useRef<HTMLImageElement>(null);

  const pfillRef = useRef<HTMLDivElement>(null);
  const dotRefs = useRef<Array<HTMLDivElement | null>>([]);
  const hintRef = useRef<HTMLDivElement>(null);

  const [particles, setParticles] = useState<Particle[]>([]);

  // Particle field is randomized per mount — generated client-side only
  // (post-mount) so server-rendered markup and the first client render
  // match exactly (Math.random() during render would desync them).
  useEffect(() => {
    const next: Particle[] = Array.from({ length: 26 }, (_, i) => {
      const dur = 8 + Math.random() * 10;
      return {
        id: i,
        ember: i % 4 === 0,
        left: `${Math.random() * 100}%`,
        bottom: `${-5 + Math.random() * 10}%`,
        size: `${2 + Math.random() * 2.5}px`,
        duration: `${dur}s`,
        delay: `${-Math.random() * dur}s`,
      };
    });
    setParticles(next);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const driver = driverRef.current;
    const stage = stageRef.current;
    if (!root || !driver || !stage) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scenes = sceneRefs.current.filter((s): s is HTMLElement => Boolean(s));
    const N = scenes.length || SCENE_COUNT;
    const SEG = 0.9; // scroll units per scene

    driver.style.height = `${N * 85}vh`;

    // Prototype forced `html{scroll-behavior:auto}` globally so Lenis
    // wasn't fighting the browser's native smooth-scroll on anchor jumps.
    // Scoped here instead of touching the site-wide globals.css, and
    // restored on cleanup so other routes are unaffected.
    const htmlEl = document.documentElement;
    const prevScrollBehavior = htmlEl.style.scrollBehavior;
    htmlEl.style.scrollBehavior = "auto";

    // ---------- reduced motion: static stacked scenes ----------
    if (reduce) {
      scenes.forEach((s) => {
        s.style.opacity = "1";
        s.style.position = "relative";
        s.style.height = "100vh";
      });
      stage.style.position = "relative";
      stage.style.height = "auto";
      driver.style.display = "none";
      copyRefs.current.forEach((c) => {
        if (c) c.style.opacity = "1";
      });
      if (ctaRef.current) ctaRef.current.style.opacity = "1";

      return () => {
        htmlEl.style.scrollBehavior = prevScrollBehavior;
      };
    }

    gsap.registerPlugin(ScrollTrigger);

    // ---------- Lenis smooth scroll ----------
    const lenis = new Lenis({ lerp: 0.09, wheelMultiplier: 1 });
    const onLenisScroll = () => ScrollTrigger.update();
    lenis.on("scroll", onLenisScroll);
    const tickerCb = (t: number) => lenis.raf(t * 1000);
    gsap.ticker.add(tickerCb);
    gsap.ticker.lagSmoothing(0);

    const cta = ctaRef.current;
    const watcher = watcherRef.current;
    const copies = copyRefs.current;

    // explicit initial states so scroll=0 shows scene 0 cleanly
    gsap.set(scenes, { opacity: 0, scale: 1.15 });
    if (scenes[0]) gsap.set(scenes[0], { opacity: 1, scale: 1 });
    const copyEls = copies.filter((c): c is HTMLDivElement => Boolean(c));
    if (copyEls.length) gsap.set(copyEls, { opacity: 0, y: 46 });
    if (cta) gsap.set(cta, { opacity: 0, y: 26 });
    if (watcher) gsap.set(watcher, { opacity: 0, y: 26 });
    if (seamRef.current) gsap.set(seamRef.current, { opacity: 0 });

    // ---------- master timeline (scrubbed, .to()-only for predictable start) ----------
    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: driver,
        start: "top top",
        end: "bottom bottom",
        scrub: 0.8,
        onUpdate: (self) => {
          if (pfillRef.current) pfillRef.current.style.height = `${self.progress * 100}%`;
        },
      },
    });
    if (seamRef.current) tl.to(seamRef.current, { opacity: 0.9, duration: SEG * 0.5, ease: "power1.in" }, 0);
    if (copies[0]) tl.to(copies[0], { opacity: 1, y: 0, duration: SEG * 0.35, ease: "power2.out" }, SEG * 0.05);

    for (let i = 1; i < N; i++) {
      const t = i * SEG;
      tl.to(scenes[i - 1], { opacity: 0, scale: 0.94, duration: SEG * 0.55, ease: "power1.inOut" }, t - SEG * 0.5);
      tl.to(scenes[i], { opacity: 1, scale: 1, duration: SEG * 0.55, ease: "power1.inOut" }, t - SEG * 0.5);
      if (copies[i - 1]) tl.to(copies[i - 1], { opacity: 0, y: -32, duration: SEG * 0.3, ease: "power1.in" }, t - SEG * 0.5);
      if (copies[i]) tl.to(copies[i], { opacity: 1, y: 0, duration: SEG * 0.35, ease: "power2.out" }, t + SEG * 0.1);
    }
    // CTA reveal on last scene
    if (cta) tl.to(cta, { opacity: 1, y: 0, duration: SEG * 0.5, ease: "power2.out" }, (N - 1) * SEG + SEG * 0.05);
    if (watcher) tl.to(watcher, { opacity: 0.92, y: 0, duration: SEG * 0.5, ease: "power2.out" }, (N - 1) * SEG + SEG * 0.15);

    // ---------- active dot / hint ----------
    const dots = dotRefs.current.filter((d): d is HTMLDivElement => Boolean(d));
    const dotsTrigger = ScrollTrigger.create({
      trigger: driver,
      start: "top top",
      end: "bottom bottom",
      onUpdate: (self) => {
        const idx = Math.min(N - 1, Math.floor(self.progress * N + 0.15));
        dots.forEach((d, k) => d.classList.toggle(styles.on, k === idx));
        if (hintRef.current) hintRef.current.style.opacity = self.progress > 0.02 ? "0" : "1";
      },
    });

    // ---------- mouse parallax ----------
    let tx = 0,
      ty = 0,
      cx2 = 0,
      cy2 = 0;
    const onMouseMove = (e: MouseEvent) => {
      tx = (e.clientX / window.innerWidth - 0.5) * 2;
      ty = (e.clientY / window.innerHeight - 0.5) * 2;
      root.style.setProperty("--hx", `${e.clientX}px`);
      root.style.setProperty("--hy", `${e.clientY}px`);
    };
    window.addEventListener("mousemove", onMouseMove);
    const parallaxTicker = () => {
      cx2 += (tx - cx2) * 0.06;
      cy2 += (ty - cy2) * 0.06;
      root.style.setProperty("--mx", cx2.toFixed(3));
      root.style.setProperty("--my", cy2.toFixed(3));
    };
    gsap.ticker.add(parallaxTicker);

    // ---------- gentle wind sway (scenes 3 & 4) ----------
    const windswayEls = windswayRefs.current.filter((el): el is HTMLImageElement => Boolean(el));
    const windswayTween = windswayEls.length
      ? gsap.to(windswayEls, { rotation: 0.5, x: 6, duration: 5, ease: "sine.inOut", yoyo: true, repeat: -1 })
      : null;

    // ---------- dot click -> scroll ----------
    const dotClickHandlers = dots.map((_, k) => () => {
      const y = driver.offsetTop + (k / N) * driver.offsetHeight;
      lenis.scrollTo(y);
    });
    dots.forEach((d, k) => d.addEventListener("click", dotClickHandlers[k]));

    ScrollTrigger.refresh();

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      gsap.ticker.remove(tickerCb);
      gsap.ticker.remove(parallaxTicker);
      dots.forEach((d, k) => d.removeEventListener("click", dotClickHandlers[k]));
      windswayTween?.kill();
      dotsTrigger.kill();
      tl.scrollTrigger?.kill();
      tl.kill();
      // Belt-and-suspenders: kill anything else this effect may have
      // registered, so React strict-mode's mount/unmount/mount doesn't
      // leave duplicate scroll triggers wired to a stale `driver` node.
      ScrollTrigger.getAll().forEach((st) => st.kill());
      lenis.off("scroll", onLenisScroll);
      lenis.destroy();
      // Restore GSAP's default lag smoothing / html scroll-behavior —
      // this component doesn't own the whole page in this app the way it
      // did as a standalone prototype.
      gsap.ticker.lagSmoothing(500, 33);
      htmlEl.style.scrollBehavior = prevScrollBehavior;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSceneRef = (i: number) => (el: HTMLElement | null) => {
    sceneRefs.current[i] = el;
  };
  const setCopyRef = (i: number) => (el: HTMLDivElement | null) => {
    copyRefs.current[i] = el;
  };
  const setWindswayRef = (i: number) => (el: HTMLImageElement | null) => {
    windswayRefs.current[i] = el;
  };
  const setDotRef = (i: number) => (el: HTMLDivElement | null) => {
    dotRefs.current[i] = el;
  };

  const fontVars = useMemo(
    () => cx(bodyFont.variable, monoFont.variable, displayFont.variable),
    []
  );

  return (
    <div ref={rootRef} className={cx(styles.root, fontVars)}>
      {/* ===== fixed cinematic stage ===== */}
      <div className={styles.stage} ref={stageRef}>
        {/* Scene 1 — Kapı */}
        <section className={styles.scene} data-i={0} ref={setSceneRef(0)}>
          <img className={styles.bg} src="/hero/scene1-door.webp" alt="Tapınak Kapısı" />
          <div className={styles.glowseam} ref={seamRef} />
          <div className={styles.grade} />
          <div className={styles.sceneCopy} ref={setCopyRef(0)}>
            <div className={styles.kicker}>Braavolabs · AI Company OS</div>
            <h2 className={styles.sceneTitle}>Sırların kapısı aralanıyor.</h2>
            <p className={styles.sceneSub}>Kimsenin nasıl yapıldığını sormadığı işlerin, sessizce tamamlandığı yer.</p>
          </div>
        </section>

        {/* Scene 2 — Yüzler Salonu */}
        <section className={styles.scene} data-i={1} ref={setSceneRef(1)}>
          <img className={styles.bg} src="/hero/scene2-faces.webp" alt="Yüzler Salonu" />
          <div className={styles.cursorglow} />
          <div className={styles.grade} />
          <div className={styles.sceneCopy} ref={setCopyRef(1)}>
            <div className={styles.kicker}>Ajanlar Salonu</div>
            <h2 className={styles.sceneTitle}>
              Binlerce ajan.
              <br />
              Tek bir çatı.
            </h2>
            <p className={styles.sceneSub}>Sahip olduğun her ajan, otomasyon ve pipeline — tek panelden.</p>
          </div>
        </section>

        {/* Scene 3 — İç Salon */}
        <section className={styles.scene} data-i={2} ref={setSceneRef(2)}>
          <img className={cx(styles.bg, styles.windsway)} src="/hero/scene3-hall.webp" alt="İç Salon" ref={setWindswayRef(0)} />
          <div className={styles.candleFlick} />
          <div className={styles.grade} />
          <div className={styles.sceneCopy} ref={setCopyRef(2)}>
            <div className={styles.kicker}>Sessiz Zanaat</div>
            <h2 className={styles.sceneTitle}>Her görev, sessizce tamamlanır.</h2>
            <p className={styles.sceneSub}>Zamanlar, devreder, orkestre eder — sen izlersin.</p>
          </div>
        </section>

        {/* Scene 4 — Kule / Gözcü */}
        <section className={styles.scene} data-i={3} ref={setSceneRef(3)}>
          <img className={cx(styles.bg, styles.windsway)} src="/hero/scene4-tower.webp" alt="Kule Penceresi" ref={setWindswayRef(1)} />
          <span className={styles.leaf} style={{ left: "9%", top: "20%", ["--sd" as string]: "4.6s", ["--dl" as string]: ".2s" }} />
          <span className={styles.leaf} style={{ left: "15%", top: "50%", ["--sd" as string]: "5.4s", ["--dl" as string]: ".7s" }} />
          <span className={styles.leaf} style={{ left: "23%", top: "76%", ["--sd" as string]: "4.2s", ["--dl" as string]: ".3s" }} />
          <span className={styles.leaf} style={{ left: "31%", top: "34%", ["--sd" as string]: "5.8s", ["--dl" as string]: ".9s" }} />
          <span className={styles.leaf} style={{ right: "15%", top: "22%", ["--sd" as string]: "5.0s", ["--dl" as string]: ".5s" }} />
          <span className={styles.leaf} style={{ right: "22%", top: "64%", ["--sd" as string]: "4.5s", ["--dl" as string]: ".8s" }} />
          <div className={styles.facepulse} style={{ right: "27%", top: "43%" }} />
          <div className={styles.grade} />
          <div className={styles.sceneCopy} ref={setCopyRef(3)}>
            <div className={styles.kicker}>Gözcü</div>
            <h2 className={styles.sceneTitle}>Ve biri, hep izliyor.</h2>
            <p className={styles.sceneSub}>Niyetini bekliyor. Bir isim söylemen yetiyor.</p>
          </div>
        </section>

        {/* Scene 5 — CTA */}
        <section className={styles.scene} data-i={4} ref={setSceneRef(4)}>
          <img className={styles.bg} src="/hero/scene1-door.webp" alt="" style={{ filter: "brightness(.35) saturate(.7)" }} />
          <div className={styles.grade} />
          <div className={styles.ctaWrap} ref={ctaRef}>
            <div className={styles.ctaCoin}>
              <img src="/hero/coin.webp" alt="Braavolabs Coin" />
            </div>
            <h1 className={styles.ctaTitle}>Ai Dohaeris.</h1>
            <p className={styles.ctaSub}>
              <b>Yapay zeka hizmet eder.</b> Jaqen&rsquo;e üç isim vermek yetiyordu — sana bir tane bile yetecek. Niyetini söyle, gerisini biz hallederiz.
            </p>
            <div className={styles.intent}>
              <span className={styles.prompt}>&gt;_</span>
              <input type="text" placeholder="bir niyet söyle…  (örn. 'her sabah rakip fiyatlarını topla')" />
              <button className={styles.go}>Başla</button>
            </div>
            <div className={styles.ctaFoot}>
              Ai Morghulis <span className={styles.sep}>·</span> Ai Dohaeris
            </div>
          </div>
          <img className={styles.watcher} ref={watcherRef} src="/hero/mascot.webp" alt="Yüzsüz Elçi" style={{ right: "7vw", bottom: "9vh" }} />
        </section>
      </div>

      {/* overlays */}
      <div className={styles.particles}>
        {particles.map((p) => (
          <div
            key={p.id}
            className={cx(styles.p, p.ember && styles.em)}
            style={{
              left: p.left,
              bottom: p.bottom,
              width: p.size,
              height: p.size,
              animationDuration: p.duration,
              animationDelay: p.delay,
            }}
          />
        ))}
      </div>
      <div className={styles.vignette} />
      <div className={styles.grain} />

      {/* HUD */}
      <div className={cx(styles.hud, styles.brandmark)}>
        Braavo<b>labs</b>
      </div>
      <div className={cx(styles.hud, styles.seal)}>
        AI MORGHULIS
        <br />
        <span className={styles.m}>AI DOHAERIS</span>
      </div>
      <div className={cx(styles.hud, styles.progress)}>
        <div className={styles.track}>
          <div className={styles.fill} ref={pfillRef} />
        </div>
      </div>
      <nav className={cx(styles.hud, styles.dots)}>
        {DOT_LABELS.map((label, k) => (
          <div key={label} className={cx(styles.d, k === 0 && styles.on)} ref={setDotRef(k)}>
            <span className={styles.lbl}>{label}</span>
            <span className={styles.k} />
          </div>
        ))}
      </nav>
      <div className={cx(styles.hud, styles.scrollhint)} ref={hintRef}>
        KAYDIR
        <span className={styles.arrow} />
      </div>

      {/* driver: gives the page its scroll length */}
      <div className={styles.driver} ref={driverRef} />
    </div>
  );
}
