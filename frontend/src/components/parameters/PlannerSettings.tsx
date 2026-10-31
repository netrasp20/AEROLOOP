import { useState, useEffect, useCallback } from "react";
import { Settings, Save, RotateCcw, Info } from "lucide-react";

import "../../styles/plannerSettings.css";

/* ------------------------------------------------------------------ */
/* Planner settings — GCS-only preferences (localStorage)              */
/* ------------------------------------------------------------------ */

interface PlannerPrefs {
  distanceUnit: "m" | "km" | "ft" | "mi";
  speedUnit: "ms" | "kmh" | "fts" | "mph";
  altitudeUnit: "m" | "ft";
  osdUnits: "metric" | "imperial" | "si" | "aviation";
  trackLength: number;
  showCog: boolean;
  showHeading: boolean;
  showNavBearing: boolean;
  showRadius: boolean;
  showTarget: boolean;
  loadWpOnConnect: boolean;
  autoParamCommit: boolean;
  severityFilter: number;
}

const DEFAULT_PREFS: PlannerPrefs = {
  distanceUnit: "m",
  speedUnit: "ms",
  altitudeUnit: "m",
  osdUnits: "metric",
  trackLength: 200,
  showCog: true,
  showHeading: true,
  showNavBearing: true,
  showRadius: true,
  showTarget: true,
  loadWpOnConnect: true,
  autoParamCommit: false,
  severityFilter: 6,
};

const STORAGE_KEY = "yantrayug_planner_prefs";

function loadPrefs(): PlannerPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFS };
}

