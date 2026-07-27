// --8<-- [start:relay-lag-route]
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// The edge → cloud relay is a Redpanda Connect `kafka_franz` consumer group
// (relay-group-<deploymentId>) reading `sensors.raw.sim` from the edge Redpanda
// and writing to cloud MSK. When the WAN link to MSK drops, the relay stops
// committing offsets, so its consumer-group lag climbs — that growing backlog is
// exactly the network-failure signal this card visualises.
//
// Redpanda publishes per-partition consumer-group offsets on the Admin API's
// Prometheus endpoint (default :9644/public_metrics). There is no pre-computed
// lag metric, so we derive it: lag = log_end_offset − committed_offset, summed
// across partitions. See the Redpanda public-metrics reference:
// https://docs.redpanda.com/streaming/current/reference/public-metrics-reference/

// The Admin API base URL of any edge Redpanda broker. Defaults to the same
// StatefulSet pod the relay seeds from (edge-stack-0.edge-stack.<ns>) — override
// via REDPANDA_ADMIN_URL when the release name or namespace differs.
const ADMIN_URL =
  process.env.REDPANDA_ADMIN_URL ??
  "http://edge-stack-0.edge-stack.default.svc.cluster.local:9644";

// Which consumer group / topic the relay uses. The group is suffixed with the
// deployment id (see rp-connect-relay-config.yaml), so we match by prefix.
const GROUP_PREFIX = process.env.RELAY_CONSUMER_GROUP ?? "relay-group";
const RELAY_TOPIC = process.env.RELAY_TOPIC ?? "sensors.raw.sim";

const COMMITTED = "redpanda_kafka_consumer_group_committed_offset";
const LOG_END = "redpanda_kafka_consumer_group_log_end_offset";

export interface RelayLagStat {
  group: string;
  topic: string;
  committed: number;
  logEnd: number;
  backlog: number; // records the relay has not yet forwarded to MSK
  partitions: number;
}

export interface RelayLagResponse {
  streams: RelayLagStat[];
  scrapedAt: number;
  queryDurationMs: number;
  error?: string;
}

// Parse one Prometheus text line's `{a="1",b="2"}` label block into a map.
function parseLabels(block: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    labels[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return labels;
}

/**
 * GET /api/relay-lag
 *
 * Scrapes the edge Redpanda Admin API's Prometheus endpoint, computes the
 * relay consumer group's backlog (records not yet forwarded to cloud MSK),
 * summed per group+topic across all partitions.
 */
export async function GET(): Promise<NextResponse> {
  const t0 = Date.now();

  try {
    // Short timeout: the metrics endpoint is local and cheap, and a slow scrape
    // must not stall the 30 s HMI poll.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    let text: string;
    try {
      const res = await fetch(`${ADMIN_URL}/public_metrics`, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${ADMIN_URL}/public_metrics`);
      text = await res.text();
    } finally {
      clearTimeout(timeout);
    }

    // Accumulate committed + log-end offsets keyed by group|topic (summed over
    // partitions), tracking how many partitions contributed.
    type Acc = { committed: number; logEnd: number; parts: Set<string> };
    const byStream = new Map<string, Acc>();

    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      let metric: typeof COMMITTED | typeof LOG_END;
      if (line.startsWith(COMMITTED)) metric = COMMITTED;
      else if (line.startsWith(LOG_END)) metric = LOG_END;
      else continue;

      const braceStart = line.indexOf("{");
      const braceEnd = line.indexOf("}");
      if (braceStart < 0 || braceEnd < 0) continue;

      const labels = parseLabels(line.slice(braceStart + 1, braceEnd));
      const group = labels.redpanda_group;
      const topic = labels.redpanda_topic;
      const partition = labels.redpanda_partition ?? "?";
      if (!group || !group.startsWith(GROUP_PREFIX)) continue;
      if (RELAY_TOPIC && topic !== RELAY_TOPIC) continue;

      const value = parseFloat(line.slice(braceEnd + 1).trim());
      if (!Number.isFinite(value)) continue;

      const key = `${group}|${topic}`;
      let acc = byStream.get(key);
      if (!acc) {
        acc = { committed: 0, logEnd: 0, parts: new Set() };
        byStream.set(key, acc);
      }
      acc.parts.add(partition);
      if (metric === COMMITTED) acc.committed += value;
      else acc.logEnd += value;
    }

    const streams: RelayLagStat[] = Array.from(byStream.entries())
      .map(([key, acc]) => {
        const [group, topic] = key.split("|");
        // Clamp at 0: log-end and committed are scraped independently, so a
        // race can momentarily make committed the larger of the two.
        const backlog = Math.max(0, acc.logEnd - acc.committed);
        return {
          group,
          topic,
          committed: acc.committed,
          logEnd: acc.logEnd,
          backlog,
          partitions: acc.parts.size,
        };
      })
      .sort((a, b) => a.group.localeCompare(b.group));

    return NextResponse.json(
      { streams, scrapedAt: Date.now(), queryDurationMs: Date.now() - t0 },
      { status: 200 }
    );
  } catch (err) {
    console.error("[relay-lag] scrape error:", err);
    return NextResponse.json(
      {
        error: String(err),
        streams: [],
        scrapedAt: Date.now(),
        queryDurationMs: Date.now() - t0,
      },
      { status: 500 }
    );
  }
}
// --8<-- [end:relay-lag-route]
