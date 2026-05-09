# Claude Design — Braavolabs Web Visual Refresh Brief

> Aşağıdaki tüm içeriği (bu satırın altındakileri) **olduğu gibi**
> Claude'a yapıştır. claude.ai → "New chat" veya "New project" →
> aşağıdaki blok hazır.

---

# Braavolabs — Web Visual Refresh Brief

You are the lead product designer redesigning the WEB FRONTEND of
Braavolabs (braavolabs.com), a live, multi-tenant AI-orchestration
SaaS where users describe a business in plain English and the
platform composes a multi-agent autonomous company. The site is
already in production — this is a visual refresh, not a redesign of
the information architecture.

## The brief in one sentence

Bring the web's visual language to feature parity with the polished
companion mobile app, which already ships the full Braavolabs design
system. Mobile is the source of truth; web is the follower.

## What you're working with

Two products that must look like clear siblings:
- braavolabs.com — Next.js 15 (App Router) + Tailwind v4
- Braavolabs Mobile — Expo SDK 52 + React Native 0.76 + NativeWind v4

Both ship the same brand: a "void" base (deep navy almost-black) lit
by cobalt + cyan + purple gradients, with hammered-steel accents and
glass-morphism cards that hover with subtle gradient borders. Brand
voice is "premium, audited, execution-focused" — the visual must
read like an enterprise product, not a consumer app.

## Mobile design tokens (THE source of truth — port these exactly)

```
Voids
  void-deepest   #050810   (background base on the deepest layers)
  void-base      #0a0d14   (default page background)
  void-surface   #0f1219   (raised surface)
  void-elevated  #1a1e28   (elevated surface)

Cobalt — the logo's rim light
  cobalt-glow    #1a3aff
  cobalt-deep    #0033cc
  cobalt-shadow  #001a66

Cyan
  cyan-bright    #00d1ff
  cyan-light     #a4e6ff
  cyan-tint      rgba(0,209,255,0.06)

Purple
  purple-bright  #6d11ad
  purple-light   #e0b6ff

Steel — for hammered-metal accents
  steel-highlight #c8ced6
  steel-mid       #6b7280
  steel-shadow    #2d3340

Text
  text-primary   #e1e2eb
  text-secondary #bbc9cf
  text-muted     #859399
  text-faint     #3c494e

Semantic
  success #34d399   warning #fbbf24
  danger  #f87171   info    #a4e6ff

Run / status states
  running    #00d1ff   completed  #34d399
  paused     #fbbf24   failed     #f87171
  cancelled  #c084fc

Brand gradient (3-stop, 135deg)
  cyan-bright (#00d1ff) → #4060ff → purple-bright (#6d11ad)

Glass primitives
  bg            rgba(15,18,25,0.6)
  border        rgba(255,255,255,0.05)
  border-hover  rgba(0,209,255,0.15)
  shadow-hover  0 8px 32px rgba(0,209,255,0.12)

Atmospheric mesh (3 radial gradients on void base)
  ellipse 80% 60% at 10% 20%, rgba(26,58,255,0.10), transparent 50%
  ellipse 60% 80% at 90% 80%, rgba(109,17,173,0.08), transparent 50%
  ellipse 40% 40% at 50% 50%, rgba(0,209,255,0.04), transparent 50%

Type
  display "Space Grotesk" 700, -0.02em tracking
  body    "Inter" 400-700
  mono    "JetBrains Mono"
  icon    "Material Symbols Outlined"

Easing
  cubic-bezier(0.16, 1, 0.3, 1)   — primary out-easing
```

## Mobile animation catalog (web has only 2 of these — port the rest)

1. **mesh-drift** (20s loop) — three radial mesh positions cycle softly
   so the page feels alive without distracting
2. **sheen** (8s loop, only fires last 10% of cycle) — diagonal white
   sweep across primary buttons + hero cards
3. **status-ping** (2s loop) — outward fade-scale on running/active dots
4. **pulse-glow** (3s loop) — amber box-shadow pulse on PENDING items
5. **gradient-shift** (6s loop) — primary buttons have a slowly drifting
   gradient (background-position 0% → 100% → 0%)
