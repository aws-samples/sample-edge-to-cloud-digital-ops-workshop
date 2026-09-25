"use client";

import { useCallback, useRef, useState } from "react";

// Bounded client-side ring buffer for time-series chart data (#270). The
// freshness/latency panels already have live values streaming in via the
// existing SSE/poll hooks in page.tsx — this hook just retains the last
// ~10 minutes of them so a chart can plot a trend instead of only the latest
// instantaneous value. Deliberately NOT a server-side history table (see the
// design doc's decisions table): a bounded browser-tab buffer is enough for a
// live A/B load demo and needs zero new storage.
export const RING_BUFFER_MAX_POINTS = 600; // ~10 min at ~1 point/sec

export function useTimeseriesBuffer<T extends object>(
  maxPoints: number = RING_BUFFER_MAX_POINTS
) {
  const [points, setPoints] = useState<Array<T & { t: number }>>([]);
  const lastPushedAtRef = useRef(0);

  // `minIntervalMs` throttles how often a point is retained — the freshness/
  // latency source hooks can update far more than once a second (RW/TSDB push
  // on every change), and packing every one of those into the buffer would
  // burn through the ~600-point window in well under 10 minutes.
  const push = useCallback(
    (value: T, opts?: { minIntervalMs?: number }) => {
      const now = Date.now();
      const minInterval = opts?.minIntervalMs ?? 0;
      if (now - lastPushedAtRef.current < minInterval) return;
      lastPushedAtRef.current = now;
      setPoints((prev) => {
        const next = [...prev, { ...value, t: now }];
        return next.length > maxPoints ? next.slice(next.length - maxPoints) : next;
      });
    },
    [maxPoints]
  );

  return { points, push };
}
