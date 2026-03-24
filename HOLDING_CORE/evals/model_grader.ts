/**
 * Model-Based Eval Grader — uses Claude to evaluate agent output quality.
 *
 * Used for:
 * - Sales quality: ICP match, proposal clarity, objection handling
 * - Content quality: brand voice match, grammar, CTA clarity, platform fit
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
});

export interface GradeResult {
  passed: boolean;
  score: number; // 0-1
  feedback: string;
  criteria: Record<string, { score: number; comment: string }>;
}

/**
 * Grade sales output quality using Claude.
 */
export async function gradeSalesQuality(input: {
  output: string;
  icp?: string;
  brandVoice?: string;
}): Promise<GradeResult> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: `You are a sales quality evaluator. Grade the following sales output on a scale of 0-1.

Evaluate these criteria:
1. icp_match: Does it target the right customer profile?
2. clarity: Is the value proposition clear?
3. objection_handling: Does it preemptively address concerns?
4. no_false_promises: Are claims realistic and verifiable?
5. call_to_action: Is there a clear next step?

Output ONLY valid JSON:
{
  "passed": true/false (true if overall score >= 0.7),
  "score": 0.0-1.0,
  "feedback": "brief summary",
  "criteria": {
    "icp_match": { "score": 0.0-1.0, "comment": "..." },
    "clarity": { "score": 0.0-1.0, "comment": "..." },
    "objection_handling": { "score": 0.0-1.0, "comment": "..." },
    "no_false_promises": { "score": 0.0-1.0, "comment": "..." },
    "call_to_action": { "score": 0.0-1.0, "comment": "..." }
  }
}`,
    messages: [
      {
        role: "user",
        content: [
          `Sales Output to evaluate:\n${input.output}`,
          input.icp ? `\nTarget ICP: ${input.icp}` : "",
          input.brandVoice ? `\nBrand Voice: ${input.brandVoice}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {
      passed: false,
      score: 0,
      feedback: "Failed to parse grader response",
      criteria: {},
    };
  }
}

/**
 * Grade content quality using Claude.
 */
export async function gradeContentQuality(input: {
  content: string;
  platform: string;
  brandVoice?: string;
  language?: string;
}): Promise<GradeResult> {
  const platformLimits: Record<string, string> = {
    twitter: "280 characters",
    tiktok: "2200 characters caption, video script format",
    linkedin: "3000 characters, professional tone",
    instagram: "2200 characters caption",
  };

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: `You are a content quality evaluator. Grade the following content on a scale of 0-1.

Platform: ${input.platform}
${platformLimits[input.platform] ? `Platform limits: ${platformLimits[input.platform]}` : ""}

Evaluate these criteria:
1. brand_voice_match: Does it match the brand voice guidelines?
2. grammar_spelling: Is the grammar and spelling correct?
3. cta_clarity: Is there a clear call-to-action?
4. platform_fit: Is it appropriate for the target platform?
5. engagement_potential: Will it drive engagement?

Output ONLY valid JSON:
{
  "passed": true/false (true if overall score >= 0.7),
  "score": 0.0-1.0,
  "feedback": "brief summary",
  "criteria": {
    "brand_voice_match": { "score": 0.0-1.0, "comment": "..." },
    "grammar_spelling": { "score": 0.0-1.0, "comment": "..." },
    "cta_clarity": { "score": 0.0-1.0, "comment": "..." },
    "platform_fit": { "score": 0.0-1.0, "comment": "..." },
    "engagement_potential": { "score": 0.0-1.0, "comment": "..." }
  }
}`,
    messages: [
      {
        role: "user",
        content: [
          `Content to evaluate:\n${input.content}`,
          input.brandVoice ? `\nBrand Voice Guidelines: ${input.brandVoice}` : "",
          input.language ? `\nLanguage: ${input.language}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {
      passed: false,
      score: 0,
      feedback: "Failed to parse grader response",
      criteria: {},
    };
  }
}
