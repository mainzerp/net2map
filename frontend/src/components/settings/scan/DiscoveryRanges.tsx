import { useState, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, extractErrorMessage } from "../../../api";
import { queryKeys, useDiscoveryRanges, useInvalidateApi } from "../../../hooks/api";
import { Button } from "../../ui";

// ── DiscoveryRanges ──────────────────────────────────────────────────────────
// Editor for the IP/CIDR ranges that discovery scans automatically. Saved
// ranges are shown as removable chips plus the raw textarea form.
function DiscoveryRanges() {
  const { data: savedRanges = [], isLoading } = useDiscoveryRanges();
  const { invalidate } = useInvalidateApi();
  const [rangesInput, setRangesInput] = useState<string>("");
  const [rangesDraft, setRangesDraft] = useState<string[]>([]);
  const [rangesError, setRangesError] = useState<string>("");

  // Sync the textarea and chip draft once the saved ranges arrive.
  useEffect(() => {
    if (!isLoading) {
      setRangesInput(savedRanges.join("\n"));
      setRangesDraft(savedRanges);
    }
  }, [isLoading, savedRanges]);

  const saveMutation = useMutation({
    mutationFn: async (text: string) => {
      const lines = text
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const resp = await api.put("/api/discovery-ranges", { ranges: lines });
      return Array.isArray(resp?.ranges) ? (resp.ranges as string[]) : lines;
    },
    onSuccess: (saved) => {
      setRangesInput(saved.join("\n"));
      setRangesDraft(saved);
      invalidate(queryKeys.discoveryRanges);
    },
    onError: (ex) => setRangesError(extractErrorMessage(ex)),
  });

  const save = () => {
    setRangesError("");
    saveMutation.mutate(rangesInput);
  };

  // Chips edit the local draft; the change only persists via "Save Ranges".
  const removeRange = (idx: number) => {
    const next = rangesDraft.filter((_, i) => i !== idx);
    setRangesDraft(next);
    setRangesInput(next.join("\n"));
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="text-muted text-[10px] leading-relaxed">
        IPs or CIDR ranges scanned automatically during discovery. Responding hosts are added as credentials. One entry per line (e.g. 192.168.1.0/24).
      </div>
      {rangesDraft.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rangesDraft.map((r, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1.5 rounded bg-panel-2 border border-line-strong px-2 py-0.5 text-[11px] text-accent font-mono"
            >
              {r}
              <button
                type="button"
                onClick={() => removeRange(idx)}
                className="text-muted hover:text-danger cursor-pointer leading-none"
                title="Remove"
              >x</button>
            </span>
          ))}
        </div>
      )}
      <textarea
        rows={4}
        value={rangesInput}
        onChange={(e) => setRangesInput(e.target.value)}
        placeholder={"192.168.1.0/24\n10.0.0.0/16\n172.16.5.42"}
        disabled={isLoading || saveMutation.isPending}
        className="w-full min-h-[70px] resize-y px-2.5 py-2 rounded-md bg-panel-2 text-primary text-xs font-mono border border-line-strong outline-none transition-colors placeholder:text-muted focus:border-accent"
      />
      {rangesError && <div className="text-danger text-[11px]">{rangesError}</div>}
      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={isLoading || saveMutation.isPending}>
          {saveMutation.isPending ? "Saving..." : "Save Ranges"}
        </Button>
        {rangesDraft.length > 0 && (
          <span className="text-muted text-[10px] opacity-70">{rangesDraft.length} range(s) active</span>
        )}
      </div>
    </div>
  );
}

export default DiscoveryRanges;
