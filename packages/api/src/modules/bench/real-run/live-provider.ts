/**
 * LIVE provider adapter (BRA-P1-05-N3): reuses the existing provider
 * abstraction (`services/ai-client` `chatCompletion`); no new HTTP client.
 * Loaded ONLY by the CLI in `--live` mode (dynamic import), never by tests.
 * The key is read from the environment at call time and handed straight to
 * the client; it is never logged, stored or put in a report.
 */
import { chatCompletion, type AIClientConfig } from "../../../services/ai-client";
import { keyEnvName } from "./guards";
import type { ProviderCall } from "./runner";

export function makeLiveProvider(env: Record<string, string | undefined>): ProviderCall {
  return async (req) => {
    const name = keyEnvName(req.provider, env);
    if (!name) throw new Error("no key");
    const config = {
      provider: req.provider,
      model: req.model,
      apiKey: env[name] as string,
    } as AIClientConfig;
    const res = await chatCompletion(config, req.system, [{ role: "user", content: req.prompt }], req.maxTokens);
    return { content: res.content, inputTokens: res.inputTokens, outputTokens: res.outputTokens };
  };
}
