import AttitudeIndicator from "../components/AttitudeIndicator";
import SidebarTabs from "../sidebar/SidebarTabs";
import StartMissionButton from "../components/StartMissionButton";

import "../styles/sidebar.css";

type LeftSidebarProps = {
  width?: number;
};

function LeftSidebar({ width }: LeftSidebarProps) {
  return (
    <aside
      className="left-sidebar"
      style={width ? { width, minWidth: width, maxWidth: width } : undefined}
    >
      <div className="sidebar-hud">
        <AttitudeIndicator />
      </div>
      <StartMissionButton />
      <SidebarTabs />
    </aside>
  );
}

export default LeftSidebar;
