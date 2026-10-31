import type { Mission, MissionFile } from "../types/mission";

export class MissionSerializer {
  serialize(mission: Mission): MissionFile {
    return {
      version: 1,
      timestamp: new Date().toISOString(),
      home: mission.home
        ? { lat: mission.home.lat, lng: mission.home.lng }
        : null,
      waypoints: mission.waypoints.map((wp) => ({
        id: wp.id,
        lat: wp.lat,
        lng: wp.lng,
        altitude: wp.altitude,
        hoverTime: wp.hoverTime,
        command: wp.command,
        frame: wp.frame,
        sequence: wp.sequence,
      })),
    };
  }
}

export const missionSerializer = new MissionSerializer();
