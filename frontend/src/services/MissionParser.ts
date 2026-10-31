import type { Mission, HomePosition, Waypoint, MissionFile } from "../types/mission";

export class MissionParser {
  parseMissionFile(file: MissionFile): Mission {
    let home: HomePosition | null = null;
    if (file.home && !isNaN(file.home.lat) && !isNaN(file.home.lng)) {
      home = { lat: file.home.lat, lng: file.home.lng };
    }

    const waypoints: Waypoint[] = (file.waypoints || []).map(
      (wp, index) => ({
        id: index + 1,
        lat: wp.lat,
        lng: wp.lng,
        altitude: wp.altitude ?? 10,
        hoverTime: wp.hoverTime ?? 5,
        command: "WAYPOINT",
        frame: "GLOBAL",
        sequence: index + 1,
      })
    );

    return { home, waypoints };
  }

  validate(file: MissionFile): string[] {
    const errors: string[] = [];

    if (!file.version) {
      errors.push("Missing mission version.");
    }

    if (!file.waypoints || !Array.isArray(file.waypoints)) {
      errors.push("Missing or invalid waypoints array.");
      return errors;
    }

    for (const wp of file.waypoints) {
      if (typeof wp.lat !== "number" || isNaN(wp.lat)) {
        errors.push("Waypoint has invalid latitude.");
      }
      if (typeof wp.lng !== "number" || isNaN(wp.lng)) {
        errors.push("Waypoint has invalid longitude.");
      }
    }

    return errors;
  }
}

export const missionParser = new MissionParser();
