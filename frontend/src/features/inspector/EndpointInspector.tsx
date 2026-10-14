import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MapPin, Radar } from "lucide-react";
import { extractErrorMessage, getStoredUser, normPort } from "../../api";
import {
  pingOnlySkipLabel,
  useAdoptPingOnly,
  useCredentials,
  useDevices,
  useEndpoints,
  useTopology,
} from "../../hooks/api";
import { useToast } from "../../components/ToastProvider";
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
  const canEdit = (getStoredUser()?.role ?? "viewer") !== "viewer";
  // Device and credential lists only matter for the adopt action (write users).
  const { data: devices } = useDevices();
  const { data: credentials } = useCredentials({ enabled: canEdit });
  const adoptMutation = useAdoptPingOnly();
  const { addToast } = useToast();
  // Device created by the last adopt, offered as an "Open device" link.
  // Keyed by endpoint id so the link does not leak into another endpoint's view.
  const [adopted, setAdopted] = useState<{ endpointId: number; deviceId: number } | null>(null);
  const adoptedDeviceId = adopted?.endpointId === id ? adopted.deviceId : null;

  const endpoint = useMemo(
    () => (Array.isArray(endpointsQuery.data) ? endpointsQuery.data.find((e) => e.id === id) : undefined),
    [endpointsQuery.data, id],
  );
  const nodeIdByIp = useMemo(() => {
    const map = new Map<string, number>();
    (topology?.nodes ?? []).forEach((n) => map.set(n.ip, n.id));
    return map;
  }, [topology]);
  const managedIps = useMemo(() => {
    const ips = new Set<string>();
    (topology?.nodes ?? []).forEach((n) => ips.add(n.ip));
    (Array.isArray(devices) ? devices : []).forEach((d) => ips.add(d.ip));
    return ips;
  }, [topology, devices]);
  const credentialIps = useMemo(
    () => new Set((Array.isArray(credentials) ? credentials : []).map((c) => c.ip)),
    [credentials],
  );

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

  const ip = endpoint.ip?.trim() || "";
  const adoptBlockedReason = !ip
    ? "Endpoint has no IP address"
    : managedIps.has(ip)
      ? "This IP is already a managed device"
      : credentialIps.has(ip)
        ? "A credential for this IP already exists"
        : null;

  const adopt = () => {
    if (adoptBlockedReason) return;
    const label = endpoint.hostname?.trim() || "";
    adoptMutation.mutate([label ? { ip, label } : { ip }], {
      onSuccess: (result) => {
        const created = result.created.find((c) => c.ip === ip) ?? result.created[0];
        if (created) {
          setAdopted({ endpointId: id, deviceId: created.device_id });
          addToast(`Added ${created.ip} as ping-only device`, "success");
          return;
        }
        const skipped = result.skipped[0];
        addToast(
          skipped ? `${skipped.ip}: ${pingOnlySkipLabel(skipped.reason)}` : `${ip} was not added`,
          "warning",
        );
      },
      onError: (ex) => addToast(`Failed to add ping-only device: ${extractErrorMessage(ex)}`, "error"),
    });
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
        {(firstPort || canEdit) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {firstPort && (
              <Button size="sm" variant="primary" onClick={goToPort}>
                <MapPin size={13} strokeWidth={1.75} aria-hidden="true" />
                Go to port
              </Button>
            )}
            {canEdit && adoptedDeviceId == null && (
              <span title={adoptBlockedReason ?? "Monitor this host by ping only (no SNMP)"} className="inline-flex">
                <Button
                  size="sm"
                  disabled={!!adoptBlockedReason || adoptMutation.isPending}
                  onClick={adopt}
                >
                  <Radar size={13} strokeWidth={1.75} aria-hidden="true" />
                  {adoptMutation.isPending ? "Adding..." : "Adopt as ping-only device"}
                </Button>
              </span>
            )}
            {adoptedDeviceId != null && (
              <LinkButton onClick={() => open("device", adoptedDeviceId)}>Open device</LinkButton>
            )}
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
