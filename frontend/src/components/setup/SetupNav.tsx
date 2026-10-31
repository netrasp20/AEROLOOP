import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Cpu,
  Move3d,
  Compass,
  RadioTower,
  Gamepad2,
  Zap,
  ShieldAlert,
  Joystick,
  Activity,
  FileText,
  ScrollText,
  ListTree,
} from "lucide-react";

export interface SetupNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

/**
 * ArduCopter Setup navigation, modeled on QGroundControl Vehicle Configuration.
 * Summary/Firmware are Phase 8A; the remaining pages land in sub-phases 8B–8H.
 */
export const SETUP_NAV: SetupNavItem[] = [
  { id: "summary", label: "Summary", icon: LayoutDashboard },
  { id: "firmware", label: "Firmware", icon: Cpu },
  { id: "frame", label: "Frame / Airframe", icon: Move3d },
  { id: "sensors", label: "Sensors", icon: Compass },
  { id: "radio", label: "Radio", icon: RadioTower },
  { id: "modes", label: "Flight Modes", icon: Gamepad2 },
  { id: "power", label: "Power", icon: Zap },
  { id: "safety", label: "Safety", icon: ShieldAlert },
  { id: "motors", label: "Motors", icon: Joystick },
  { id: "esc", label: "ESC", icon: Activity },
  { id: "logging", label: "Logging", icon: FileText },
  { id: "scripting", label: "Scripting", icon: ScrollText },
  { id: "parameters", label: "Parameters", icon: ListTree },
];

interface Props {
  activeId: string;
  counts?: { warn: number; bad: number };
  onSelect: (id: string) => void;
}

export default function SetupNav({ activeId, counts, onSelect }: Props) {
  return (
    <nav className="setup-nav" data-testid="setup-nav">
      <div className="setup-nav-title">Vehicle Setup</div>
      <ul className="setup-nav-list">
        {SETUP_NAV.map((item) => {
          const Icon = item.icon;
          const active = activeId === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`setup-nav-item ${active ? "active" : ""}`}
                onClick={() => onSelect(item.id)}
                data-testid={`setup-nav-${item.id}`}
              >
                <Icon size={15} className="setup-nav-icon" />
                <span className="setup-nav-label">{item.label}</span>
                {item.id === "summary" && counts && counts.warn + counts.bad > 0 && (
                  <span
                    className="setup-nav-badge"
                    data-testid="setup-nav-summary-badge"
                  >
                    {counts.warn + counts.bad}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
