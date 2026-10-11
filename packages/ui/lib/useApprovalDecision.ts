import { useCallback, useEffect, useMemo, useRef } from "react";
import { parseApprovalDecision, type ApprovalDecision } from "./approvalDecision";

interface Options<Session> {
  scopeKey: string | number;
  captureSession: () => Session;
  isSessionCurrent: (session: Session) => boolean;
  request: (id: string, decision: ApprovalDecision) => Promise<{ ran: false } | { ran: true; result: unknown }>;
  onBusy?: (id: string, busy: boolean) => void;
  onCommit: (id: string) => void;
  onSuccess?: (decision: ApprovalDecision) => void;
  onBlocked: (reason?: string) => void;
  onError: (error: unknown) => void;
}

/** One submission per committed card; feedback belongs to the mounted session. */
export function useApprovalDecision<Session>(options: Options<Session>) {
  const latest = useRef(options);
  latest.current = options;
  const scope = useMemo(() => ({
    owner: options.captureSession(), active: false,
    inFlight: new Set<string>(), settled: new Set<string>(),
  }), [options.scopeKey, options.captureSession]);
  useEffect(() => {
    scope.active = true;
    return () => { scope.active = false; };
  }, [scope]);

  return useCallback(async (id: string, decision: ApprovalDecision) => {
    const callbacks = latest.current;
    const current = () => scope.active && callbacks.isSessionCurrent(scope.owner);
    if (!current() || scope.inFlight.has(id) || scope.settled.has(id)) return;
    scope.inFlight.add(id);
    callbacks.onBusy?.(id, true);
    try {
      const response = await callbacks.request(id, decision);
      if (!response.ran) return;
      const outcome = parseApprovalDecision(response.result, decision);
      // A committed decision must never be submitted again, including claimFailed.
      scope.settled.add(id);
      if (!current()) return;
      callbacks.onCommit(id);
      if (outcome.claimFailed) callbacks.onBlocked(outcome.error);
      else callbacks.onSuccess?.(decision);
    } catch (error) {
      if (current()) callbacks.onError(error);
    } finally {
      scope.inFlight.delete(id);
      if (current()) callbacks.onBusy?.(id, false);
    }
  }, [scope]);
}
