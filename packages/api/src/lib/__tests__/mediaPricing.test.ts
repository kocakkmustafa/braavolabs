import { describe, it, expect } from "vitest";
import { estimateImage, estimateTts, IMAGE_PRICES, TTS_PRICES } from "../mediaPricing";

describe("estimateImage", () => {
  it("computes megapixel-based cost for a real image size (2× flux/dev @1024x1024)", () => {
    const e = estimateImage("fal-ai/flux/dev", 2, 1024, 1024);
    // 2 images × 1.048576 MP × $0.025/MP
    expect(e.units).toBeCloseTo(2.097152, 6);
    expect(e.usd).toBeCloseTo(0.052429, 6);
    expect(e.kind).toBe("image");
    expect(e.model).toBe("fal-ai/flux/dev");
    expect(e.estimate).toBe(true);
  });

  it("applies the 1-megapixel floor for small images (256x256)", () => {
    const e = estimateImage("fal-ai/flux/schnell", 1, 256, 256);
    // 256*256/1e6 = 0.065536 MP, floored up to 1 MP minimum.
    expect(e.units).toBe(1);
    expect(e.usd).toBeCloseTo(0.003, 6);
  });

  it("multiplies the per-image floor across n images", () => {
    const e = estimateImage("fal-ai/flux/schnell", 3, 256, 256);
    expect(e.units).toBe(3);
    expect(e.usd).toBeCloseTo(0.009, 6);
  });

  it("does not apply the floor once real megapixels exceed 1MP", () => {
    const e = estimateImage("fal-ai/flux/schnell", 1, 1536, 1024);
    // 1536*1024 = 1,572,864 → 1.572864 MP, above the 1MP floor.
    expect(e.units).toBeCloseTo(1.572864, 6);
    expect(e.usd).toBeCloseTo(1.572864 * IMAGE_PRICES["fal-ai/flux/schnell"].usdPerMegapixel, 6);
  });

  it("throws a plain Error (not AppError) for an unknown model", () => {
    expect(() => estimateImage("not-a-real-model", 1, 1024, 1024)).toThrow(Error);
    try {
      estimateImage("not-a-real-model", 1, 1024, 1024);
      throw new Error("should not reach here");
    } catch (err) {
      // AppError sets name="AppError" and carries a statusCode; a plain
      // Error thrown here has neither — confirms this lib stays HTTP-agnostic.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).not.toBe("AppError");
      expect((err as { statusCode?: number }).statusCode).toBeUndefined();
    }
  });
});

describe("estimateTts — GOOGLE_TTS voice-name tier derivation", () => {
  it("defaults to the standard tier when no voice name is given", () => {
    const e = estimateTts("GOOGLE_TTS", 1_000_000);
    expect(e.usd).toBeCloseTo(TTS_PRICES.GOOGLE_TTS.standardPerMChars, 6);
  });

  it("resolves a Neural2 voice name to the neural tier", () => {
    const e = estimateTts("GOOGLE_TTS", 500_000, "en-US-Neural2-F");
    expect(e.usd).toBeCloseTo(0.5 * TTS_PRICES.GOOGLE_TTS.neuralPerMChars, 6);
  });

  it("resolves a Wavenet voice name to the neural tier too", () => {
    const e = estimateTts("GOOGLE_TTS", 250_000, "en-US-Wavenet-D");
    expect(e.usd).toBeCloseTo(0.25 * TTS_PRICES.GOOGLE_TTS.neuralPerMChars, 6);
  });

  it("resolves a Studio voice name to the studio tier", () => {
    const e = estimateTts("GOOGLE_TTS", 100_000, "en-US-Studio-O");
    expect(e.usd).toBeCloseTo(0.1 * TTS_PRICES.GOOGLE_TTS.studioPerMChars, 6);
  });

  it("falls back to standard for an unrecognised voice name", () => {
    const e = estimateTts("GOOGLE_TTS", 1_000_000, "some-custom-voice");
    expect(e.usd).toBeCloseTo(TTS_PRICES.GOOGLE_TTS.standardPerMChars, 6);
  });
});

describe("estimateTts — ELEVENLABS per-1k-char rate", () => {
  it("charges the flat per-1k-char rate regardless of voice name", () => {
    const e = estimateTts("ELEVENLABS", 1000, "Bella");
    expect(e.usd).toBeCloseTo(TTS_PRICES.ELEVENLABS.effectivePer1kChars, 6);
  });

  it("scales linearly with character count", () => {
    const e = estimateTts("ELEVENLABS", 2500);
    expect(e.usd).toBeCloseTo(2.5 * TTS_PRICES.ELEVENLABS.effectivePer1kChars, 6);
  });
});

describe("estimateTts — rounding + unknown provider", () => {
  it("rounds to 6 decimal places like the DB Decimal(10,6) column", () => {
    const e = estimateTts("GOOGLE_TTS", 333_333);
    // 333333/1e6 * 4 = 1.333332 exactly at 6dp.
    expect(e.usd).toBe(1.333332);
  });

  it("throws a plain Error for an unknown TTS provider", () => {
    expect(() => estimateTts("NOT_A_PROVIDER" as unknown as "GOOGLE_TTS", 100)).toThrow(Error);
  });
});

describe("estimateImage / estimateTts — symmetric result shape", () => {
  it("both estimates carry the same estimate:true + usd + units + note + kind fields", () => {
    const img = estimateImage("fal-ai/flux/schnell", 1, 1024, 1024);
    const tts = estimateTts("ELEVENLABS", 1000);

    expect(img.estimate).toBe(true);
    expect(tts.estimate).toBe(true);
    expect(typeof img.usd).toBe("number");
    expect(typeof tts.usd).toBe("number");
    expect(typeof img.units).toBe("number");
    expect(typeof tts.units).toBe("number");
    expect(typeof img.note).toBe("string");
    expect(typeof tts.note).toBe("string");
    expect(img.kind).toBe("image");
    expect(tts.kind).toBe("tts");

    // Same key count, differing only in the discriminator identity field
    // (model for image, provider for tts).
    expect(Object.keys(img).sort()).toEqual(["estimate", "kind", "model", "note", "units", "usd"].sort());
    expect(Object.keys(tts).sort()).toEqual(["estimate", "kind", "provider", "note", "units", "usd"].sort());
  });
});
