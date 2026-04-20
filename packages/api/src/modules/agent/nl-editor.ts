/**
 * Natural Language Agent Editor
 *
 * Rule-based system that parses natural language instructions and
 * applies configuration changes to an agent. No LLM call required.
 */

// ─── Types ────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  role: string;
  systemPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  tools: string[];
}

export interface NLEditRequest {
  instruction: string;
  currentConfig: AgentConfig;
}

export interface ConfigChange {
  field: string;
  oldValue: any;
  newValue: any;
  reason: string;
}

export interface NLEditResult {
  updatedConfig: AgentConfig;
  changes: ConfigChange[];
  summary: string;
}

// ─── Known model aliases ──────────────────────────────────

const MODEL_ALIASES: Record<string, string> = {
  "sonnet": "claude-sonnet-4-20250514",
  "claude-sonnet": "claude-sonnet-4-20250514",
  "claude-3-sonnet": "claude-3-sonnet-20240229",
  "claude-3.5-sonnet": "claude-3-5-sonnet-20241022",
  "claude-4-sonnet": "claude-sonnet-4-20250514",
  "haiku": "claude-haiku-4-20250414",
  "claude-haiku": "claude-haiku-4-20250414",
  "claude-3-haiku": "claude-3-haiku-20240307",
  "claude-3.5-haiku": "claude-3-5-haiku-20241022",
  "claude-4-haiku": "claude-haiku-4-20250414",
  "opus": "claude-opus-4-20250514",
  "claude-opus": "claude-opus-4-20250514",
  "claude-3-opus": "claude-3-opus-20240229",
  "claude-4-opus": "claude-opus-4-20250514",
  "gpt-4": "gpt-4",
  "gpt-4o": "gpt-4o",
  "gpt-3.5": "gpt-3.5-turbo",
};

// ─── Known tool names ─────────────────────────────────────

const TOOL_ALIASES: Record<string, string> = {
  "linkedin posting": "post_to_linkedin",
  "linkedin post": "post_to_linkedin",
  "linkedin": "post_to_linkedin",
  "tiktok posting": "post_to_tiktok",
  "tiktok post": "post_to_tiktok",
  "tiktok": "post_to_tiktok",
  "twitter posting": "post_to_twitter",
  "twitter post": "post_to_twitter",
  "twitter": "post_to_twitter",
  "email sending": "send_email",
  "email send": "send_email",
  "email": "send_email",
  "web search": "web_search",
  "search": "web_search",
  "generate post": "generate_post",
  "post generation": "generate_post",
  "hubspot": "hubspot_crm",
  "crm": "hubspot_crm",
  "analytics": "run_analytics",
  "schedule": "schedule_post",
  "scheduling": "schedule_post",
  "image generation": "generate_image",
  "image": "generate_image",
  "seo": "seo_analysis",
  "seo analysis": "seo_analysis",
  "content calendar": "content_calendar",
  "calendar": "content_calendar",
  "a/b testing": "ab_test",
  "ab testing": "ab_test",
  "ab test": "ab_test",
  "sentiment analysis": "sentiment_analysis",
  "sentiment": "sentiment_analysis",
  "translation": "translate",
  "translate": "translate",
  "summarize": "summarize",
  "summarization": "summarize",
};

// ─── Language names ───────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  turkish: "Turkish",
  spanish: "Spanish",
  french: "French",
  german: "German",
  italian: "Italian",
  portuguese: "Portuguese",
  dutch: "Dutch",
  russian: "Russian",
  chinese: "Chinese",
  japanese: "Japanese",
  korean: "Korean",
  arabic: "Arabic",
  hindi: "Hindi",
  english: "English",
  polish: "Polish",
  swedish: "Swedish",
  norwegian: "Norwegian",
  danish: "Danish",
  finnish: "Finnish",
  czech: "Czech",
  greek: "Greek",
  hebrew: "Hebrew",
  thai: "Thai",
  vietnamese: "Vietnamese",
  indonesian: "Indonesian",
  malay: "Malay",
  filipino: "Filipino",
  "türkçe": "Turkish",
};

