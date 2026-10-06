import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { MapPin } from "lucide-react";
import { normPort } from "../../api";
import { useEndpoints, useTopology } from "../../hooks/api";
import { searchWithInspect, useInspector } from "../../hooks/useInspector";
import useNet2MapStore from "../../store";
import { Badge, Button } from "../../components/ui";
import { formatTimestamp } from "../../utils/datetime";
import { FactList, InspectorLoading, InspectorNotFound, InspectorSection, InspectorTitle, LinkButton } from "./parts";

export default function EndpointInspector({ id, titleId }: { id: number; titleId: string }) {
  const endpointsQuery = useEndpoints();
  const { data: topology } = useTopology();
  const { open, close, raw } = useInspector();
  const navigate = useNavigate();
  const setHighlightPortKey = useNet2MapStore((s) => s.setHighlightPortKey);

  const endpoint = useMemo(
    () => (Array.isArray(endpointsQuery.data) ? endpointsQuery.data.find((e) => e.id === id) : undefined),
    [endpointsQuery.data, id],
  );
  const nodeIdByIp = useMemo(() => {
    const map = new Map<string, number>();
    (topology?.nodes ?? []).forEach((n) => map.set(n.ip, n.id));
    return map;
  }, [topology]);

  if (endpointsQuery.isLoading) return <InspectorLoading titleId={titleId} />;
  if (!endpoint) return <InspectorNotFound titleId={titleId} what="Endpoint" onClose={close} />;

  const firstPort = endpoint.found_on?.[0];

  // Same behavior as the "Found On" action in EndpointTable: highlight the
  // port and let the map select the switch's rack.
  const goToPort = () => {
    if (!firstPort) return;
    setHighlightPortKey(`${firstPort.switch_ip}:${normPort(firstPort.port_name || "")}`);
    navigate({ pathname: "/map", search: searchWithInspect({}, raw) });
  };

  return (
    <div>
      <div className="px-5 pt-4 pb-4 border-b border-line flex flex-col gap-2">
        <InspectorTitle id={titleId}>{endpoint.hostname || endpoint.mac}</InspectorTitle>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono text-muted">{endpoint.mac}</span>
          {endpoint.ip && <span className="font-mono text-muted">{endpoint.ip}</span>}
          {endpoint.ignored && <Badge tone="warning">Ignored</Badge>}
        </div>
        {firstPort && (
          <div className="flex flex-wrap gap-2 pt-1">
            <Button size="sm" variant="primary" onClick={goToPort}>
              <MapPin size={13} strokeWidth={1.75} aria-hidden="true" />
              Go to port
            </Button>
          </div>
        )}
      </div>

      <InspectorSection title="Details">
        <FactList
          facts={[
            { label: "Hostname", value: endpoint.hostname },
            { label: "IP", value: endpoint.ip, mono: true },
            { label: "MAC", value: endpoint.mac, mono: true },
            { label: "First seen", value: endpoint.first_seen ? formatTimestamp(endpoint.first_seen) : null },
            { label: "Last seen", value: endpoint.last_seen ? formatTimestamp(endpoint.last_seen) : null },
          ]}
        />
      </InspectorSection>

      {endpoint.notes && (
        <InspectorSection title="Notes">
          <p className="text-xs text-primary whitespace-pre-wrap break-words">{endpoint.notes}</p>
        </InspectorSection>
      )}

      <InspectorSection title={`Seen on (${endpoint.found_on?.length ?? 0})`}>
        {!endpoint.found_on?.length ? (
          <div className="text-xs text-muted">Not seen on any switch port</div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {endpoint.found_on.map((fo) => {
              const nodeId = nodeIdByIp.get(fo.switch_ip);
              const name = fo.switch_name || fo.switch_ip;
              return (
                <li key={`${fo.port_id}-${fo.switch_ip}`} className="flex items-center gap-2 text-xs min-w-0">
                  <span className="min-w-0 truncate">
                    {nodeId != null ? (
                      <LinkButton onClick={() => open("device", nodeId)} title={fo.switch_ip}>
                        {name}
                      </LinkButton>
                    ) : (
                      <span className="text-primary">{name}</span>
                    )}
                  </span>
                  <span className="font-mono text-[11px] text-muted shrink-0">{fo.port_name}</span>
                  {fo.vlan_id != null && (
                    <Badge tone="neutral" className="ml-auto shrink-0">
                      VLAN {fo.vlan_id}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </InspectorSection>
    </div>
  );
}
