import "../styles/contextmenu.css";

import { useMissionContext } from "../context/MissionContext";

function ContextMenu() {
  const {
    contextMenu,
    setContextMenu,
    addWaypoint,
    setHome,
    clearMission,
  } = useMissionContext();

  // Don't render if menu is hidden
  if (!contextMenu.visible) {
    return null;
  }

  function closeMenu() {
    setContextMenu({
      ...contextMenu,
      visible: false,
    });
  }

  return (
    <div
      className="context-menu"
      style={{
        left: contextMenu.x,
        top: contextMenu.y,
      }}
    >
      <button
        onClick={() => {
          addWaypoint(
            contextMenu.lat,
            contextMenu.lng
          );
          closeMenu();
        }}
      >
        ➕ Add Waypoint
      </button>

      <button
        onClick={() => {
          setHome({
            lat: contextMenu.lat,
            lng: contextMenu.lng,
          });
          closeMenu();
        }}
      >
        🏠 Set Home Here
      </button>

      <button
        onClick={() => {
          clearMission();
          closeMenu();
        }}
      >
        🧹 Clear Mission
      </button>
    </div>
  );
}

export default ContextMenu;