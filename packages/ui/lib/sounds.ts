"use client";

/**
 * Minimal UI sound system using Web Audio API.
 * Generates synthetic sounds — no external files needed.
 */

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioCtx;
}

function play(frequency: number, duration: number, type: OscillatorType = "sine", volume = 0.06) {
  try {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(frequency * 1.5, ctx.currentTime + duration);

    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {
    // Silently fail if audio is blocked
  }
}

export const sounds = {
  /** Subtle click — nav, button press */
  click: () => play(800, 0.06, "sine", 0.04),

  /** Hover — very subtle */
  hover: () => play(600, 0.04, "sine", 0.02),

  /** Success — two ascending tones */
  success: () => {
    play(523, 0.12, "sine", 0.05);
    setTimeout(() => play(659, 0.15, "sine", 0.05), 80);
  },

  /** Error — descending tone */
  error: () => play(300, 0.2, "triangle", 0.05),

  /** Notification — bright ping */
  notify: () => {
    play(880, 0.08, "sine", 0.04);
    setTimeout(() => play(1100, 0.12, "sine", 0.03), 60);
  },

  /** Build/create — rising sweep */
  build: () => {
    play(400, 0.15, "sine", 0.04);
    setTimeout(() => play(600, 0.12, "sine", 0.04), 100);
    setTimeout(() => play(800, 0.15, "sine", 0.05), 200);
  },

  /** Ambient — soft drone for background */
  ambient: () => play(200, 0.5, "sine", 0.01),
};
