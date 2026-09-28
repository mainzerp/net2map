import React, { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, API, _getAuthHeader, extractErrorMessage } from "../../api";
import useNetmapStore from "../../store";
import { queryKeys, useInvalidateApi, useMapBackground, useMapSettings, type MapSettings } from "../../hooks/api";
import { useToast } from "../ToastProvider";
import { debounce } from "../../utils/debounce";
import { Button, Card } from "../ui";
import { SectionHeader, TabError, TabLoading } from "./shared";

// ── MapSettingsTabContent ───────────────────────────────────────────────────
// Reads/writes /api/map-settings and /api/map-background through React Query
// hooks. Successful mutations also refresh the zustand store so an open map
// sees new background image/opacity/color immediately.
function MapSettingsTabContent() {
  const { data: settings, isLoading: settingsLoading, error: settingsError } = useMapSettings();
  const { data: bgUrl, error: bgError } = useMapBackground();
  const { invalidate } = useInvalidateApi();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const opacity = settings?.opacity ?? 0.3;
  const scale = settings?.scale ?? 1;
  const bgColor = settings?.bg_color ?? "#020817";

  // Debounced saver: sliders and the color picker fire per tick, so coalesce
  // them into one PUT after the user pauses.
  const saveSettings = useRef(
    debounce((mutate: (patch: Record<string, unknown>) => void, patch: Record<string, unknown>) => {
      mutate(patch);
    }, 300),
  ).current;

  const settingsMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.put("/api/map-settings", patch),
    onSuccess: () => {
      invalidate(queryKeys.mapSettings);
      // Keep the live map store in step with the saved opacity/scale/color.
      useNetmapStore.getState().loadMapSettings();
    },
    onError: (ex) => addToast(`Failed to save map settings: ${extractErrorMessage(ex)}`, "error"),
  });

  // Optimistic local echo: patch the cached settings immediately so sliders
  // stay responsive, then coalesce rapid changes into one debounced PUT.
  const changeSetting = (patch: Record<string, unknown>) => {
    queryClient.setQueryData<MapSettings>(queryKeys.mapSettings, (old) => ({ ...(old ?? {}), ...patch }));
    saveSettings((p) => settingsMutation.mutate(p), patch);
  };

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/api/map-background`, {
        method: "POST",
        body: fd,
        headers: _getAuthHeader(),
      });
      if (!res.ok) {
        let msg: string;
        try { const b = await res.json(); msg = b?.error?.message || b?.detail || res.statusText; } catch { msg = res.statusText; }
        throw new Error(msg);
      }
    },
    onSuccess: () => {
      // Bump the image version first so the refetched preview URL and the
      // store reload both bypass the browser cache for the new image.
      const store = useNetmapStore.getState();
      store.bumpMapBackgroundVersion();
      store.loadMapBackground();
      invalidate(queryKeys.mapBackground);
    },
    onError: (ex) => addToast(`Upload failed: ${extractErrorMessage(ex)}`, "error"),
  });

  const removeMutation = useMutation({
    mutationFn: () => api.del("/api/map-background"),
    onSuccess: () => {
      const store = useNetmapStore.getState();
      store.bumpMapBackgroundVersion();
      store.loadMapBackground();
      invalidate(queryKeys.mapBackground);
    },
    onError: (ex) => addToast(`Remove failed: ${extractErrorMessage(ex)}`, "error"),
  });

  const errorMessage = settingsError
    ? extractErrorMessage(settingsError)
    : bgError
      ? extractErrorMessage(bgError)
      : "";

  return (
    <div className="flex-1 overflow-y-auto pt-5 flex flex-col gap-5 w-full">
      {settingsLoading && <TabLoading label="Loading map settings..." />}
      {errorMessage && <TabError message={errorMessage} />}

      <Card title={<SectionHeader>MAP BACKGROUND COLOR</SectionHeader>}>
        <div className="flex items-center gap-3">
          <input
            type="color"
            aria-label="Map background color"
            value={bgColor}
            onChange={(e) => changeSetting({ bg_color: e.target.value })}
            className="w-10 h-8 p-0.5 border border-line-strong rounded cursor-pointer bg-transparent"
          />
          <span className="text-muted text-[11px] font-mono min-w-9">{bgColor}</span>
          <Button size="sm" onClick={() => changeSetting({ bg_color: "#020817" })}>Reset dark</Button>
          <Button size="sm" onClick={() => changeSetting({ bg_color: "#ffffff" })}>White</Button>
        </div>
        <div className="text-muted text-[10px] mt-2">
          Set to match your floor plan or office background for a seamless look.
        </div>
      </Card>

      <Card title={<SectionHeader>BACKGROUND IMAGE</SectionHeader>}>
        <div className="flex items-center gap-2.5 flex-wrap">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              if (e.target.files?.[0]) { uploadMutation.mutate(e.target.files[0]); e.target.value = ""; }
            }}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={uploadMutation.isPending}>
            {uploadMutation.isPending ? "Uploading..." : bgUrl ? "Replace image" : "Upload image"}
          </Button>
          {bgUrl && (
            <Button variant="danger" onClick={() => removeMutation.mutate()} disabled={removeMutation.isPending}>
              Remove
            </Button>
          )}
        </div>
        {bgUrl && (
          <div className="mt-3 rounded-lg border border-line overflow-hidden max-w-[400px]">
            <img src={bgUrl} alt="Background preview" className="block w-full opacity-80" />
          </div>
        )}
      </Card>

      {bgUrl && (
        <Card title={<SectionHeader>IMAGE DISPLAY</SectionHeader>}>
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-[11px] text-muted mb-1.5">Opacity</div>
              <div className="flex items-center gap-2.5">
                <input
                  type="range"
                  aria-label="Background opacity"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={opacity}
                  onChange={(e) => changeSetting({ opacity: parseFloat(e.target.value) })}
                  className="w-[200px] accent-accent"
                />
                <span className="text-muted text-[11px] font-mono min-w-9">{Math.round(opacity * 100)}%</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-muted mb-1.5">Image Zoom</div>
              <div className="flex items-center gap-2.5">
                <input
                  type="range"
                  aria-label="Background zoom"
                  min="0.1"
                  max="5"
                  step="0.1"
                  value={scale}
                  onChange={(e) => changeSetting({ scale: parseFloat(e.target.value) })}
                  className="w-[200px] accent-accent"
                />
                <span className="text-muted text-[11px] font-mono min-w-9">{Math.round(scale * 100)}%</span>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

export default MapSettingsTabContent;
