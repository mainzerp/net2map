import { useCallback } from "react";
import useNet2MapStore from "../store";
import { useToast } from "../components/ToastProvider";

/**
 * Shared "start scan" action: used by the `s` keyboard shortcut and the
 * command palette so both report the result through the same toasts.
 */
export function useStartScan() {
  const startScan = useNet2MapStore((s) => s.startScan);
  const { addToast } = useToast();

  return useCallback(async () => {
    try {
      await startScan();
      addToast("Scan started", "info");
    } catch {
      addToast("Failed to start scan", "error");
    }
  }, [startScan, addToast]);
}
