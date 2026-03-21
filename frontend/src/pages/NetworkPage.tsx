import DeviceTable from "../components/DeviceTable";

export default function NetworkPage() {
  return (
    <DeviceTable
      title="Network"
      subtitle="Managed network equipment (switches, routers, firewalls)"
      activeLabel="ACTIVE NETWORK DEVICES"
      ignoredLabel="IGNORED NETWORK DEVICES"
      emptyMessage="No network devices discovered yet"
    />
  );
}