function savePrefs(prefs: PlannerPrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function PlannerSettings() {
  const [prefs, setPrefs] = useState<PlannerPrefs>(loadPrefs);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPrefs(loadPrefs());
  }, []);

  const update = useCallback(
    <K extends keyof PlannerPrefs>(key: K, value: PlannerPrefs[K]) => {
      setPrefs((prev) => ({ ...prev, [key]: value }));
      setSaved(false);
    },
    []
  );

  function handleSave() {
    savePrefs(prefs);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleReset() {
    setPrefs({ ...DEFAULT_PREFS });
    savePrefs({ ...DEFAULT_PREFS });
    setSaved(false);
  }

  return (
    <div className="ps-screen" data-testid="ps-screen">
      <div className="ps-header">
        <Settings size={16} />
        <span>Planner Settings</span>
      </div>

      <div className="ps-description">
        <Info size={14} />
        <span>
          Configure YantraYug GCS display preferences. These are local settings
          and are NOT sent to the flight controller.
        </span>
      </div>

      {/* Units */}
      <div className="ps-section" data-testid="ps-section-units">
        <div className="ps-section-header">Units</div>
        <div className="ps-section-body">
          <div className="ps-field">
            <label className="ps-label">Distance</label>
            <select
              className="ps-select"
              value={prefs.distanceUnit}
              onChange={(e) => update("distanceUnit", e.target.value as PlannerPrefs["distanceUnit"])}
              data-testid="ps-distance-unit"
            >
              <option value="m">Meters (m)</option>
              <option value="km">Kilometers (km)</option>
              <option value="ft">Feet (ft)</option>
              <option value="mi">Miles (mi)</option>
            </select>
          </div>
          <div className="ps-field">
            <label className="ps-label">Speed</label>
            <select
              className="ps-select"
              value={prefs.speedUnit}
              onChange={(e) => update("speedUnit", e.target.value as PlannerPrefs["speedUnit"])}
              data-testid="ps-speed-unit"
            >
              <option value="ms">m/s</option>
              <option value="kmh">km/h</option>
              <option value="fts">ft/s</option>
              <option value="mph">mph</option>
            </select>
          </div>
          <div className="ps-field">
            <label className="ps-label">Altitude</label>
            <select
              className="ps-select"
              value={prefs.altitudeUnit}
              onChange={(e) => update("altitudeUnit", e.target.value as PlannerPrefs["altitudeUnit"])}
              data-testid="ps-altitude-unit"
            >
              <option value="m">Meters (m)</option>
              <option value="ft">Feet (ft)</option>
            </select>
          </div>
          <div className="ps-field">
            <label className="ps-label">OSD Units</label>
            <select
              className="ps-select"
              value={prefs.osdUnits}
              onChange={(e) => update("osdUnits", e.target.value as PlannerPrefs["osdUnits"])}
              data-testid="ps-osd-units"
            >
              <option value="metric">Metric</option>
              <option value="imperial">Imperial</option>
              <option value="si">SI</option>
              <option value="aviation">Aviation</option>
            </select>
          </div>
        </div>
      </div>

      {/* Map Display */}
      <div className="ps-section" data-testid="ps-section-map">
        <div className="ps-section-header">Map Display</div>
        <div className="ps-section-body">
          <div className="ps-field">
            <label className="ps-label">Track Length</label>
            <input
              type="number"
              className="ps-input"
              value={prefs.trackLength}
              min={10}
              max={1000}
              step={10}
              onChange={(e) => update("trackLength", parseInt(e.target.value) || 200)}
              data-testid="ps-track-length"
            />
          </div>
          <div className="ps-field ps-field--checkbox">
            <label className="ps-label">
              <input
                type="checkbox"
                checked={prefs.showCog}
                onChange={(e) => update("showCog", e.target.checked)}
                data-testid="ps-show-cog"
              />
              Show Course Over Ground
            </label>
          </div>
          <div className="ps-field ps-field--checkbox">
            <label className="ps-label">
              <input
                type="checkbox"
                checked={prefs.showHeading}
                onChange={(e) => update("showHeading", e.target.checked)}
                data-testid="ps-show-heading"
              />
              Show Heading Indicator
            </label>
          </div>
          <div className="ps-field ps-field--checkbox">
            <label className="ps-label">
              <input
                type="checkbox"
                checked={prefs.showNavBearing}
                onChange={(e) => update("showNavBearing", e.target.checked)}
                data-testid="ps-show-nav-bearing"
              />
              Show Navigation Bearing
            </label>
          </div>
          <div className="ps-field ps-field--checkbox">
            <label className="ps-label">
              <input
                type="checkbox"
                checked={prefs.showRadius}
                onChange={(e) => update("showRadius", e.target.checked)}
                data-testid="ps-show-radius"
              />
              Show Waypoint Radius
            </label>
          </div>
          <div className="ps-field ps-field--checkbox">
            <label className="ps-label">
              <input
                type="checkbox"
                checked={prefs.showTarget}
                onChange={(e) => update("showTarget", e.target.checked)}
                data-testid="ps-show-target"
              />
              Show Target Marker
            </label>
          </div>
        </div>
      </div>

      {/* Connection */}
      <div className="ps-section" data-testid="ps-section-connection">
        <div className="ps-section-header">Connection</div>
        <div className="ps-section-body">
          <div className="ps-field ps-field--checkbox">
            <label className="ps-label">
              <input
                type="checkbox"
                checked={prefs.loadWpOnConnect}
                onChange={(e) => update("loadWpOnConnect", e.target.checked)}
                data-testid="ps-load-wp-on-connect"
              />
              Load waypoints on connect
            </label>
          </div>
          <div className="ps-field ps-field--checkbox">
            <label className="ps-label">
              <input
                type="checkbox"
                checked={prefs.autoParamCommit}
                onChange={(e) => update("autoParamCommit", e.target.checked)}
                data-testid="ps-auto-param-commit"
              />
              Auto-commit parameter changes
            </label>
          </div>
          <div className="ps-field">
            <label className="ps-label">Status Message Severity</label>
            <select
              className="ps-select"
              value={prefs.severityFilter}
              onChange={(e) => update("severityFilter", parseInt(e.target.value))}
              data-testid="ps-severity-filter"
            >
              <option value={0}>EMERGENCY</option>
              <option value={1}>ALERT</option>
              <option value={2}>CRITICAL</option>
              <option value={3}>ERROR</option>
              <option value={4}>WARNING</option>
              <option value={5}>NOTICE</option>
              <option value={6}>INFO</option>
              <option value={7}>DEBUG</option>
            </select>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="ps-actions" data-testid="ps-actions">
        <button
          type="button"
          className="ps-reset-btn"
          onClick={handleReset}
          data-testid="ps-reset-btn"
        >
          <RotateCcw size={13} />
          Reset to Defaults
        </button>
        <button
          type="button"
          className="ps-save-btn"
          onClick={handleSave}
          data-testid="ps-save-btn"
        >
          <Save size={13} />
          {saved ? "Saved!" : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
