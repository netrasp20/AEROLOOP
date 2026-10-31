import { useState } from "react";
import type { HomePosition, Waypoint } from "../types/mission";

export type Tool = "waypoint" | "home";

export default function useMission() {
  // Active Tool
  const [tool, setTool] = useState<Tool>("waypoint");

  // Home Position
  const [home, setHome] = useState<HomePosition | null>(null);

  // Mission Waypoints
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);

  // Selected Waypoint
  const [selectedWaypointId, setSelectedWaypointId] =
    useState<number | null>(null);

  // Context Menu (map right-click)
  const [contextMenu, setContextMenu] = useState({
    visible: false,
    x: 0,
    y: 0,
    lat: 0,
    lng: 0,
  });

  // Waypoint Context Menu (waypoint right-click)
  const [waypointMenu, setWaypointMenu] = useState({
    visible: false,
    x: 0,
    y: 0,
    waypointId: null as number | null,
  });

  // ===========================
  // HOME
  // ===========================

  function setHomePosition(lat: number, lng: number) {
    setHome({
      lat,
      lng,
    });
  }

  // ===========================
  // WAYPOINTS
  // ===========================

  function addWaypoint(lat: number, lng: number) {
    const newId = waypoints.length + 1;

    const newWaypoint: Waypoint = {
      id: newId,
      lat,
      lng,
      altitude: 10,
      hoverTime: 0,
      command: "NAV_WAYPOINT",
      frame: "GLOBAL_RELATIVE_ALT",
      sequence: newId,
    };

    setWaypoints((prev) => [...prev, newWaypoint]);

    // Automatically select the newly created waypoint
    setSelectedWaypointId(newId);
  }

  function deleteWaypoint(id: number) {
    setWaypoints((prev) =>
      prev
        .filter((wp) => wp.id !== id)
        .map((wp, index) => ({
          ...wp,
          // Keep `id` AND `sequence` in lockstep so the table, markers,
          // mission-progress and active-waypoint logic all agree after a delete.
          id: index + 1,
          sequence: index + 1,
        }))
    );

    if (selectedWaypointId === id) {
      setSelectedWaypointId(null);
    }
  }

  function moveWaypoint(
    id: number,
    lat: number,
    lng: number
  ) {
    setWaypoints((prev) =>
      prev.map((wp) =>
        wp.id === id
          ? {
              ...wp,
              lat,
              lng,
            }
          : wp
      )
    );
  }

  function updateWaypoint(
    id: number,
    data: Partial<Waypoint>
  ) {
    setWaypoints((prev) =>
      prev.map((wp) =>
        wp.id === id
          ? {
              ...wp,
              ...data,
            }
          : wp
      )
    );
  }

  // ===========================
  // CLEAR MISSION
  // ===========================

  function clearMission() {
    setWaypoints([]);
    setHome(null);
    setSelectedWaypointId(null);
    setTool("waypoint");
  }

  return {
    tool,
    setTool,

    home,
    setHome,
    setHomePosition,

    waypoints,
    setWaypoints,

    selectedWaypointId,
    setSelectedWaypointId,

    addWaypoint,
    deleteWaypoint,
    moveWaypoint,
    updateWaypoint,

    contextMenu,
    setContextMenu,

    waypointMenu,
    setWaypointMenu,

    clearMission,
  };
}