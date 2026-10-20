/** One deadline covers headers, body and authentication replay. No mutation is retried on timeout. */
export class RequestTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  constructor() {
    super("Request timed out. Its result may be unknown; check the status before retrying.");
    this.name = "RequestTimeoutError";
  }
}

export function requestDeadline(timeoutMs: number, caller?: AbortSignal | null) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("A positive finite request deadline is required");
  const controller = new AbortController();
  const abort = () => controller.abort(caller?.reason ?? new Error("Request cancelled"));
  if (caller?.aborted) abort();
  else caller?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new RequestTimeoutError()), timeoutMs);
  function wait<T>(pending: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const stopped = () => { cleanup(); reject(controller.signal.reason); };
      const cleanup = () => controller.signal.removeEventListener("abort", stopped);
      // Attach a rejection handler even when already aborted: a transport can
      // reject after the caller has left, and must not become unhandled.
      pending.then(value => { cleanup(); controller.signal.aborted ? stopped() : resolve(value); },
        error => { cleanup(); reject(controller.signal.aborted ? controller.signal.reason : error); });
      if (controller.signal.aborted) stopped();
      else controller.signal.addEventListener("abort", stopped, { once: true });
    });
  }
  return {
    signal: controller.signal, wait,
    assertActive() { if (controller.signal.aborted) throw controller.signal.reason; },
    dispose() { clearTimeout(timer); caller?.removeEventListener("abort", abort); },
  };
}
