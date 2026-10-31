import {
  createContext,
  useContext,
  useEffect,
  useRef,
} from "react";

import type { ReactNode } from "react";

import useMission from "../hooks/useMission";

const MissionContext = createContext<
  ReturnType<typeof useMission> | null
>(null);

export function MissionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const mission = useMission();
  const prevCount = useRef(mission.waypoints.length);

  useEffect(() => {
    const count = mission.waypoints.length;
    if (count !== prevCount.current) {
      console.log(`[MISSION-CTX] Waypoints changed: ${prevCount.current} → ${count}${count > 0 ? ` [${mission.waypoints.map(w => `WP${w.id}@${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join(", ")}]` : ""}`);
      prevCount.current = count;
    }
  });

  return (
    <MissionContext.Provider value={mission}>
      {children}
    </MissionContext.Provider>
  );
}

export function useMissionContext() {
  const context = useContext(MissionContext);

  if (context === null) {
    throw new Error(
      "useMissionContext must be used inside MissionProvider"
    );
  }

  return context;
}