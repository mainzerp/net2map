import { Badge } from "../../components/ui";
import type { ServerHealth, TopologyNode, UpsHealth } from "../../types";
import { formatRelativeTime, formatTimestamp } from "../../utils/datetime";
import {
  HEALTH_STATUS_LABEL,
  clampPercent,
  conditionLabel,
  conditionTone,
  formatPercent,
  formatRuntime,
  healthOf,
  healthStatusBg,
  healthStatusTone,
  outputSourceLabel,
} from "../../utils/deviceHealth";
import { FactList, InspectorSection, type Fact } from "./parts";

// "Health" block of the device inspector: the SNMP health snapshot of a UPS
// (battery / output) or an HPE server (subsystem conditions). Hidden for
// devices without a snapshot.

function ConditionChip({ value }: { value: ServerHealth["overall"] }) {
  const label = conditionLabel(value);
  if (!label) return null;
  return (
    <Badge tone={conditionTone(value)} className="px-1.5 py-0 text-[10px]">
      {label}
    </Badge>
  );
}

function upsFacts(h: UpsHealth): Fact[] {
  const battery = h.battery_status ? h.battery_status.charAt(0).toUpperCase() + h.battery_status.slice(1) : null;
  return [
    { label: "Runtime", value: formatRuntime(h.runtime_minutes), mono: true },
    { label: "Load", value: formatPercent(h.load_percent), mono: true },
    { label: "Output", value: outputSourceLabel(h.output_source) },
    { label: "Battery", value: battery },
    {
      label: "On battery",
      value: h.seconds_on_battery ? `${Math.round(h.seconds_on_battery / 60)} min` : null,
      mono: true,
    },
    { label: "Battery temp", value: h.battery_temperature_c != null ? `${h.battery_temperature_c} C` : null, mono: true },
    { label: "Input", value: h.input_voltage != null ? `${h.input_voltage} V` : null, mono: true },
    { label: "Alarms", value: h.alarms_present ? String(h.alarms_present) : null, mono: true },
    { label: "Software", value: h.software, mono: true },
  ];
}

function serverFacts(h: ServerHealth): Fact[] {
  const temp = h.temperature_max_c != null
    ? `${h.temperature_max_c} C max${h.temperature_sensors ? ` (${h.temperature_sensors} sensors)` : ""}`
    : null;
  const chip = (value: ServerHealth["overall"]) => (value ? <ConditionChip value={value} /> : null);
  return [
    { label: "Overall", value: chip(h.overall) },
    { label: "Thermal", value: chip(h.thermal) },
    { label: "Power", value: chip(h.power_supply) },
    { label: "Fans", value: chip(h.fans) },
    { label: "Storage", value: chip(h.storage) },
    { label: "Temperature", value: temp, mono: true },
    { label: "Product", value: h.product_name },
    { label: "Serial", value: h.serial_number, mono: true },
    { label: "iLO firmware", value: h.ilo_firmware, mono: true },
  ];
}

export function DeviceHealthSection({ device }: { device: TopologyNode }) {
  const health = healthOf(device);
  if (!health) return null;
  const updated = device.health_updated_at ?? null;

  return (
    <InspectorSection
      title={health.kind === "ups" ? "UPS health" : "Server health"}
      aside={
        <Badge tone={healthStatusTone(health.status)} data-testid="health-status">
          {HEALTH_STATUS_LABEL[health.status] ?? HEALTH_STATUS_LABEL.unknown}
        </Badge>
      }
    >
      {health.kind === "ups" && health.charge_percent != null && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-muted">Battery charge</span>
            <span className="font-mono text-primary">{health.charge_percent}%</span>
          </div>
          <div
            className="h-1.5 rounded-full bg-panel-2 overflow-hidden"
            role="img"
            aria-label={`Battery charge ${health.charge_percent}%`}
          >
            <div
              className={`h-full rounded-full ${healthStatusBg(health.status)}`}
              style={{ width: `${clampPercent(health.charge_percent)}%` }}
            />
          </div>
        </div>
      )}
      <FactList facts={health.kind === "ups" ? upsFacts(health) : serverFacts(health)} />
      {updated && (
        <div className="mt-2 text-[11px] text-muted" title={formatTimestamp(updated)}>
          Updated {formatRelativeTime(updated)}
        </div>
      )}
    </InspectorSection>
  );
}
