import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

import type { VisibilityLevel } from "../../parameters/parametersLogic";

export interface NavItem {
  id: string;
  label: string;
  level?: VisibilityLevel;
  inert?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: "modes", label: "Flight Modes" },
  { id: "geofence", label: "GeoFence" },
  { id: "basic", label: "Basic Tuning" },
  { id: "extended", label: "Extended Tuning" },
  { id: "planner", label: "Planner Settings" },
  { id: "osd", label: "OnBoard OSD" },
  { id: "ftp", label: "MAVFTP" },
];

const PARAM_CHILDREN: NavItem[] = [
  { id: "all", label: "Full Parameter List", level: "all" },
  { id: "standard", label: "Standard Parameters List", level: "standard" },
  { id: "advanced", label: "Advanced Parameters List", level: "advanced" },
];

interface Props {
  activeId: string;
  level: VisibilityLevel;
  counts: { all: number; standard: number; advanced: number };
  onSelect: (item: NavItem) => void;
}

export default function ParameterNav({ activeId, level, counts, onSelect }: Props) {
  const [paramsOpen, setParamsOpen] = useState(true);

  const isParamChild =
    activeId === "all" || activeId === "standard" || activeId === "advanced";

  function handleChildSelect(item: NavItem) {
    onSelect(item);
  }

  return (
    <div className="mp-nav" data-testid="param-nav">
      <ul className="mp-nav-list">
        {NAV_ITEMS.map((item) => {
          const active = activeId === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`mp-nav-item ${active ? "active" : ""}`}
                onClick={() => onSelect(item)}
              >
                <span className="mp-nav-label">
                  {item.inert && (
                    <ChevronRight size={12} className="mp-nav-chevron" />
                  )}
                  {item.label}
                </span>
              </button>
            </li>
          );
        })}

        <li className="mp-nav-separator-row">
          <div className="mp-nav-separator" />
        </li>

        <li>
          <button
            type="button"
            className={`mp-nav-item mp-nav-dropdown ${isParamChild ? "active" : ""}`}
            onClick={() => setParamsOpen(!paramsOpen)}
          >
            <span className="mp-nav-label">
              {paramsOpen ? (
                <ChevronDown size={12} className="mp-nav-chevron" />
              ) : (
                <ChevronRight size={12} className="mp-nav-chevron" />
              )}
              Parameters
            </span>
          </button>
          {paramsOpen && (
            <ul className="mp-nav-children">
              {PARAM_CHILDREN.map((child) => {
                const active =
                  (child.level === "all" && level === "all") ||
                  (child.id === "standard" && level === "standard") ||
                  (child.id === "advanced" && level === "advanced");
                const count =
                  child.id === "all"
                    ? counts.all
                    : child.id === "standard"
                      ? counts.standard
                      : child.id === "advanced"
                        ? counts.advanced
                        : null;
                const testid =
                  child.id === "all"
                    ? "param-tab-all"
                    : child.id === "standard"
                      ? "param-tab-standard"
                      : child.id === "advanced"
                        ? "param-tab-advanced"
                        : null;
                return (
                  <li key={child.id}>
                    <button
                      type="button"
                      className={`mp-nav-item mp-nav-child ${active ? "active" : ""}`}
                      onClick={() => handleChildSelect(child)}
                      data-testid={testid ?? undefined}
                    >
                      <span className="mp-nav-label">{child.label}</span>
                      {count !== null && (
                        <span className="mp-nav-count">{count}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </li>

        <li className="mp-nav-separator-row">
          <div className="mp-nav-separator" />
        </li>
      </ul>
    </div>
  );
}
