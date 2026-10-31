/**
 * Fence API client for ArduCopter GeoFence operations.
 *
 * Communicates with the backend fence endpoints:
 * - POST /api/fence/upload — upload polygon/circle fence geometry
 * - POST /api/fence/download — download fence geometry from vehicle
 * - POST /api/fence/clear — clear all fence points
 */

const API_BASE = "/api/fence";

export interface FencePoint {
  lat: number;
  lng: number;
  command: number; // 5001=polygon inclusion, 5002=polygon exclusion, 5003=circle inclusion, 5004=circle exclusion
  param1?: number; // for circles: radius in meters
  param2?: number;
}

export interface FenceUploadResponse {
  success: boolean;
  points: number;
  message: string;
}

export interface FenceDownloadResponse {
  success: boolean;
  points: FencePoint[];
  count: number;
  message: string;
}

export interface FenceClearResponse {
  success: boolean;
  message: string;
}

export interface FenceVerifyResponse {
  success: boolean;
  count: number;
  points: FencePoint[];
  message: string;
}

export interface FenceStatus {
  breachStatus: number;
  breachCount: number;
  breachType: number;
}

/**
 * Upload fence geometry to the vehicle.
 */
export async function uploadFence(points: FencePoint[]): Promise<FenceUploadResponse> {
  const res = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Fence upload failed");
  }
  return res.json();
}

/**
 * Download fence geometry from the vehicle.
 */
export async function downloadFence(): Promise<FenceDownloadResponse> {
  const res = await fetch(`${API_BASE}/download`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Fence download failed");
  }
  return res.json();
}

/**
 * Clear all fence points from the vehicle.
 */
export async function clearFence(): Promise<FenceClearResponse> {
  const res = await fetch(`${API_BASE}/clear`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Fence clear failed");
  }
  return res.json();
}

/**
 * Upload fence geometry, then download it back and verify the round-trip.
 */
export async function verifyFence(points: FencePoint[]): Promise<FenceVerifyResponse> {
  const res = await fetch(`${API_BASE}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Fence verify failed");
  }
  return res.json();
}