// ─── Rule-based parser ────────────────────────────────────

type Rule = (instruction: string, config: AgentConfig) => ConfigChange | null;

function appendToSystemPrompt(config: AgentConfig, addition: string): string {
  const current = config.systemPrompt.trim();
  if (current.toLowerCase().includes(addition.toLowerCase())) {
    return current; // already present
  }
  return current ? `${current}\n\n${addition}` : addition;
}

const rules: Rule[] = [
  // ── Tone: formal ────────────────────────────────────────
  (inst, config) => {
    if (/\b(more\s+)?formal\b/i.test(inst) && /tone|style|voice|formal/i.test(inst) || /make.*formal/i.test(inst) || /\bmore formal\b/i.test(inst)) {
      const addition = "TONE INSTRUCTION: Use a formal, professional tone. Avoid slang, contractions, and colloquialisms. Prefer precise, structured language.";
      return {
        field: "systemPrompt",
        oldValue: config.systemPrompt,
        newValue: appendToSystemPrompt(config, addition),
        reason: "Added formal tone instruction to system prompt",
      };
    }
    return null;
  },

  // ── Tone: casual ────────────────────────────────────────
  (inst, config) => {
    if (/\b(more\s+)?casual\b/i.test(inst) || /\b(more\s+)?friendly\b/i.test(inst) || /\b(more\s+)?conversational\b/i.test(inst)) {
      const addition = "TONE INSTRUCTION: Use a casual, friendly, conversational tone. Feel free to use contractions and everyday language.";
      return {
        field: "systemPrompt",
        oldValue: config.systemPrompt,
        newValue: appendToSystemPrompt(config, addition),
        reason: "Added casual/friendly tone instruction to system prompt",
      };
    }
    return null;
  },

  // ── Tone: humorous ──────────────────────────────────────
  (inst, config) => {
    if (/\b(more\s+)?humor(ous)?\b/i.test(inst) || /\b(more\s+)?funny\b/i.test(inst) || /\b(more\s+)?witty\b/i.test(inst)) {
      const addition = "TONE INSTRUCTION: Be witty and humorous. Include clever observations, wordplay, and lighthearted humor where appropriate.";
      return {
        field: "systemPrompt",
        oldValue: config.systemPrompt,
        newValue: appendToSystemPrompt(config, addition),
        reason: "Added humorous tone instruction to system prompt",
      };
    }
    return null;
  },

  // ── Conciseness ─────────────────────────────────────────
  (inst, config) => {
    if (/\b(more\s+)?(concise|brief|shorter|succinct|terse)\b/i.test(inst)) {
      const addition = "STYLE INSTRUCTION: Be concise and to the point. Avoid unnecessary filler words. Keep responses brief and impactful.";
      return {
        field: "systemPrompt",
        oldValue: config.systemPrompt,
        newValue: appendToSystemPrompt(config, addition),
        reason: "Added conciseness instruction to system prompt",
      };
    }
    return null;
  },

  // ── Verbose / detailed ──────────────────────────────────
  (inst, config) => {
    if (/\b(more\s+)?(verbose|detailed|thorough|elaborate|comprehensive)\b/i.test(inst)) {
      const addition = "STYLE INSTRUCTION: Be thorough and detailed in your responses. Provide comprehensive explanations, examples, and context.";
      return {
        field: "systemPrompt",
        oldValue: config.systemPrompt,
        newValue: appendToSystemPrompt(config, addition),
        reason: "Added verbosity/detail instruction to system prompt",
      };
    }
    return null;
  },

  // ── Creativity → temperature up ─────────────────────────
  (inst, config) => {
    if (/\b(more\s+)?creativ(e|ity)\b/i.test(inst) || /\b(more\s+)?imaginativ(e|ity)\b/i.test(inst)) {
      const newTemp = Math.min(1.0, config.temperature + 0.2);
      if (newTemp === config.temperature) return null;
      return {
        field: "temperature",
        oldValue: config.temperature,
        newValue: parseFloat(newTemp.toFixed(2)),
        reason: "Increased temperature for more creative outputs",
      };
    }
    return null;
  },

  // ── Precision → temperature down ────────────────────────
  (inst, config) => {
    if (/\b(more\s+)?(precise|accurate|deterministic|consistent|reliable|predictable)\b/i.test(inst)) {
      const newTemp = Math.max(0, config.temperature - 0.2);
      if (newTemp === config.temperature) return null;
      return {
        field: "temperature",
        oldValue: config.temperature,
        newValue: parseFloat(newTemp.toFixed(2)),
        reason: "Decreased temperature for more precise/consistent outputs",
      };
    }
    return null;
  },

  // ── Set temperature directly ────────────────────────────
  (inst, config) => {
    const match = inst.match(/(?:set\s+)?temperature\s+(?:to\s+)?(\d+(?:\.\d+)?)/i);
    if (match) {
      const val = parseFloat(match[1]);
      if (val < 0 || val > 2) return null;
      return {
        field: "temperature",
        oldValue: config.temperature,
        newValue: val,
        reason: `Set temperature to ${val}`,
      };
    }
    return null;
  },

  // ── Model change ────────────────────────────────────────
  (inst, config) => {
    const match = inst.match(/(?:change|switch|set|use)\s+(?:the\s+)?(?:model\s+)?(?:to\s+)?([a-z0-9._-]+(?:\s+[a-z0-9._-]+)?)/i);
    if (!match) return null;

    const requested = match[1].trim().toLowerCase();
    // Try alias first, then use raw value
    const resolvedModel = MODEL_ALIASES[requested] || null;

    // Also try matching if the whole instruction mentions a known model
    if (!resolvedModel) {
      for (const [alias, modelId] of Object.entries(MODEL_ALIASES)) {
        if (inst.toLowerCase().includes(alias)) {
          if (modelId === config.model) return null;
          return {
            field: "model",
            oldValue: config.model,
            newValue: modelId,
            reason: `Changed model to ${modelId} (matched alias "${alias}")`,
          };
        }
      }
      return null;
    }

    if (resolvedModel === config.model) return null;
    return {
      field: "model",
      oldValue: config.model,
      newValue: resolvedModel,
      reason: `Changed model to ${resolvedModel}`,
    };
  },

  // ── Add tool ────────────────────────────────────────────
  (inst, config) => {
    const match = inst.match(/\badd\s+(?:the\s+)?(?:a\s+)?(.+?)(?:\s+tool)?$/i);
    if (!match) return null;

    const requested = match[1].trim().toLowerCase();
    // Check aliases
    const toolName = TOOL_ALIASES[requested] || requested.replace(/\s+/g, "_");

    if (config.tools.includes(toolName)) return null;
    return {
      field: "tools",
      oldValue: [...config.tools],
      newValue: [...config.tools, toolName],
      reason: `Added "${toolName}" to the tools list`,
    };
  },

  // ── Remove tool ─────────────────────────────────────────
  (inst, config) => {
    const match = inst.match(/\b(?:remove|delete|disable)\s+(?:the\s+)?(?:a\s+)?(.+?)(?:\s+tool)?$/i);
    if (!match) return null;

    const requested = match[1].trim().toLowerCase();
    const toolName = TOOL_ALIASES[requested] || requested.replace(/\s+/g, "_");

    // Try exact match first, then fuzzy
    let idx = config.tools.indexOf(toolName);
    if (idx === -1) {
      idx = config.tools.findIndex((t) => t.toLowerCase().includes(requested.replace(/\s+/g, "_")));
    }
    if (idx === -1) return null;

    const removed = config.tools[idx];
    const newTools = config.tools.filter((_, i) => i !== idx);
    return {
      field: "tools",
      oldValue: [...config.tools],
      newValue: newTools,
      reason: `Removed "${removed}" from the tools list`,
    };
  },

  // ── Increase max tokens ─────────────────────────────────
  (inst, config) => {
    const directMatch = inst.match(/(?:set\s+)?(?:max[_\s]?tokens|token\s+limit)\s+(?:to\s+)?(\d+)/i);
    if (directMatch) {
      const val = parseInt(directMatch[1], 10);
      if (val < 100 || val > 200000) return null;
      return {
        field: "maxTokens",
        oldValue: config.maxTokens,
        newValue: val,
        reason: `Set max tokens to ${val}`,
      };
    }

    if (/\bincrease\s+(?:the\s+)?(?:max[_\s]?tokens|token\s+limit|output\s+length)\b/i.test(inst)) {
      const newVal = Math.min(200000, Math.round(config.maxTokens * 1.5));
      return {
        field: "maxTokens",
        oldValue: config.maxTokens,
        newValue: newVal,
        reason: `Increased max tokens by 50% (${config.maxTokens} → ${newVal})`,
      };
    }

    if (/\bdecrease\s+(?:the\s+)?(?:max[_\s]?tokens|token\s+limit|output\s+length)\b/i.test(inst) || /\breduce\s+(?:the\s+)?(?:max[_\s]?tokens|token\s+limit|output\s+length)\b/i.test(inst)) {
      const newVal = Math.max(256, Math.round(config.maxTokens * 0.67));
      return {
        field: "maxTokens",
        oldValue: config.maxTokens,
        newValue: newVal,
        reason: `Decreased max tokens by ~33% (${config.maxTokens} → ${newVal})`,
      };
    }

    return null;
  },

  // ── Rename agent ────────────────────────────────────────
  (inst, config) => {
    const match = inst.match(/\b(?:rename|change\s+(?:the\s+)?name)\s+(?:to\s+)?["']?([^"']+?)["']?\s*$/i);
    if (!match) return null;
    const newName = match[1].trim();
    if (!newName || newName === config.name) return null;
    return {
      field: "name",
      oldValue: config.name,
      newValue: newName,
      reason: `Renamed agent to "${newName}"`,
    };
  },

  // ── Change role ─────────────────────────────────────────
  (inst, config) => {
    const match = inst.match(/\b(?:change|set)\s+(?:the\s+)?role\s+(?:to\s+)?["']?([^"']+?)["']?\s*$/i);
    if (!match) return null;
    const newRole = match[1].trim();
    if (!newRole || newRole === config.role) return null;
    return {
      field: "role",
      oldValue: config.role,
      newValue: newRole,
      reason: `Changed role to "${newRole}"`,
    };
  },

  // ── Language instruction ────────────────────────────────
  (inst, config) => {
    const match = inst.match(/\b(?:respond|reply|write|speak|output)\s+(?:in\s+)?(\w+)\b/i);
    if (!match) return null;
    const langKey = match[1].toLowerCase();
    const language = LANGUAGE_MAP[langKey];
    if (!language) return null;

    const addition = `LANGUAGE INSTRUCTION: Always respond in ${language}.`;
    return {
      field: "systemPrompt",
      oldValue: config.systemPrompt,
      newValue: appendToSystemPrompt(config, addition),
      reason: `Added instruction to respond in ${language}`,
    };
  },

  // ── Add custom system prompt instruction ────────────────
  (inst, config) => {
    const match = inst.match(/\b(?:add|append)\s+(?:to\s+)?(?:system\s+)?(?:prompt|instruction)[:\s]+["']?(.+?)["']?\s*$/i);
    if (!match) return null;
    const addition = match[1].trim();
    return {
      field: "systemPrompt",
      oldValue: config.systemPrompt,
      newValue: appendToSystemPrompt(config, addition),
      reason: `Appended custom instruction to system prompt`,
    };
  },

  // ── Replace system prompt entirely ──────────────────────
  (inst, config) => {
    const match = inst.match(/\b(?:set|replace)\s+(?:the\s+)?(?:system\s+)?prompt\s+(?:to|with)\s+["'](.+?)["']\s*$/i);
    if (!match) return null;
    return {
      field: "systemPrompt",
      oldValue: config.systemPrompt,
      newValue: match[1].trim(),
      reason: "Replaced system prompt entirely",
    };
  },

  // ── Emoji usage ─────────────────────────────────────────
  (inst, config) => {
    if (/\b(?:use|add|include)\s+(?:more\s+)?emojis?\b/i.test(inst)) {
      const addition = "STYLE INSTRUCTION: Use emojis liberally to make content more engaging and visually appealing.";
      return {
        field: "systemPrompt",
        oldValue: config.systemPrompt,
        newValue: appendToSystemPrompt(config, addition),
        reason: "Added emoji usage instruction to system prompt",
      };
    }
    if (/\b(?:no|remove|stop|disable|don'?t\s+use)\s+emojis?\b/i.test(inst)) {
      const addition = "STYLE INSTRUCTION: Do not use emojis in your output.";
      return {
        field: "systemPrompt",
        oldValue: config.systemPrompt,
        newValue: appendToSystemPrompt(config, addition),
        reason: "Added no-emoji instruction to system prompt",
      };
    }
    return null;
  },

  // ── Hashtag behavior ────────────────────────────────────
  (inst, config) => {
    if (/\b(?:more|add|include|use)\s+hashtags?\b/i.test(inst)) {
      const addition = "STYLE INSTRUCTION: Include relevant hashtags in social media posts. Use 5-10 targeted hashtags.";
      return {
        field: "systemPrompt",
        oldValue: config.systemPrompt,
        newValue: appendToSystemPrompt(config, addition),
        reason: "Added hashtag instruction to system prompt",
      };
    }
    if (/\b(?:fewer|less|no|remove|reduce)\s+hashtags?\b/i.test(inst)) {
      const addition = "STYLE INSTRUCTION: Minimize hashtag usage. Use at most 2-3 hashtags, or none if not essential.";
      return {
        field: "systemPrompt",
        oldValue: config.systemPrompt,
        newValue: appendToSystemPrompt(config, addition),
        reason: "Added reduced hashtag instruction to system prompt",
      };
    }
    return null;
  },
];

// ─── Main export ──────────────────────────────────────────

export function applyNaturalLanguageEdit(req: NLEditRequest): NLEditResult {
  const { instruction, currentConfig } = req;
  const normalizedInstruction = instruction.trim();

  if (!normalizedInstruction) {
    return {
      updatedConfig: { ...currentConfig },
      changes: [],
      summary: "No instruction provided — no changes made.",
    };
  }

  const changes: ConfigChange[] = [];
  let config: AgentConfig = { ...currentConfig, tools: [...currentConfig.tools] };

  for (const rule of rules) {
    const change = rule(normalizedInstruction, config);
    if (change) {
      changes.push(change);
      // Apply the change to the running config so subsequent rules see updated state
      (config as any)[change.field] = change.newValue;
    }
  }

  if (changes.length === 0) {
    return {
      updatedConfig: config,
      changes: [],
      summary: `Could not interpret instruction: "${normalizedInstruction}". Try commands like "make the tone more formal", "add LinkedIn posting tool", "use sonnet", "set temperature to 0.5", or "respond in Turkish".`,
    };
  }

  const summary = changes.length === 1
    ? changes[0].reason
    : `Applied ${changes.length} changes: ${changes.map((c) => c.reason).join("; ")}`;

  return {
    updatedConfig: config,
    changes,
    summary,
  };
}
