import type { VisibilityLevel } from "../../parameters/parametersLogic";

interface Props {
  level: VisibilityLevel;
  counts: Record<VisibilityLevel, number>;
  onChange: (level: VisibilityLevel) => void;
}

const TABS: { level: VisibilityLevel; label: string }[] = [
  { level: "all", label: "All" },
  { level: "standard", label: "Standard" },
  { level: "advanced", label: "Advanced" },
  { level: "modified", label: "Modified" },
];

export default function ParameterFilterTabs({
  level,
  counts,
  onChange,
}: Props) {
  return (
    <div className="param-tabs" role="group" aria-label="Filter parameters">
      {TABS.map((tab) => (
        <button
          key={tab.level}
          className={`param-tab ${level === tab.level ? "active" : ""}`}
          onClick={() => onChange(tab.level)}
          aria-pressed={level === tab.level}
          data-testid={`param-tab-${tab.level}`}
        >
          {tab.label}
          <span className="param-tab-count">{counts[tab.level]}</span>
        </button>
      ))}
    </div>
  );
}