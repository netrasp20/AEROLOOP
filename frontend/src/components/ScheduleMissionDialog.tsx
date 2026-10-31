import { useState, useMemo } from "react";
import type { MissionFile, ScheduledMission, MissionRepeat } from "../types/mission";
import "../styles/scheduledMission.css";

interface Props {
  missionData: MissionFile;
  defaultName?: string;
  connected: boolean;
  onSchedule: (entry: ScheduledMission) => void;
  onClose: () => void;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Local YYYY-MM-DD for today — uses the actual computer/browser date (not UTC).
function todayLocal(): string {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function repeatLabel(r: MissionRepeat): string {
  switch (r) {
    case "once": return "Once";
    case "daily": return "Every Day";
    case "weekly": return "Every Week";
    case "custom": return "Custom";
  }
}

export default function ScheduleMissionDialog({ missionData, defaultName, connected, onSchedule, onClose }: Props) {
  const [name, setName] = useState(defaultName ?? "");
  const [date, setDate] = useState(todayLocal());
  const [time, setTime] = useState("");
  const [repeat, setRepeat] = useState<MissionRepeat>("once");
  const [weeklyDays, setWeeklyDays] = useState<number[]>([]);
  const [customDates, setCustomDates] = useState<string[]>([]);
  const [endDate, setEndDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Live summary built from the current selections.
  const summary = useMemo(() => {
    if (!date || !time) return null;
    const start = new Date(`${date}T${time}`);
    if (isNaN(start.getTime())) return null;
    const when = start.toLocaleString(undefined, {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    let repeatText = repeatLabel(repeat);
    if (repeat === "weekly") {
      repeatText = `Every Week (${weeklyDays.length ? weeklyDays.map((d) => WEEKDAYS[d]).join(", ") : "none selected"})`;
    } else if (repeat === "custom") {
      repeatText = `Custom (${customDates.length ? customDates.length : 0} date(s))`;
    } else if (repeat === "daily" && endDate) {
      repeatText = `Every Day until ${endDate}`;
    }
    return { when, repeatText };
  }, [date, time, repeat, weeklyDays, customDates, endDate]);

  const toggleWeekday = (idx: number) => {
    setWeeklyDays((prev) => (prev.includes(idx) ? prev.filter((d) => d !== idx) : [...prev, idx].sort()));
  };

  const addCustomDate = () => {
    setCustomDates((prev) => (prev.includes(date) ? prev : [...prev, date].sort()));
  };

  const handleSchedule = () => {
    setError(null);
    if (!connected) {
      setError("Connect to the flight controller before scheduling a mission.");
      return;
    }
    if (!date || !time) {
      setError("Please select both a date and a time.");
      return;
    }
    const start = new Date(`${date}T${time}`);
    if (isNaN(start.getTime())) {
      setError("Invalid date/time.");
      return;
    }
    // Real "future" check against the actual current time.
    if (start.getTime() <= Date.now()) {
      setError("Please select a future date and time.");
      return;
    }
    if (repeat === "weekly" && weeklyDays.length === 0) {
      setError("Select at least one day of the week.");
      return;
    }
    if (repeat === "custom" && customDates.length === 0) {
      setError("Select at least one date.");
      return;
    }
    if ((repeat === "daily" || repeat === "weekly") && endDate && endDate < date) {
      setError("End date cannot be before the start date.");
      return;
    }

    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `sm_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // LOCAL naive datetimes (no UTC conversion): the backend runs on the same
    // host and compares these against its own local clock, so the UI and the
    // scheduler always agree on the operator's timezone.
    const entry: ScheduledMission = {
      id,
      name: name.trim() || "Untitled Mission",
      mission: missionData,
      startDateTime: `${date}T${time}`,
      repeat,
      weeklyDays: repeat === "weekly" ? [...weeklyDays] : undefined,
      customDates: repeat === "custom" ? [...customDates] : undefined,
      endDateTime:
        (repeat === "daily" || repeat === "weekly") && endDate
          ? `${endDate}T23:59:59`
          : null,
      status: "scheduled",
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    onSchedule(entry);
  };

  return (
    <div className="sm-overlay" onMouseDown={onClose}>
      <div className="sm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sm-header">
          <span>Schedule Mission</span>
          <button className="sm-close" onClick={onClose} title="Cancel">×</button>
        </div>

        <div className="sm-body">
          {!connected && (
            <div className="sm-connect-warning">
              ⚠ Connect to the flight controller before scheduling a mission.
            </div>
          )}

          <div className="sm-field">
            <label className="sm-label">Mission Name</label>
            <input
              className="sm-input"
              placeholder="e.g. Survey Area"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="sm-row">
            <div className="sm-field">
              <label className="sm-label">Date</label>
              <input
                className="sm-input"
                type="date"
                min={todayLocal()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="sm-field">
              <label className="sm-label">Time</label>
              <input
                className="sm-input"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>

          <div className="sm-field">
            <label className="sm-label">Repeat</label>
            <div className="sm-repeat-options">
              {(["once", "daily", "weekly", "custom"] as MissionRepeat[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`sm-repeat-btn${repeat === r ? " active" : ""}`}
                  onClick={() => setRepeat(r)}
                >
                  {repeatLabel(r)}
                </button>
              ))}
            </div>
          </div>

          {repeat === "daily" && (
            <div className="sm-field">
              <label className="sm-label">End date (optional)</label>
              <input
                className="sm-input"
                type="date"
                min={date}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          )}

          {repeat === "weekly" && (
            <div className="sm-field">
              <label className="sm-label">Days of week</label>
              <div className="sm-weekdays">
                {WEEKDAYS.map((d, idx) => (
                  <button
                    key={d}
                    type="button"
                    className={`sm-weekday${weeklyDays.includes(idx) ? " active" : ""}`}
                    onClick={() => toggleWeekday(idx)}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}

          {repeat === "custom" && (
            <div className="sm-field">
              <label className="sm-label">Specific dates</label>
              <div className="sm-custom-dates">
                {customDates.map((d) => (
                  <span key={d} className="sm-date-chip">
                    {d}
                    <button
                      type="button"
                      className="sm-date-remove"
                      onClick={() => setCustomDates((prev) => prev.filter((x) => x !== d))}
                      title="Remove"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <button type="button" className="sm-add-date" onClick={addCustomDate}>
                + Add {date}
              </button>
            </div>
          )}

          {summary && (
            <div className="sm-summary">
              <div className="sm-summary-title">Summary</div>
              <div>Mission: <strong>{name.trim() || "Untitled Mission"}</strong></div>
              <div>Start: <strong>{summary.when}</strong></div>
              <div>Repeat: <strong>{summary.repeatText}</strong></div>
              <div className="sm-summary-meta">
                {missionData.waypoints.length} waypoint{missionData.waypoints.length !== 1 ? "s" : ""}
                {missionData.home ? " • Home set" : ""}
              </div>
            </div>
          )}

          {error && <div className="sm-error">{error}</div>}
        </div>

        <div className="sm-footer">
          <button className="sm-btn sm-cancel" onClick={onClose}>Cancel</button>
          <button className="sm-btn sm-schedule" onClick={handleSchedule} disabled={!connected}>Schedule Mission</button>
        </div>
      </div>
    </div>
  );
}
