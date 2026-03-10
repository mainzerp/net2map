import DeviceTable from "../components/DeviceTable.jsx";

export default function NetworkPage() {
  return (
    <DeviceTable
      role="network"
      title="Network"
      subtitle="Managed network equipment (switches, routers, firewalls)"
      activeLabel="ACTIVE NETWORK DEVICES"
      ignoredLabel="IGNORED NETWORK DEVICES"
      emptyMessage="No network devices discovered yet"
    />
  );
}