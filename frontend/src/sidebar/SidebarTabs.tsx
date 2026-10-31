import { useState } from "react";

import QuickPanel from "./QuickPanel";
import ActionPanel from "./ActionPanel";
import MessagePanel from "./MessagePanel";
import GaugePanel from "./GaugePanel";

function SidebarTabs() {
  const [tab, setTab] = useState("Quick");

  return (
    <div className="sidebar-body">
      <div className="sidebar-tabs">
        <button
          className={tab === "Quick" ? "tab active-tab" : "tab"}
          onClick={() => setTab("Quick")}
        >
          Quick
        </button>

        <button
          className={tab === "Actions" ? "tab active-tab" : "tab"}
          onClick={() => setTab("Actions")}
        >
          Actions
        </button>

        <button
          className={tab === "Logs" ? "tab active-tab" : "tab"}
          onClick={() => setTab("Logs")}
        >
          Logs
        </button>

        <button
          className={tab === "Gauges" ? "tab active-tab" : "tab"}
          onClick={() => setTab("Gauges")}
        >
          Gauges
        </button>
      </div>

      <div className="sidebar-content">
        {tab === "Quick" && <QuickPanel />}
        {tab === "Actions" && <ActionPanel />}
        {tab === "Logs" && <MessagePanel />}
        {tab === "Gauges" && <GaugePanel />}
      </div>
    </div>
  );
}

export default SidebarTabs;
