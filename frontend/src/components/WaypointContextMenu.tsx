import { useEffect, useRef } from "react";

import { useMissionContext } from "../context/MissionContext";

function WaypointContextMenu() {
  const {
    waypointMenu,
    setWaypointMenu,
    deleteWaypoint,
  } = useMissionContext();

  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!waypointMenu.visible) return;

    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setWaypointMenu({ ...waypointMenu, visible: false });
      }
    }

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setWaypointMenu({ ...waypointMenu, visible: false });
      }
    }

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);

    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [waypointMenu, setWaypointMenu]);

  if (!waypointMenu.visible) return null;

  function close() {
    setWaypointMenu({ ...waypointMenu, visible: false });
  }

  function handleDelete() {
    if (waypointMenu.waypointId !== null) {
      deleteWaypoint(waypointMenu.waypointId);
    }
    close();
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{
        left: waypointMenu.x,
        top: waypointMenu.y,
      }}
    >
      <div className="context-menu-header">
        Waypoint {waypointMenu.waypointId}
      </div>

      <button onClick={handleDelete}>
        🗑 Delete Waypoint
      </button>
    </div>
  );
}

export default WaypointContextMenu;
