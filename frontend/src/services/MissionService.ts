import { missionStorageService } from "./MissionStorageService";
import { missionUploadService } from "./MissionUploadService";

import type { Mission, MissionFile } from "../types/mission";
import type { ProgressCallback } from "./MissionUploadService";

import { missionParser } from "./MissionParser";

export class MissionService {
  async loadFromServer(id: string): Promise<{
    mission: Mission;
    filename: string;
  } | null> {
    try {
      const data: MissionFile = await missionStorageService.load(id);

      const errors = missionParser.validate(data);
      if (errors.length > 0) {
        throw new Error(
          `Invalid mission file:\n${errors.join("\n")}`
        );
      }

      return {
        mission: missionParser.parseMissionFile(data),
        filename: id,
      };
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === "No file selected."
      ) {
        return null;
      }
      throw err;
    }
  }

  async saveToServer(mission: Mission): Promise<string> {
    const info = await missionStorageService.save(mission);
    return info.id;
  }

  async upload(
    mission: Mission,
    vehicleConnected: boolean,
    onProgress?: ProgressCallback
  ) {
    return missionUploadService.upload(mission, vehicleConnected, onProgress);
  }
}

export const missionService = new MissionService();
