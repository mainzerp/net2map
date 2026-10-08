/**
 * Pure latency helpers: formatting, status ranking and tone mapping, the
 * topology edge classification, summary normalization and settings ranges.
 */
import { describe, it, expect } from "vitest";
import {
  formatMs,
  formatPct,
  worstStatus,
  isProblemStatus,
  latencyBadgeTone,
  latencyEdgeTone,
  latencySparklineTone,
  latencyStatusLabel,
} from "../features/latency/latency";
import { classifyAggregatedLatency } from "../features/topology/overlays";
import { latencyRefetchMs, normalizeLatencySummary } from "../hooks/api/useLatency";
import { rangeError, LATENCY_LIMITS } from "../components/settings/scan/LatencyMonitorConfig";
import type { LatencyDevice, LatencyStatus, TopologyLink, TopologyNode } from "../types";

describe("formatMs / formatPct", () => {
  it("formats milliseconds with one decimal below 10 ms", () => {
    expect(formatMs(0.42)).toBe("0.4 ms");
    expect(formatMs(3)).toBe("3.0 ms");
    expect(formatMs(12.4)).toBe("12 ms");
    expect(formatMs(150.6)).toBe("151 ms");
    expect(formatMs(null)).toBe("--");
    expect(formatMs(undefined)).toBe("--");
    expect(formatMs(Number.NaN)).toBe("--");
  });

  it("formats percentages", () => {
    expect(formatPct(0)).toBe("0 %");
    expect(formatPct(2.54)).toBe("2.5 %");
    expect(formatPct(100)).toBe("100 %");
    expect(formatPct(null)).toBe("--");
  });
});

describe("status helpers", () => {
  it("worstStatus ranks down > loss > degraded > ok > unknown", () => {
    expect(worstStatus("ok", "degraded")).toBe("degraded");
    expect(worstStatus("loss", "degraded")).toBe("loss");
    expect(worstStatus("down", "loss")).toBe("down");
    expect(worstStatus("unknown", "ok")).toBe("ok");
    expect(worstStatus("ok", "unknown")).toBe("ok");
    expect(worstStatus("unknown", "unknown")).toBe("unknown");
  });

  it("maps statuses to tones and labels", () => {
    const all: LatencyStatus[] = ["ok", "degraded", "loss", "down", "unknown"];
    expect(all.map(latencyBadgeTone)).toEqual(["success", "warning", "warning", "danger", "neutral"]);
    expect(all.map(latencyEdgeTone)).toEqual(["success", "warning", "warning", "danger", null]);
    expect(all.map(latencySparklineTone)).toEqual(["ok", "warning", "warning", "danger", "neutral"]);
    expect(all.map(isProblemStatus)).toEqual([false, true, true, true, false]);
    expect(latencyStatusLabel("loss")).toBe("Packet loss");
  });
});

function node(id: number, ip: string): TopologyNode {
  return { id, ip } as unknown as TopologyNode;
}

function lat(id: number, status: LatencyStatus, rtt: number | null): LatencyDevice {
  return {
    device_id: id, name: `sw${id}`, ip: "", rtt_ms: rtt, jitter_ms: null, loss_pct: null,
    baseline_ms: null, status, updated_at: null,
  };
}

function link(a: string, b: string): TopologyLink {
  return {
    id: 1, local_ip: a, local_port: "1", remote_ip: b, remote_port: "1", local_sys_name: "", remote_sys_name: "",
  };
}

describe("classifyAggregatedLatency (edge tint)", () => {
  const nodesByIp = new Map([
    ["10.0.0.1", node(1, "10.0.0.1")],
    ["10.0.0.2", node(2, "10.0.0.2")],
    ["10.0.0.3", node(3, "10.0.0.3")],
  ]);

  it("uses the worst endpoint status and the highest endpoint RTT", () => {
    const byId = new Map([[1, lat(1, "ok", 0.8)], [2, lat(2, "degraded", 14.2)]]);
    const result = classifyAggregatedLatency({ individual: [link("10.0.0.1", "10.0.0.2")] }, nodesByIp, byId);
    expect(result).toEqual({ status: "degraded", rttMs: 14.2, tone: "warning", label: "14 ms" });
  });

  it("considers every member link of an aggregated edge", () => {
    const byId = new Map([[1, lat(1, "ok", 1)], [2, lat(2, "ok", 2)], [3, lat(3, "down", null)]]);
    const result = classifyAggregatedLatency(
      { individual: [link("10.0.0.1", "10.0.0.2"), link("10.0.0.1", "10.0.0.3")] },
      nodesByIp,
      byId,
    );
    expect(result.status).toBe("down");
    expect(result.tone).toBe("danger");
    expect(result.label).toBe("2.0 ms");
  });

  it("keeps the default look without latency data", () => {
    const result = classifyAggregatedLatency({ individual: [link("10.0.0.1", "10.0.0.9")] }, nodesByIp, new Map());
    expect(result).toEqual({ status: "unknown", rttMs: null, tone: null, label: null });
  });
});

describe("latency data hooks helpers", () => {
  it("clamps the summary poll interval to at least 5 s", () => {
    expect(latencyRefetchMs(undefined)).toBe(10_000);
    expect(latencyRefetchMs(2)).toBe(5_000);
    expect(latencyRefetchMs(30)).toBe(30_000);
  });

  it("normalizes malformed summaries to a safe disabled shape", () => {
    const s = normalizeLatencySummary([]);
    expect(s.enabled).toBe(false);
    expect(s.devices).toEqual([]);
    expect(s.network.targets).toBe(0);
    const t = normalizeLatencySummary({ enabled: true, devices: [{ device_id: 4, status: "weird" }, { name: "x" }] });
    expect(t.devices).toHaveLength(1);
    expect(t.devices[0].status).toBe("unknown");
  });
});

describe("latency settings validation", () => {
  it("accepts whole numbers inside the range only", () => {
    expect(rangeError("10", LATENCY_LIMITS.interval)).toBeNull();
    expect(rangeError("4", LATENCY_LIMITS.interval)).toMatch(/5 to 300/);
    expect(rangeError("301", LATENCY_LIMITS.interval)).not.toBeNull();
    expect(rangeError("2.5", LATENCY_LIMITS.pings)).not.toBeNull();
    expect(rangeError("", LATENCY_LIMITS.retention)).not.toBeNull();
    expect(rangeError("365", LATENCY_LIMITS.retention)).toBeNull();
  });
});
