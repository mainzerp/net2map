import DeviceTable from "../components/DeviceTable";

export default function DevicesPage() {
  return (
    <DeviceTable
      role="endpoint"
      title="Devices"
      subtitle="End devices discovered on the network (not managed switches)"
      activeLabel="ACTIVE ENDPOINTS"
      ignoredLabel="IGNORED ENDPOINTS"
      emptyMessage="No endpoint devices discovered yet"
    />
  );
}
