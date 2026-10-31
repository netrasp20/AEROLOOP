import { useState } from "react";
import PlanMap from "../plan/PlanMap";
import PlanSidebar from "../components/PlanSidebar";
import WaypointTable from "../components/WaypointTable";
import FenceEditor from "../components/FenceEditor";

import "../styles/plan.css";

type PlanTab = "waypoints" | "fences";

function PlanLayout({
  onUploadSuccess,
}: {
  onUploadSuccess?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<PlanTab>("waypoints");

  return (
    <div className="plan-layout">
      <div className="map-area">
        <div className="plan-tabs">
          <button
            className={`plan-tab ${activeTab === "waypoints" ? "active" : ""}`}
            onClick={() => setActiveTab("waypoints")}
          >
            Waypoints
          </button>
          <button
            className={`plan-tab ${activeTab === "fences" ? "active" : ""}`}
            onClick={() => setActiveTab("fences")}
          >
            Fences
          </button>
        </div>
        <PlanMap />
        {activeTab === "waypoints" ? (
          <WaypointTable />
        ) : (
          <FenceEditor />
        )}
      </div>
      <PlanSidebar onUploadSuccess={onUploadSuccess} />
    </div>
  );
}

export default PlanLayout;