6. **stagger-fade** (50ms cascade) — list items fade up in sequence on
   first paint, each 50ms after the prior, max 8 children
7. **glass-rise** (400ms once) — modals/cards translateY(12px → 0) on
   mount
8. **live-tick** (4s loop, near-imperceptible) — 1px nudge every 4s on
   live counters / "active" badges so the eye knows it's real-time
9. **risk-flash** (600ms once) — left-border 3px stripe pulses
   danger→warning→danger when a new risk event lands

ALL animations must be wrapped in:
```css
@media (prefers-reduced-motion: reduce) { animation: none; }
```

## Web pages in scope (refresh, do not rewrite)

In priority order — the first 4 are user-facing marketing surfaces
that drive conversion; the last 4 are signed-in dashboard surfaces
where users spend most of their time:

**Marketing**
- `/` (home) — hero + agent-room canvas + 3 feature blocks +
  pricing teaser + CTA + footer
- `/pricing` — 4 tiers (Free / Creator / Business / Pro / Enterprise),
  monthly/yearly toggle
- `/features` — feature grid with icon + headline + 1-line description,
  12-16 items
- `/about` — team / story / values

**App (auth-gated)**
- `/dashboard` — health + usage + finance metric cards + recent runs
  feed + risk events panel
- `/companies` — list of AI companies with status dots
- `/pipelines/[id]` — run history + step-by-step audit trail
- `/integrations/import` — paste-and-preview UI (already shipped, just
  needs a visual pass)
- `/settings` — profile / billing / notifications / API keys

**Plus shared shell:**
- `/login`, `/register`, `/reset-password`
- Top-bar, sidebar (when signed in), command palette, notification
  bell, footer

## What to keep (do NOT touch)

- Information architecture — the route table above is fixed
- Copy + i18n — site supports en/tr/es/de/fr/ar; RTL must keep
  working (Arabic flips layout direction)
- Light mode — `html.light` variant exists for accessibility
  preference, must be carried forward in all new tokens
- Cookie consent banner shape (KVKK + GDPR compliant copy)
- Footer link list (already includes Cookies link to /cookies)

## What to upgrade (the actual deliverable)

For EACH page in scope, output:

1. A **high-fidelity static mockup** at 1440px desktop + 768px tablet +
   375px mobile breakpoints. Dark mode primary, light mode parallel.

2. **Specific CSS-utility-class swaps** the engineer applies. e.g.
   "replace `.glass-card` with new variant that adds gradient-border
   on hover, shadow goes from 8px to 12px on Y axis."

3. **Animation hooks** — for any motion you introduce, name it (e.g.
   `.bv-mesh-drift`), give the keyframe definition, and spec where
   it triggers (page mount / hover / scroll-into-view).

4. **Per-page micro-interactions** — tiny moments of personality. Two or
   three max per page, never more. Examples:
     - Home hero: agent-room canvas particles speed up briefly when
       the user hovers the headline
     - Pricing: tier cards lift 4px on hover, gradient border fades
       in over 240ms
     - Dashboard: live counters get the 4s live-tick
     - Risk panel: new entries get the 600ms risk-flash
     - Approval pending: amber pulse-glow box-shadow

## Constraints I will hold you to

**A. Performance budget.** The home page is currently ~80 KB compressed
HTML. New animations + assets must not push first-contentful paint
past 1.5s on a 3G connection. Prefer CSS over JS for motion;
prefer SVG over canvas where possible.

**B. Accessibility floor — WCAG 2.1 AA on every page:**
- 4.5:1 contrast on body text, 3:1 on large headings
- Focus rings visible on every interactive element (cyan-bright 2px
  outline-offset 2px)
- All animations honour `prefers-reduced-motion: reduce`
- Status conveyed by both color AND label (color-blind-safe)

**C. No new dependencies.** Tailwind v4 + CSS-in-JS where unavoidable.
No framer-motion, lottie, three.js, recharts. The mobile app uses
pure RN Animated + react-native-svg — web should stay similarly
lean (CSS keyframes + lightweight SVG).

