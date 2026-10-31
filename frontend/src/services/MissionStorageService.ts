import type {
  Mission,
  MissionInfo,
  MissionListResponse,
  MissionSaveResponse,
  MissionLoadResponse,
} from "../types/mission";

const API = "/api/missions";

export class MissionStorageService {
  async list(): Promise<MissionInfo[]> {
    const res = await fetch(API);
    const data: MissionListResponse = await res.json();
    if (!data.success) throw new Error("Failed to list missions");
    return data.missions;
  }

  async save(mission: Mission): Promise<MissionInfo> {
    const res = await fetch(`${API}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        home: mission.home,
        waypoints: mission.waypoints,
      }),
    });
    const data: MissionSaveResponse = await res.json();
    if (!data.success) throw new Error("Failed to save mission");
    return data.mission;
  }

  async load(id: string) {
    const res = await fetch(`${API}/${id}`);
    const data: MissionLoadResponse = await res.json();
    if (!data.success) throw new Error(`Failed to load mission "${id}"`);
    return data.mission;
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`${API}/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (!data.success) throw new Error(`Failed to delete mission "${id}"`);
  }

  async rename(id: string, name: string): Promise<void> {
    const res = await fetch(`${API}/${id}/rename`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(`Failed to rename mission "${id}"`);
  }

  async duplicate(id: string): Promise<MissionInfo> {
    const res = await fetch(`${API}/${id}/duplicate`, { method: "POST" });
    const data: MissionSaveResponse = await res.json();
    if (!data.success) throw new Error(`Failed to duplicate mission "${id}"`);
    return data.mission;
  }
}

export const missionStorageService = new MissionStorageService();
