import type { Mission } from "../models/mission.model";

let mission: Mission = {
  home: null,
  waypoints: [],
};

export function saveMission(data: Mission) {
  mission = data;
}

export function getMission() {
  return mission;
}

export function clearMission() {
  mission = {
    home: null,
    waypoints: [],
  };
}
