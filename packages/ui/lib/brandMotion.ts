import approved from "../public/brand/approved-motion.json" with { type: "json" };

export type MotionState = keyof typeof approved.states;

export function runMotion(status?: string | null, pendingApproval = false): MotionState {
  const key = status?.trim().toUpperCase() ?? "";
  // Only an actively running job can be interrupted by an unresolved approval.
  // Terminal, paused, queued and unknown states keep their own meaning.
  if (key === "RUNNING" && pendingApproval) return "attention";
  return Object.hasOwn(approved.runStates, key)
    ? approved.runStates[key as keyof typeof approved.runStates] as MotionState
    : "idle";
}

export function wizardMotion({ step, busy, error, session }: {
  step: string;
  busy?: boolean;
  error?: string | null;
  session?: { status?: string; companyId?: string } | null;
}): MotionState {
  // Confirmation retries keep the previous error in the existing wizard.
  // Current work and the verified response take precedence over that stale
  // message; failed confirmation returns to preview and still shows error.
  if (busy || step === "creating") return "thinking";
  if (step === "done" && session?.status === "created" && session.companyId?.trim()) return "success";
  if (error) return "error";
  return "idle";
}

export function approvalMotion(count: number, error?: string | null): MotionState {
  return error ? "error" : count > 0 ? "attention" : "idle";
}

export function motionFrames(state: MotionState) {
  return approved.states[state];
}

export function heldFrame(state: MotionState): number {
  return motionFrames(state).frames.at(-1)!;
}

interface Scheduler<T> {
  schedule: (callback: () => void, delay: number) => T;
  cancel: (handle: T) => void;
}

/** One finite gesture per state transition. Returning to a visible tab does
 * not replay a completed gesture; only the independent thinking coin loops. */
export function createGesturePlayer<T>(onFrame: (frame: number, state: MotionState) => void, clock: Scheduler<T>) {
  let current: MotionState | undefined;
  let index = 0;
  let timer: T | undefined;
  let disposed = false;
  const cancel = () => {
    if (timer !== undefined) clock.cancel(timer);
    timer = undefined;
  };
  const next = () => {
    if (!current || disposed) return;
    const sequence = motionFrames(current);
    if (index >= sequence.delays.length) return;
    timer = clock.schedule(() => {
      timer = undefined;
      if (disposed || !current) return;
      index += 1;
      onFrame(motionFrames(current).frames[index], current);
      next();
    }, sequence.delays[index]);
  };
  return {
    update(state: MotionState, animate: boolean) {
      if (disposed) return;
      const changed = state !== current;
      if (changed) {
        cancel(); current = state; index = 0;
      }
      if (!animate) {
        cancel();
        index = motionFrames(state).frames.length - 1;
        onFrame(heldFrame(state), state);
      } else if (changed) {
        onFrame(motionFrames(state).frames[0], state);
        next();
      }
    },
    dispose() { disposed = true; cancel(); },
  };
}

interface MotionSources {
  media: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">;
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  observe: (onVisible: (visible: boolean) => void) => () => void;
}

/** Wait for viewport evidence before enabling motion. The subscriber owns
 * every listener/observer and prevents stale callbacks after disposal. */
export function subscribeMotionEnvironment(sources: MotionSources, onChange: (enabled: boolean) => void) {
  let inViewport: boolean | undefined;
  let disposed = false;
  const refresh = () => {
    if (!disposed && inViewport !== undefined) {
      onChange(sources.media.matches && sources.page.visibilityState === "visible" && inViewport);
    }
  };
  sources.media.addEventListener("change", refresh);
  sources.page.addEventListener("visibilitychange", refresh);
  const disconnect = sources.observe((visible) => { inViewport = visible; refresh(); });
  return () => {
    if (disposed) return;
    disposed = true;
    sources.media.removeEventListener("change", refresh);
    sources.page.removeEventListener("visibilitychange", refresh);
    disconnect();
  };
}
