import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUrl, _getAuthHeader } from "../../api";
import type { Building, Floor } from "../../types";
import { queryKeys } from "./keys";

// ── Buildings and floors ─────────────────────────────────────────────────────
// GET/POST /api/buildings, PATCH/DELETE /api/buildings/{id},
// POST /api/buildings/{id}/floors, PATCH/DELETE /api/floors/{id},
// POST/DELETE /api/floors/{id}/background. Every write bumps the topology
// version on the backend, so the topology query is invalidated alongside the
// building list; deleting a building or floor also unassigns racks/devices.

export interface BuildingInput {
  label: string;
  description?: string | null;
  sort_order?: number;
}

export interface FloorInput {
  label: string;
  sort_order?: number;
}

export interface FloorPatch {
  label?: string;
  sort_order?: number;
  building_id?: number;
  bg_opacity?: number;
  bg_scale?: number;
  bg_color?: string;
}

export function useBuildings() {
  return useQuery<Building[]>({
    queryKey: queryKeys.buildings,
    queryFn: async () => {
      const data: unknown = await api.get("/api/buildings");
      return Array.isArray(data) ? (data as Building[]) : [];
    },
  });
}

function useInvalidateBuildings(withAssignments = false) {
  const queryClient = useQueryClient();
  return () => {
    const keys = [queryKeys.buildings, queryKeys.topology];
    if (withAssignments) keys.push(queryKeys.racks, queryKeys.devices);
    keys.forEach(queryKey => {
      void queryClient.invalidateQueries({ queryKey });
    });
  };
}

export function useCreateBuilding() {
  const onSuccess = useInvalidateBuildings();
  return useMutation({
    mutationFn: (body: BuildingInput) => api.post<Building>("/api/buildings", body),
    onSuccess,
  });
}

export function useUpdateBuilding() {
  const onSuccess = useInvalidateBuildings();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<BuildingInput> & { id: number }) =>
      api.patch<Building>(`/api/buildings/${id}`, body),
    onSuccess,
  });
}

export function useDeleteBuilding() {
  const onSuccess = useInvalidateBuildings(true);
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/buildings/${id}`),
    onSuccess,
  });
}

export function useCreateFloor() {
  const onSuccess = useInvalidateBuildings();
  return useMutation({
    mutationFn: ({ buildingId, ...body }: FloorInput & { buildingId: number }) =>
      api.post<Floor>(`/api/buildings/${buildingId}/floors`, body),
    onSuccess,
  });
}

export function useUpdateFloor() {
  const onSuccess = useInvalidateBuildings();
  return useMutation({
    mutationFn: ({ id, ...body }: FloorPatch & { id: number }) => api.patch<Floor>(`/api/floors/${id}`, body),
    onSuccess,
  });
}

export function useDeleteFloor() {
  const onSuccess = useInvalidateBuildings(true);
  return useMutation({
    mutationFn: (id: number) => api.del(`/api/floors/${id}`),
    onSuccess,
  });
}

// Multipart upload: the JSON api helper cannot send FormData, so this uses a
// bare fetch with the same auth header and error extraction.
export async function uploadFloorBackground(floorId: number, file: File): Promise<Floor> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(apiUrl(`/api/floors/${floorId}/background`), {
    method: "POST",
    body: fd,
    headers: _getAuthHeader(),
  });
  if (!res.ok) {
    let msg: string;
    try {
      const b = await res.json();
      msg = b?.error?.message || b?.detail || res.statusText;
    } catch {
      msg = res.statusText;
    }
    throw new Error(msg);
  }
  return (await res.json()) as Floor;
}

export function useUploadFloorBackground() {
  const onSuccess = useInvalidateBuildings();
  return useMutation({
    mutationFn: ({ floorId, file }: { floorId: number; file: File }) => uploadFloorBackground(floorId, file),
    onSuccess,
  });
}

export function useDeleteFloorBackground() {
  const onSuccess = useInvalidateBuildings();
  return useMutation({
    mutationFn: (floorId: number) => api.del(`/api/floors/${floorId}/background`),
    onSuccess,
  });
}
