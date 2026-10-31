import { useMemo, useState, useCallback } from "react";
import {
  Monitor,
  Save,
  Loader,
  AlertTriangle,
  Info,
  RotateCcw,
  X,
  Eye,
  EyeOff,
} from "lucide-react";

import { useParameters } from "../../context/ParameterContext";
import useSocketTelemetry from "../../hooks/useSocketTelemetry";
import { isCopterVehicle } from "../../parameters/flightModesLogic";

import "../../styles/osdConfig.css";

/* ------------------------------------------------------------------ */
/* OSD element definitions                                             */
/* ------------------------------------------------------------------ */

interface OsdElement {
  id: string;
  label: string;
  description: string;
  defaultX: number;
  defaultY: number;
}

const OSD_ELEMENTS: OsdElement[] = [
  { id: "ALTITUDE", label: "Altitude", description: "Home-relative altitude (AGL)", defaultX: 23, defaultY: 8 },
  { id: "BAT_VOLT", label: "Battery Voltage", description: "Main battery voltage", defaultX: 24, defaultY: 1 },
  { id: "RSSI", label: "RSSI", description: "RC signal strength", defaultX: 1, defaultY: 1 },
  { id: "CURRENT", label: "Current", description: "Main battery current", defaultX: 25, defaultY: 2 },
  { id: "BATUSED", label: "Battery Used", description: "Battery mAh consumed", defaultX: 23, defaultY: 3 },
  { id: "SATS", label: "Satellites", description: "GPS satellite count", defaultX: 1, defaultY: 3 },
  { id: "FLTMODE", label: "Flight Mode", description: "Current flight mode", defaultX: 2, defaultY: 8 },
  { id: "MESSAGE", label: "Messages", description: "Status messages", defaultX: 2, defaultY: 6 },
  { id: "GSPEED", label: "Ground Speed", description: "GPS ground speed", defaultX: 2, defaultY: 14 },
  { id: "HORIZON", label: "Horizon", description: "Artificial horizon", defaultX: 14, defaultY: 8 },
  { id: "HOME", label: "Home", description: "Distance/direction to home", defaultX: 14, defaultY: 1 },
  { id: "HEADING", label: "Heading", description: "Heading with compass", defaultX: 13, defaultY: 2 },
  { id: "THROTTLE", label: "Throttle", description: "Throttle percentage", defaultX: 24, defaultY: 11 },
  { id: "COMPASS", label: "Compass", description: "Compass rose", defaultX: 15, defaultY: 3 },
  { id: "WIND", label: "Wind", description: "Wind speed/direction", defaultX: 2, defaultY: 12 },
  { id: "ASPEED", label: "Airspeed", description: "TECS airspeed (fused)", defaultX: 2, defaultY: 13 },
  { id: "VSPEED", label: "Vertical Speed", description: "Climb rate", defaultX: 24, defaultY: 9 },
  { id: "GPSLAT", label: "GPS Latitude", description: "GPS latitude", defaultX: 9, defaultY: 13 },
  { id: "GPSLONG", label: "GPS Longitude", description: "GPS longitude", defaultX: 9, defaultY: 14 },
  { id: "ROLL", label: "Roll Angle", description: "Roll angle in degrees", defaultX: 0, defaultY: 0 },
  { id: "PITCH", label: "Pitch Angle", description: "Pitch angle in degrees", defaultX: 0, defaultY: 0 },
  { id: "HDOP", label: "HDOP", description: "Horizontal dilution of position", defaultX: 0, defaultY: 0 },
  { id: "WAYPOINT", label: "Waypoint", description: "Bearing/distance to waypoint", defaultX: 0, defaultY: 0 },
  { id: "DIST", label: "Distance", description: "Total distance flown", defaultX: 22, defaultY: 11 },
  { id: "FLTIME", label: "Flight Time", description: "Flight time", defaultX: 23, defaultY: 10 },
  { id: "EFF", label: "Efficiency", description: "Flight efficiency (mAh/km)", defaultX: 22, defaultY: 10 },
  { id: "SIDEBARS", label: "Sidebars", description: "AH side bars", defaultX: 4, defaultY: 5 },
  { id: "FENCE", label: "Fence Status", description: "Fence enable/breach status", defaultX: 14, defaultY: 9 },
];

