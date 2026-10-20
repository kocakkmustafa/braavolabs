"use client";

import { useEffect } from "react";
import { browserAnalyticsBoundary, startOptionalAnalytics } from "../lib/optional-analytics";

export default function OptionalAnalytics({ domain }: { domain: string }) {
  useEffect(() => startOptionalAnalytics(domain, browserAnalyticsBoundary()), [domain]);
  return null;
}
