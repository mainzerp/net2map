import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Container } from "lucide-react";
import { useTopology } from "../../hooks/api";
import { searchWithInspect, useInspector } from "../../hooks/useInspector";
import { rackHeightU } from "../racks/rackLayout";
import { Badge, Button, StatusDot } from "../../components/ui";
import { FactList, InspectorLoading, InspectorNotFound, InspectorSection, InspectorTitle, pingDotStatus, pingWord } from "./parts";

export default function RackInspector({ id, titleId }: { id: number; titleId: string }) {
  const { data, isLoading } = useTopology();
  const { open, close, raw } = useInspector();
  const navigate = useNavigate();

  const rack = useMemo(() => data?.racks.find((r) => r.id === id), [data, id]);
  // Top of the rack first (highest U), unplaced devices last.
  const devices = useMemo(
    () =>
      (data?.nodes ?? [])
        .filter((n) => n.rack_id === id)
        .sort((a, b) => {
          const ua = a.rack_u_position ?? -1;
          const ub = b.rack_u_position ?? -1;
          if (ua !== ub) return ub - ua;
          return (a.sys_name || a.ip).localeCompare(b.sys_name || b.ip);
        }),
    [data, id],
  );

  if (isLoading) return <InspectorLoading titleId={titleId} />;
  if (!rack) return <InspectorNotFound titleId={titleId} what="Rack" onClose={close} />;

  const openRackView = () =>
    navigate({ pathname: "/racks", search: searchWithInspect({ rack: String(rack.id) }, raw) });

  return (
    <div>
      <div className="px-5 pt-4 pb-4 border-b border-line flex flex-col gap-2">
        <InspectorTitle id={titleId}>{rack.label}</InspectorTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {[rack.room, rack.location].filter(Boolean).join(" / ") || "No location set"}
          <Badge tone="neutral">{rackHeightU(rack)}U</Badge>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="primary" onClick={openRackView}>
            <Container size={13} strokeWidth={1.75} aria-hidden="true" />
            Open rack view
          </Button>
        </div>
      </div>

      <InspectorSection title="Details">
        <FactList
          facts={[
            { label: "Room", value: rack.room },
            { label: "Location", value: rack.location },
            { label: "Height", value: `${rackHeightU(rack)}U` },
            { label: "Description", value: rack.description },
          ]}
        />
      </InspectorSection>

      <InspectorSection title={`Devices (${devices.length})`}>
        {devices.length === 0 ? (
          <div className="text-xs text-muted">No devices in this rack</div>
        ) : (
          <ul className="flex flex-col -mx-2">
            {devices.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => open("device", d.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-control text-left text-xs hover:bg-panel-2 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <StatusDot status={pingDotStatus(d.ping_status)} title={pingWord(d.ping_status)} />
                  <span className="min-w-0 truncate text-primary font-medium">{d.sys_name || d.hostname || d.ip}</span>
                  <span className="font-mono text-[11px] text-muted truncate">{d.ip}</span>
                  {d.rack_u_position != null && (
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">U{d.rack_u_position}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>
    </div>
  );
}
