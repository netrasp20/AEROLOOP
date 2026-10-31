import type { ScheduledMission } from "../types/mission";
import api from "../api/api";

const STORAGE_KEY = "yantrayug-scheduled-missions";

function read(): ScheduledMission[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ScheduledMission[]) : [];
  } catch {
    return [];
  }
}

function write(list: ScheduledMission[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

const ScheduledMissionService = {
  list(): ScheduledMission[] {
    return read();
  },

  async listFromBackend(): Promise<ScheduledMission[]> {
    try {
      const res = await api.get("/schedule");
      const schedules = res.data?.schedules ?? [];
      write(schedules);
      return schedules;
    } catch {
      return read();
    }
  },

  async add(entry: ScheduledMission): Promise<ScheduledMission> {
    try {
      await api.post("/schedule", entry);
    } catch {
      // Fallback to localStorage only
    }
    const list = read();
    if (!list.some((m) => m.id === entry.id)) {
      list.push(entry);
      write(list);
    }
    return entry;
  },

  async remove(id: string): Promise<void> {
    try {
      await api.delete(`/schedule/${id}`);
    } catch {
      // Fallback to localStorage
    }
    write(read().filter((m) => m.id !== id));
  },

  async update(id: string, patch: Partial<ScheduledMission>): Promise<void> {
    try {
      await api.patch(`/schedule/${id}`, patch);
    } catch {
      // Fallback to localStorage
    }
    const list = read().map((m) => (m.id === id ? { ...m, ...patch } : m));
    write(list);
  },

  /** Legacy sync helper (kept for backward compatibility). */
  sync(entry: ScheduledMission): void {
    const list = read();
    if (!list.some((m) => m.id === entry.id)) {
      list.push(entry);
      write(list);
    }
  },
};

export default ScheduledMissionService;
