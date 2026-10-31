import { useState } from "react";

import "../styles/mission.css";

import TopNavbar from "../layout/TopNavbar";

import DataPage from "./DataPage";
import PlanPage from "./PlanPage";
import SetupPage from "./SetupPage";
import ConfigPage from "./ConfigPage";

export type ActivePage =
  | "DATA"
  | "PLAN"
  | "SETUP"
  | "CONFIG";

function MissionPlanner() {
  const [page, setPage] = useState<ActivePage>("PLAN");

  return (
    <div className="mission-planner">
      <TopNavbar
        page={page}
        setPage={setPage}
      />

      {page === "DATA" && <DataPage />}

      {page === "PLAN" && (
        <PlanPage onUploadSuccess={() => setPage("DATA")} />
      )}

      {page === "SETUP" && <SetupPage />}

      {page === "CONFIG" && <ConfigPage />}
    </div>
  );
}

export default MissionPlanner;