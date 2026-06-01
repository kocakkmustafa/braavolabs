import type { RunEvent } from "@ai-company-os/core";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/api/v1";

export interface StreamRunHandlers {
  onEvent?: (ev: RunEvent) => void;
  onError?: (err: unknown) => void;
  onDone?: () => void;
}

/**
 * Consume GET /runs/:id/stream (Server-Sent Events) via fetch + ReadableStream.
 *
 * Why not the native `EventSource`? It cannot set an `Authorization` header,
 * and our API gates the stream with Bearer-token auth. fetch lets us send the
 * token (and a Last-Event-ID on reconnect) while still parsing the SSE frame
 * format the endpoint emits.
 *
 * Returns a `stop()` function — call it on unmount to abort the request.
 */
export function streamRun(token: string, runId: string, handlers: StreamRunHandlers): () => void {
  const controller = new AbortController();
  let lastEventId = "";

  (async () => {
    try {
      const res = await fetch(`${API_BASE}/runs/${runId}/stream`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
        },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        handlers.onError?.(new Error(`Run stream failed: ${res.status}`));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line per the SSE spec.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          let eventType = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith(":")) continue; // comment / keepalive
            if (line.startsWith("id:")) lastEventId = line.slice(3).trim();
            else if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }

          if (eventType === "done") {
            handlers.onDone?.();
            controller.abort();
            return;
          }
          if (data) {
            try {
              handlers.onEvent?.(JSON.parse(data) as RunEvent);
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      }
      handlers.onDone?.();
    } catch (err) {
      if (!controller.signal.aborted) handlers.onError?.(err);
    }
  })();

  return () => controller.abort();
}