**D. Don't break what works.** The live site has 0 visual regressions
reported in the daily audit. New mockups should look like a
confident next iteration, not a hard reset — a returning user
should recognize Braavolabs immediately.

**E. Light mode is real, not a checkbox.** Every dark mockup needs a
light-mode parallel. Light mode currently uses `#f5f7fa` background
+ `#006880` primary; iterate but don't drop it.

**F. Brand voice as visual rule:**
> "Premium · execution-focused · audited."

Visuals should feel earned, never showy. Subtle motion >
maximalist motion. Steel + cobalt > neon. Glass morphism only
where it adds depth, never decoratively.

## Reference: full mobile design CSS

This is the canonical Braavolabs design language — 515 lines of
design-token + component-primitive + animation definitions, currently
shipped on the mobile app. The web should land here.

```css
/* Braavolabs design tokens — paste-into-globals.css ready */
:root {
  /* Voids */
  --void-deepest: #050810;
  --void-base: #0a0d14;
  --void-surface: #0f1219;
  --void-elevated: #1a1e28;

  /* Cobalt */
  --cobalt-glow: #1a3aff;
  --cobalt-deep: #0033cc;
  --cobalt-shadow: #001a66;

  /* Cyan */
  --cyan-bright: #00d1ff;
  --cyan-light: #a4e6ff;
  --cyan-tint: rgba(0, 209, 255, 0.06);

  /* Purple */
  --purple-bright: #6d11ad;
  --purple-light: #e0b6ff;

  /* Steel */
  --steel-highlight: #c8ced6;
  --steel-mid: #6b7280;
  --steel-shadow: #2d3340;

  /* Text */
  --text-primary: #e1e2eb;
  --text-secondary: #bbc9cf;
  --text-muted: #859399;
  --text-faint: #3c494e;

  /* Semantic */
  --success: #34d399;
  --warning: #fbbf24;
  --danger: #f87171;
  --info: #a4e6ff;

  /* Status */
  --status-running: #00d1ff;
  --status-completed: #34d399;
  --status-paused: #fbbf24;
  --status-failed: #f87171;
  --status-cancelled: #c084fc;

  /* Brand gradient */
  --gradient-brand: linear-gradient(135deg, #00d1ff 0%, #4060ff 50%, #6d11ad 100%);

  /* Atmospheric mesh */
  --mesh-bg:
    radial-gradient(ellipse 80% 60% at 10% 20%, rgba(26, 58, 255, 0.10) 0%, transparent 50%),
    radial-gradient(ellipse 60% 80% at 90% 80%, rgba(109, 17, 173, 0.08) 0%, transparent 50%),
    radial-gradient(ellipse 40% 40% at 50% 50%, rgba(0, 209, 255, 0.04) 0%, transparent 50%);

  /* Glass */
  --glass-bg: rgba(15, 18, 25, 0.6);
  --glass-border: rgba(255, 255, 255, 0.05);
  --glass-border-hover: rgba(0, 209, 255, 0.15);
  --glass-shadow-hover: 0 8px 32px rgba(0, 209, 255, 0.12);

  /* Type */
  --font-display: "Space Grotesk", -apple-system, BlinkMacSystemFont, sans-serif;
  --font-body: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
  --font-icon: "Material Symbols Outlined";
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}

/* ───── Mesh background base ───── */
.bv-mesh {
  background-color: var(--void-base);
  background-image: var(--mesh-bg);
  background-size: 200% 200%;
  animation: mesh-drift 20s var(--ease-out) infinite;
}
@keyframes mesh-drift {
  0%, 100% { background-position: 0% 0%, 100% 100%, 50% 50%; }
  33% { background-position: 20% 30%, 70% 60%, 60% 40%; }
  66% { background-position: 80% 10%, 30% 80%, 40% 60%; }
}

/* ───── Glass surface ───── */
.bv-glass {
  background: var(--glass-bg);
  backdrop-filter: blur(20px) saturate(1.1);
  -webkit-backdrop-filter: blur(20px) saturate(1.1);
  border: 1px solid var(--glass-border);
  border-radius: 20px;
  position: relative;
  transition: border-color 240ms var(--ease-out), transform 240ms var(--ease-out), box-shadow 240ms var(--ease-out);
}
.bv-glass::after {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(135deg, rgba(0, 209, 255, 0.5), rgba(109, 17, 173, 0.5));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0;
  transition: opacity 400ms var(--ease-out);
  pointer-events: none;
}
.bv-glass:hover, .bv-glass:focus-within { transform: translateY(-2px); box-shadow: var(--glass-shadow-hover); }
.bv-glass:hover::after, .bv-glass:focus-within::after { opacity: 1; }

/* ───── Status dot + ping ───── */
.bv-dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; position: relative; flex-shrink: 0; }
.bv-dot.bv-running { background: var(--status-running); box-shadow: 0 0 8px var(--status-running); }
.bv-dot.bv-completed { background: var(--status-completed); }
.bv-dot.bv-paused { background: var(--status-paused); }
.bv-dot.bv-failed { background: var(--status-failed); }
.bv-dot.bv-cancelled { background: var(--status-cancelled); }
.bv-dot.bv-ping::before {
  content: "";
  position: absolute;
  inset: -2px;
  border-radius: 999px;
  background: inherit;
  animation: status-ping 2s var(--ease-out) infinite;
}
@keyframes status-ping {
  0% { opacity: 0.5; transform: scale(1); }
  80%, 100% { opacity: 0; transform: scale(2.5); }
}

/* ───── Shimmer skeleton ───── */
.bv-skeleton {
  background: linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.10) 50%, rgba(255,255,255,0.04) 100%);
  background-size: 200% 100%;
  animation: shimmer-load 1.5s linear infinite;
  border-radius: 8px;
}
@keyframes shimmer-load {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

/* ───── Pulse glow ───── */
.bv-pulse-glow { animation: pulse-glow 3s ease-in-out infinite; }
@keyframes pulse-glow {
  0%, 100% { box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.3), 0 0 24px rgba(251, 191, 36, 0.15); }
  50% { box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.5), 0 0 36px rgba(251, 191, 36, 0.30); }
}

/* ───── Gradient cycle ───── */
.bv-gradient-shift {
  background-size: 200% 200%;
  animation: gradient-shift 6s ease-in-out infinite;
}
@keyframes gradient-shift {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}

/* ───── Metallic sheen ───── */
.bv-sheen { position: relative; overflow: hidden; }
.bv-sheen::before {
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(120deg, transparent 30%, rgba(255,255,255,0.18) 50%, transparent 70%);
  transform: translateX(-100%);
  animation: sheen 8s ease-in-out infinite;
  pointer-events: none;
}
@keyframes sheen {
  0%, 80% { transform: translateX(-100%); }
  90%, 100% { transform: translateX(100%); }
}

/* ───── Stagger fade ───── */
.bv-stagger > * {
  opacity: 0;
  transform: translateY(8px);
  animation: stagger-fade 500ms var(--ease-out) forwards;
}
.bv-stagger > *:nth-child(1) { animation-delay: 0ms; }
.bv-stagger > *:nth-child(2) { animation-delay: 50ms; }
.bv-stagger > *:nth-child(3) { animation-delay: 100ms; }
.bv-stagger > *:nth-child(4) { animation-delay: 150ms; }
.bv-stagger > *:nth-child(5) { animation-delay: 200ms; }
.bv-stagger > *:nth-child(6) { animation-delay: 250ms; }
.bv-stagger > *:nth-child(7) { animation-delay: 300ms; }
.bv-stagger > *:nth-child(8) { animation-delay: 350ms; }
@keyframes stagger-fade {
  to { opacity: 1; transform: translateY(0); }
}

/* ───── Glass rise ───── */
.bv-rise { animation: glass-rise 400ms var(--ease-out); }
@keyframes glass-rise {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ───── Live tick ───── */
.bv-tick { animation: live-tick 4s ease-in-out infinite; }
@keyframes live-tick {
  0%, 95%, 100% { transform: translateY(0); }
  97% { transform: translateY(-1px); }
}

/* ───── Risk flash ───── */
.bv-risk-flash::before {
  content: "";
  position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--danger);
  animation: risk-flash 600ms var(--ease-out) 1;
  border-radius: 3px;
}
@keyframes risk-flash {
  0% { background: var(--danger); box-shadow: 0 0 12px var(--danger); }
  50% { background: var(--warning); box-shadow: 0 0 12px var(--warning); }
  100% { background: var(--danger); box-shadow: none; }
}

/* ───── Reset ───── */
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--font-body); color: var(--text-primary); }

.bv-screen {
  width: 100%; height: 100%;
  background-color: var(--void-base);
  background-image: var(--mesh-bg);
  background-size: 200% 200%;
  animation: mesh-drift 20s var(--ease-out) infinite;
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* Material Symbols base */
.bv-icon {
  font-family: "Material Symbols Outlined";
  font-weight: normal;
  font-style: normal;
  font-size: 20px;
  line-height: 1;
  letter-spacing: normal;
  text-transform: none;
  display: inline-block;
  white-space: nowrap;
  word-wrap: normal;
  direction: ltr;
  -webkit-font-feature-settings: 'liga';
  -webkit-font-smoothing: antialiased;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}

/* Type utilities */
.bv-display { font-family: var(--font-display); font-weight: 700; font-size: 32px; line-height: 1.1; letter-spacing: -0.02em; }
.bv-headline { font-family: var(--font-display); font-weight: 700; font-size: 24px; line-height: 1.2; letter-spacing: -0.02em; }
.bv-title { font-family: var(--font-display); font-weight: 500; font-size: 18px; line-height: 1.3; letter-spacing: -0.01em; }
.bv-body { font-size: 14px; line-height: 1.5; }
.bv-caption { font-size: 12px; line-height: 1.4; color: var(--text-secondary); }
.bv-micro { font-size: 11px; line-height: 1.4; color: var(--text-muted); letter-spacing: 0.02em; }
.bv-numeric { font-family: var(--font-display); font-weight: 700; font-variant-numeric: tabular-nums; }

/* Brand gradient text */
.bv-grad-text {
  background: var(--gradient-brand);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

/* Buttons */
.bv-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 18px;
  border-radius: 14px;
  font-family: var(--font-body);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  border: none;
  cursor: pointer;
  transition: transform 150ms var(--ease-out), box-shadow 240ms var(--ease-out), background 240ms var(--ease-out);
  min-height: 44px;
  user-select: none;
}
.bv-btn:active { transform: scale(0.98); }
.bv-btn:focus-visible { outline: 2px solid var(--cyan-bright); outline-offset: 2px; }

.bv-btn-primary {
  color: #050810;
  background: var(--gradient-brand);
  background-size: 200% 200%;
  box-shadow: 0 4px 20px rgba(0, 209, 255, 0.30), inset 0 1px 0 rgba(255,255,255,0.25);
  animation: gradient-shift 6s ease-in-out infinite;
  overflow: hidden;
}
.bv-btn-primary::before {
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(120deg, transparent 30%, rgba(255,255,255,0.30) 50%, transparent 70%);
  transform: translateX(-100%);
  animation: sheen 8s ease-in-out infinite;
  pointer-events: none;
}

.bv-btn-ghost {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.bv-btn-ghost:hover { border-color: rgba(0, 209, 255, 0.35); background: var(--cyan-tint); }

.bv-btn-danger {
  color: var(--danger);
  background: rgba(248, 113, 113, 0.10);
  border: 1px solid rgba(248, 113, 113, 0.25);
}
.bv-btn-danger:hover { background: rgba(248, 113, 113, 0.18); }

/* Pills */
.bv-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid;
}
.bv-pill-cyan { color: var(--cyan-light); background: rgba(0, 209, 255, 0.10); border-color: rgba(0, 209, 255, 0.25); }
.bv-pill-purple { color: var(--purple-light); background: rgba(109, 17, 173, 0.18); border-color: rgba(192, 132, 252, 0.25); }
.bv-pill-amber { color: var(--warning); background: rgba(251, 191, 36, 0.10); border-color: rgba(251, 191, 36, 0.25); }
.bv-pill-green { color: var(--success); background: rgba(52, 211, 153, 0.10); border-color: rgba(52, 211, 153, 0.25); }
.bv-pill-red { color: var(--danger); background: rgba(248, 113, 113, 0.10); border-color: rgba(248, 113, 113, 0.25); }
.bv-pill-muted { color: var(--text-muted); background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.08); }

/* Filter pill (wider, lower-case label) */
.bv-fpill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px;
  border-radius: 999px;
  font-size: 12px; font-weight: 500; letter-spacing: 0.02em;
  border: 1px solid rgba(255,255,255,0.08);
  color: var(--text-secondary);
  background: rgba(255,255,255,0.02);
  cursor: pointer;
  transition: all 200ms var(--ease-out);
}
.bv-fpill.active {
  color: var(--cyan-light);
  background: var(--cyan-tint);
  border-color: rgba(0,209,255,0.45);
  box-shadow: 0 0 0 1px rgba(0,209,255,0.15) inset;
}

/* Inputs */
.bv-input {
  width: 100%;
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px;
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 14px;
  transition: border-color 200ms var(--ease-out), background 200ms var(--ease-out);
}
.bv-input:focus-within { border-color: rgba(0,209,255,0.45); background: var(--cyan-tint); outline: none; }
.bv-input input { flex: 1; background: transparent; border: none; outline: none; color: var(--text-primary); font: inherit; min-width: 0; }
.bv-input input::placeholder { color: var(--text-muted); }

/* Avatar gradient */
.bv-avatar {
  flex-shrink: 0;
  width: 40px; height: 40px;
  border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  background: var(--gradient-brand);
  color: #050810;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 15px;
  box-shadow: 0 4px 16px rgba(0, 209, 255, 0.20), inset 0 1px 0 rgba(255,255,255,0.30);
  position: relative;
}
.bv-avatar.lg { width: 64px; height: 64px; border-radius: 18px; font-size: 22px; }
.bv-avatar.xl { width: 88px; height: 88px; border-radius: 24px; font-size: 32px; }

/* Tab bar */
.bv-tabbar {
  height: 76px;
  padding: 8px 12px 16px;
  background: rgba(10, 13, 20, 0.7);
  backdrop-filter: blur(24px) saturate(1.2);
  -webkit-backdrop-filter: blur(24px) saturate(1.2);
  border-top: 1px solid rgba(255,255,255,0.05);
  display: flex; align-items: center; justify-content: space-around;
}
.bv-tab {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 6px 4px;
  border-radius: 12px;
  color: var(--text-muted);
  font-size: 10px; font-weight: 500;
  cursor: pointer;
  position: relative;
  letter-spacing: 0.02em;
}
.bv-tab.active {
  color: var(--cyan-light);
}
.bv-tab.active::before {
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(135deg, rgba(0,209,255,0.18), rgba(109,17,173,0.18));
  border-radius: 12px;
  animation: tab-pop 200ms var(--ease-out);
  z-index: -1;
}
@keyframes tab-pop { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }

/* Toggle */
.bv-toggle {
  width: 44px; height: 26px;
  background: rgba(255,255,255,0.10);
  border-radius: 999px;
  position: relative;
  cursor: pointer;
  transition: background 200ms var(--ease-out);
  flex-shrink: 0;
}
.bv-toggle::after {
  content: "";
  position: absolute;
  top: 2px; left: 2px;
  width: 22px; height: 22px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  transition: transform 200ms var(--ease-out);
}
.bv-toggle.on { background: linear-gradient(135deg, var(--cyan-bright), var(--cobalt-glow)); box-shadow: 0 0 16px rgba(0,209,255,0.30); }
.bv-toggle.on::after { transform: translateX(18px); }

/* Header */
.bv-header {
  padding: 56px 20px 12px;
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px;
}
.bv-header-title { font-family: var(--font-display); font-weight: 700; font-size: 26px; letter-spacing: -0.02em; }
.bv-header-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; display: flex; align-items: center; gap: 6px; }

/* Section card */
.bv-card {
  margin: 0 16px 16px;
  padding: 16px;
  border-radius: 20px;
  background: var(--glass-bg);
  backdrop-filter: blur(20px) saturate(1.1);
  -webkit-backdrop-filter: blur(20px) saturate(1.1);
  border: 1px solid var(--glass-border);
}

/* Subcard (for payload previews etc.) */
.bv-subcard {
  background: rgba(5,8,16,0.5);
  border: 1px solid rgba(255,255,255,0.04);
  border-radius: 12px;
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
}

/* Helper: scroll area */
.bv-scroll { flex: 1; overflow-y: auto; padding-bottom: 8px; }
.bv-scroll::-webkit-scrollbar { display: none; }
.bv-scroll { scrollbar-width: none; }

/* Hammered metal divider */
.bv-divider {
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(200,206,214,0.10) 20%, rgba(200,206,214,0.18) 50%, rgba(200,206,214,0.10) 80%, transparent);
  margin: 8px 0;
}

/* Material Symbols sizing helpers */
.bv-icon-sm { font-size: 16px; }
.bv-icon-lg { font-size: 24px; }
.bv-icon-xl { font-size: 32px; }
```