const OSD_SCREENS = [1, 2, 3, 4];

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function OsdConfig() {
  const store = useParameters();
  const telemetry = useSocketTelemetry();

  const connected = store.connection === "READY";
  const vehicleType = store.vehicleType ?? telemetry?.vehicleType ?? null;
  const isCopter = isCopterVehicle(vehicleType);

  const [activeScreen, setActiveScreen] = useState(1);

  /* ---- detect OSD support ---- */
  const osdSupported = useMemo(() => {
    return !!store.entries["OSD_TYPE"];
  }, [store.entries]);

  /* ---- resolve per-screen element params ---- */
  const elementStates = useMemo(() => {
    const prefix = `OSD${activeScreen}_`;
    const result: Record<string, { enabled: boolean; x: number; y: number; enExists: boolean; xExists: boolean; yExists: boolean }> = {};
    for (const elem of OSD_ELEMENTS) {
      const enId = `${prefix}${elem.id}_EN`;
      const xId = `${prefix}${elem.id}_X`;
      const yId = `${prefix}${elem.id}_Y`;
      const enEntry = store.entries[enId];
      const xEntry = store.entries[xId];
      const yEntry = store.entries[yId];
      const enStaged = store.staged[enId]?.stagedValue;
      const xStaged = store.staged[xId]?.stagedValue;
      const yStaged = store.staged[yId]?.stagedValue;
      result[elem.id] = {
        enabled: (enStaged ?? enEntry?.live?.value ?? 0) === 1,
        x: xStaged ?? xEntry?.live?.value ?? elem.defaultX,
        y: yStaged ?? yEntry?.live?.value ?? elem.defaultY,
        enExists: !!enEntry,
        xExists: !!xEntry,
        yExists: !!yEntry,
      };
    }
    return result;
  }, [store.entries, store.staged, activeScreen]);

  /* ---- staged count ---- */
  const stagedCount = useMemo(() => {
    let count = 0;
    const prefix = `OSD${activeScreen}_`;
    for (const elem of OSD_ELEMENTS) {
      if (store.staged[`${prefix}${elem.id}_EN`] !== undefined) count++;
      if (store.staged[`${prefix}${elem.id}_X`] !== undefined) count++;
      if (store.staged[`${prefix}${elem.id}_Y`] !== undefined) count++;
    }
    return count;
  }, [store.staged, activeScreen]);

  /* ---- elements exposed by the connected firmware for this screen ---- */
  const availableElements = useMemo(
    () => OSD_ELEMENTS.filter((e) => elementStates[e.id]?.enExists),
    [elementStates]
  );

  const hasChanges = stagedCount > 0;

  /* ---- handlers ---- */
  const handleToggle = useCallback(
    (elemId: string) => {
      const prefix = `OSD${activeScreen}_`;
      const enId = `${prefix}${elemId}_EN`;
      const current = elementStates[elemId]?.enabled ? 1 : 0;
      store.stageValue(enId, current === 1 ? 0 : 1);
    },
    [activeScreen, elementStates, store]
  );

  const handlePositionChange = useCallback(
    (elemId: string, axis: "X" | "Y", value: string) => {
      const num = parseInt(value);
      if (isNaN(num)) return;
      const prefix = `OSD${activeScreen}_`;
      store.stageValue(`${prefix}${elemId}_${axis}`, num);
    },
    [activeScreen, store]
  );

  const handleRevert = useCallback(
    (elemId: string) => {
      const prefix = `OSD${activeScreen}_`;
      store.revert(`${prefix}${elemId}_EN`);
      store.revert(`${prefix}${elemId}_X`);
      store.revert(`${prefix}${elemId}_Y`);
    },
    [activeScreen, store]
  );

  const handleDiscardAll = useCallback(() => {
    const prefix = `OSD${activeScreen}_`;
    for (const elem of OSD_ELEMENTS) {
      store.revert(`${prefix}${elem.id}_EN`);
      store.revert(`${prefix}${elem.id}_X`);
      store.revert(`${prefix}${elem.id}_Y`);
    }
  }, [activeScreen, store]);

  const handleSave = useCallback(() => {
    store.executeWrite();
  }, [store]);

  /* ---- guard: disconnected ---- */
  if (!connected) {
    return (
      <div className="osd-screen" data-testid="osd-screen">
        <div className="osd-header"><Monitor size={16} /><span>OnBoard OSD</span></div>
        <div className="osd-disconnected" data-testid="osd-disconnected">
          <AlertTriangle size={20} />
          <p>Vehicle not connected.</p>
        </div>
      </div>
    );
  }

  if (!isCopter) {
    return (
      <div className="osd-screen" data-testid="osd-screen">
        <div className="osd-header"><Monitor size={16} /><span>OnBoard OSD</span></div>
        <div className="osd-disconnected" data-testid="osd-non-copter">
          <AlertTriangle size={20} />
          <p>OnBoard OSD is available only for ArduCopter vehicles.</p>
        </div>
      </div>
    );
  }

  if (!osdSupported) {
    return (
      <div className="osd-screen" data-testid="osd-screen">
        <div className="osd-header"><Monitor size={16} /><span>OnBoard OSD</span></div>
        <div className="osd-disconnected" data-testid="osd-unsupported">
          <Info size={20} />
          <p>Onboard OSD is not available on this vehicle/firmware.</p>
          <p className="osd-disconnected-hint">The OSD_TYPE parameter was not found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="osd-screen" data-testid="osd-screen">
      <div className="osd-header">
        <Monitor size={16} />
        <span>OnBoard OSD</span>
        {stagedCount > 0 && (
          <span className="osd-staged-badge" data-testid="osd-staged-count">{stagedCount} modified</span>
        )}
      </div>

      <div className="osd-description">
        <Info size={14} />
        <span>Configure OSD screen elements. Toggle visibility and reposition elements for screen {activeScreen}.</span>
      </div>

      {/* Screen selector */}
      <div className="osd-screen-tabs" data-testid="osd-screen-tabs">
        {OSD_SCREENS.map((n) => {
          const enabled = (store.entries[`OSD${n}_ENABLE`]?.live?.value ?? 0) === 1;
          return (
            <button
              key={n}
              type="button"
              className={`osd-screen-tab ${activeScreen === n ? "osd-screen-tab--active" : ""}`}
              onClick={() => setActiveScreen(n)}
              data-testid={`osd-screen-tab-${n}`}
            >
              Screen {n}
              {enabled !== undefined && (
                <span className={`osd-screen-dot ${enabled ? "osd-screen-dot--on" : ""}`} />
              )}
            </button>
          );
        })}
      </div>

      {/* Actions */}
      {hasChanges && (
        <div className="osd-action-bar" data-testid="osd-action-bar">
          <button type="button" className="osd-discard-btn" onClick={handleDiscardAll} data-testid="osd-discard-btn">
            <X size={13} /> Discard All
          </button>
        </div>
      )}

      {/* OSD preview */}
      <div className="osd-preview" data-testid="osd-preview">
        <div className="osd-preview-label">OSD Screen {activeScreen} Preview</div>
        <div className="osd-preview-grid">
          {availableElements.filter((e) => elementStates[e.id]?.enabled).map((elem) => {
            const state = elementStates[elem.id];
            if (!state?.enabled) return null;
            const left = (state.x / 60) * 100;
            const top = (state.y / 24) * 100;
            return (
              <div
                key={elem.id}
                className="osd-preview-item"
                style={{ left: `${left}%`, top: `${top}%` }}
                title={`${elem.label} (${state.x}, ${state.y})`}
              >
                {elem.label}
              </div>
            );
          })}
        </div>
      </div>

      {/* Element list */}
      <div className="osd-elements" data-testid="osd-elements">
        {availableElements.length === 0 && (
          <div className="osd-elements-empty" data-testid="osd-elements-empty">
            <Info size={14} />
            <span>
              This firmware exposes OSD support (OSD_TYPE) but no OSD element
              parameters for screen {activeScreen}. Enable the OSD in the
              firmware (OSD_TYPE) or load OSD parameters to configure elements.
            </span>
          </div>
        )}
        {availableElements.map((elem) => {
            const state = elementStates[elem.id];
            if (!state) return null;
            return (
            <div key={elem.id} className={`osd-elem-row ${state.enabled ? "" : "osd-elem-row--disabled"}`} data-testid={`osd-elem-${elem.id}`}>
              <div className="osd-elem-info">
                <span className="osd-elem-label">{elem.label}</span>
                <span className="osd-elem-desc">{elem.description}</span>
              </div>
              <div className="osd-elem-controls">
                <button
                  type="button"
                  className={`osd-toggle-btn ${state.enabled ? "osd-toggle-btn--on" : ""}`}
                  onClick={() => handleToggle(elem.id)}
                  title={state.enabled ? "Disable element" : "Enable element"}
                  data-testid={`osd-toggle-${elem.id}`}
                >
                  {state.enabled ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                {state.enabled && (
                  <>
                    <label className="osd-pos-label">X</label>
                    <input
                      type="number"
                      className="osd-pos-input"
                      value={state.x}
                      min={0}
                      max={59}
                      onChange={(e) => handlePositionChange(elem.id, "X", e.target.value)}
                      data-testid={`osd-x-${elem.id}`}
                    />
                    <label className="osd-pos-label">Y</label>
                    <input
                      type="number"
                      className="osd-pos-input"
                      value={state.y}
                      min={0}
                      max={23}
                      onChange={(e) => handlePositionChange(elem.id, "Y", e.target.value)}
                      data-testid={`osd-y-${elem.id}`}
                    />
                    <button type="button" className="osd-revert-btn" onClick={() => handleRevert(elem.id)} title="Revert" data-testid={`osd-revert-${elem.id}`}>
                      <RotateCcw size={12} />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Save */}
      <div className="osd-actions">
        <button type="button" className="osd-save-btn" onClick={handleSave} disabled={!hasChanges || store.writePhase === "running"} data-testid="osd-save-btn">
          {store.writePhase === "running" ? <Loader size={14} className="osd-spinner" /> : <Save size={14} />}
          {store.writePhase === "running" ? "Saving..." : `Save OSD${stagedCount > 0 ? ` (${stagedCount})` : ""}`}
        </button>
      </div>
    </div>
  );
}
