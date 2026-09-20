import { Card } from "../ui";
import { SectionHeader } from "./shared";
import ScanEngineConfig from "./scan/ScanEngineConfig";
import DiscoveryRanges from "./scan/DiscoveryRanges";
import DryRunPanel from "./scan/DryRunPanel";
import ScanRunHistory from "./scan/ScanRunHistory";

// ── EngineTabContent (orchestrator) ──────────────────────────────────────────
function EngineTabContent() {
  return (
    <div className="flex-1 overflow-y-auto pt-5 flex flex-col gap-5">
      <Card title={<SectionHeader>SCAN ENGINE</SectionHeader>}>
        <ScanEngineConfig />
      </Card>

      <Card title={<SectionHeader>DISCOVERY IP RANGES</SectionHeader>}>
        <div className="flex flex-col gap-4">
          <DiscoveryRanges />
          <DryRunPanel />
        </div>
      </Card>

      <ScanRunHistory />
    </div>
  );
}

export default EngineTabContent;