## Reference: mobile screen contracts

The mobile app ships these screens; the web should rhyme with them:

**(tabs)**
- `index` — Command Center — health + usage + risk + finance metric
  cards, recent activity feed, focus polling every 15s
- `companies` — AI Companies list — name, plan, status dot, last-run
  relative time
- `workflows` — Pipelines list + recent runs
- `approvals` — PENDING approval queue (10s polling) + APPROVED/
  REJECTED history (60s polling)
- `more` — Drawer to drafts / risks / analytics / settings

**Detail screens**
- `companies/[id]` — agents + pipelines + activity log
- `workflows/[id]` — run history + step-by-step audit
- `drafts/` — AI-generated outputs, approve + publish
- `risks/` — severity-coded list, flash on new arrival
- `analytics/` — spend sparkline + agent + tool bars
- `settings/` — profile, plans, notifications, delete account

**Component primitives shipped on mobile:**
GlassCard, MetricCard, MeshBackground, StatusDot, Button (primary/
ghost/danger), Icon, Pill, Toggle, BarChart, SparkLine,
ActivityRow, CompanyRow, PipelineRow, RunRow, MoreRow, Header,
ScreenHeader, BackButton, BackHeader, EmptyState, FilterPills,
GradientText, HelmetLogo, Logo, SectionHead, SegmentedTabs, Skeleton

When designing the web, **prefer the same primitive names** so the
engineer can map 1:1.

## Deliverable structure I want back

For each page-in-scope (10 pages), produce a single artifact:

```
page-name.md
├── Hero shot          — the one-line summary of what changes
├── Desktop mockup     — 1440x900 PNG/SVG/Figma frame
├── Tablet mockup      — 768x1024
├── Mobile mockup      — 375x812 (web-mobile, not the native app)
├── Light-mode parallel for the desktop mockup
├── Token diff         — which CSS custom properties change /
                          are added
├── Component diff     — which primitives gain a new variant or
                          new modifier
├── Animation hooks    — name + keyframe + trigger
└── Risk notes         — anything that might break i18n / RTL /
                          accessibility / perf
```

PLUS one cross-page artifact:
```
design-system-deltas.md
├── Token additions (steel-*, cobalt-*, animation timing curves)
├── New utility classes (.bv-sheen, .bv-mesh-drift, .bv-rise, …)
├── Updated globals.css proposal (drop-in)
├── Migration plan — how to roll out without a freeze week
```

I will hand the deliverables to a single engineer (me) who will
implement them in 2-week sprints. Keep the diffs small enough that a
single PR per page makes sense.

## My non-negotiables

- The mobile app's design language is the gravity. Don't invent a
  new direction — refine the existing one.
- Don't propose anything that requires an SVG illustrator on
  retainer. Stay within reach of a single full-stack dev with
  Tailwind + CSS keyframes.
- "Animations and visual delight" the user asked for must serve the
  product, not perform for the designer. Each animation must answer
  "what state changed?" or "what's the user's next move?" — never
  decorative.

**Begin with `/dashboard`**, since that's where users spend the most
time. Produce that page in full before moving to the next.
