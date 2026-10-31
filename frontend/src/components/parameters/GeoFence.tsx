import { useMemo } from "react";
import { Shield, Save, Loader, AlertTriangle, Info } from "lucide-react";

import { useParameters } from "../../context/ParameterContext";
import useSocketTelemetry from "../../hooks/useSocketTelemetry";

import {
  decodeFenceType,
  encodeFenceType,
  FENCE_TYPE_OPTIONS,
  FENCE_ACTIONS,
  GEOFENCE_PARAMS,
  isCopterVehicleType,
  type FenceTypeBit,
} from "../../parameters/geoFenceLogic";

import "../../styles/geoFence.css";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function readParam(
  entries: Record<string, any>,
  staged: Record<string, any>,
  paramId: string
): { live: number | null; staged: number | null; effective: number | null } {
  const entry = entries[paramId];
  const st = staged[paramId];
  const live = entry?.live?.value ?? null;
  const stagedVal = st?.stagedValue ?? null;
  return { live, staged: stagedVal, effective: stagedVal ?? live };
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function GeoFence() {
  const store = useParameters();
  const telemetry = useSocketTelemetry();

  const connected = store.connection === "READY";
  const vehicleType = store.vehicleType ?? telemetry?.vehicleType ?? null;
  const isCopter = isCopterVehicleType(vehicleType);

  /* ---- Read fence params ---- */
  const enable = readParam(store.entries, store.staged, "FENCE_ENABLE");
  const fenceType = readParam(store.entries, store.staged, "FENCE_TYPE");
  const action = readParam(store.entries, store.staged, "FENCE_ACTION");
  const altMax = readParam(store.entries, store.staged, "FENCE_ALT_MAX");
  const altMin = readParam(store.entries, store.staged, "FENCE_ALT_MIN");
  const radius = readParam(store.entries, store.staged, "FENCE_RADIUS");
  const margin = readParam(store.entries, store.staged, "FENCE_MARGIN");
  const total = readParam(store.entries, store.staged, "FENCE_TOTAL");
  const autoEnable = readParam(store.entries, store.staged, "FENCE_AUTOENABLE");
  const marginXY = readParam(store.entries, store.staged, "FENCE_MARGIN_XY");

  /* ---- Decode FENCE_TYPE bitmask ---- */
  const typeFlags = useMemo(
    () => decodeFenceType(fenceType.effective ?? 0),
    [fenceType.effective]
  );

  /* ---- Has changes? ---- */
  const hasChanges = useMemo(() => {
    return GEOFENCE_PARAMS.some((pid) => store.staged[pid] !== undefined);
  }, [store.staged]);

  const stagedCount = useMemo(() => {
    let count = 0;
    for (const pid of GEOFENCE_PARAMS) {
      if (store.staged[pid] !== undefined) count++;
    }
    return count;
  }, [store.staged]);

  /* ---- Handlers ---- */
  function handleEnableChange(value: number) {
    store.stageValue("FENCE_ENABLE", value);
  }

  function handleTypeToggle(bit: FenceTypeBit) {
    const current = fenceType.effective ?? 0;
    const flags = decodeFenceType(current);
    flags[bit] = !flags[bit];
    store.stageValue("FENCE_TYPE", encodeFenceType(flags));
  }

  function handleActionChange(value: number) {
    store.stageValue("FENCE_ACTION", value);
  }

  function handleNumericChange(paramId: string, value: number) {
    store.stageValue(paramId, value);
  }

  function handleSave() {
    store.executeWrite();
  }

  /* ---- Disconnected state ---- */
  if (!connected) {
    return (
      <div className="gf-screen" data-testid="gf-screen">
        <div className="gf-header">
          <Shield size={16} />
          <span>GeoFence</span>
        </div>
        <div className="gf-disconnected" data-testid="gf-disconnected">
          <AlertTriangle size={20} />
          <p>Vehicle not connected.</p>
          <p className="gf-disconnected-hint">
            Connect to an ArduCopter vehicle to configure GeoFence.
          </p>
        </div>
      </div>
    );
  }

  /* ---- Non-copter vehicle ---- */
  if (!isCopter) {
    return (
      <div className="gf-screen" data-testid="gf-screen">
        <div className="gf-header">
          <Shield size={16} />
          <span>GeoFence</span>
        </div>
        <div className="gf-disconnected" data-testid="gf-non-copter">
          <AlertTriangle size={20} />
          <p>GeoFence is available for ArduCopter vehicles.</p>
          <p className="gf-disconnected-hint">
            Detected vehicle: {vehicleType ?? "Unknown"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="gf-screen" data-testid="gf-screen">
      <div className="gf-header">
        <Shield size={16} />
        <span>GeoFence</span>
        {stagedCount > 0 && (
          <span className="gf-staged-badge" data-testid="gf-staged-count">
            {stagedCount} modified
          </span>
        )}
      </div>

      <div className="gf-description">
        <Info size={14} />
        <span>
          Configure fence parameters for ArduCopter. Polygon/circular fence
          geometry is configured in PLAN → FENCES.
        </span>
      </div>

      {/* ---- Enable ---- */}
      <div className="gf-section">
        <div className="gf-row">
          <label className="gf-label">GeoFence</label>
          <div className="gf-toggle-group">
            <button
              type="button"
              className={`gf-toggle ${enable.effective === 1 ? "gf-toggle--on" : ""}`}
              onClick={() => handleEnableChange(enable.effective === 1 ? 0 : 1)}
              disabled={!connected}
              data-testid="gf-enable-toggle"
            >
              {enable.effective === 1 ? "Enabled" : "Disabled"}
            </button>
            {enable.staged !== null && enable.staged !== enable.live && (
              <span className="gf-modified-badge">Modified</span>
            )}
          </div>
        </div>
      </div>

      {/* ---- Fence Types (bitmask) ---- */}
      <div className="gf-section">
        <div className="gf-section-title">Fence Types</div>
        <div className="gf-checkbox-group" data-testid="gf-type-checkboxes">
          {FENCE_TYPE_OPTIONS.map((opt) => {
            const checked = typeFlags[opt.param as FenceTypeBit];
            return (
              <label key={opt.param} className="gf-checkbox-label">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => handleTypeToggle(opt.param as FenceTypeBit)}
                  disabled={!connected}
                  data-testid={`gf-type-${opt.param.toLowerCase()}`}
                />
                <span className="gf-checkbox-text">{opt.label}</span>
              </label>
            );
          })}
          {fenceType.staged !== null && fenceType.staged !== fenceType.live && (
            <span className="gf-modified-badge">Modified</span>
          )}
        </div>
      </div>

      {/* ---- Numeric parameters ---- */}
      <div className="gf-section">
        <div className="gf-section-title">Altitude Limits</div>

        {/* Max Altitude */}
        <div className="gf-param-row" data-testid="gf-alt-max">
          <div className="gf-param-info">
            <span className="gf-param-label">Maximum Altitude</span>
            <span className="gf-param-id">FENCE_ALT_MAX</span>
          </div>
          <div className="gf-param-control">
            <input
              type="number"
              className="gf-input"
              min={10}
              max={1000}
              step={1}
              value={altMax.effective ?? 100}
              onChange={(e) =>
                handleNumericChange("FENCE_ALT_MAX", parseFloat(e.target.value) || 100)
              }
              disabled={!connected}
              data-testid="gf-alt-max-input"
            />
            <span className="gf-unit">m</span>
          </div>
          <div className="gf-param-meta">
            {altMax.live !== null && (
              <span className="gf-current">Current: {altMax.live} m</span>
            )}
            {altMax.staged !== null && altMax.staged !== altMax.live && (
              <span className="gf-modified-badge">Modified</span>
            )}
          </div>
        </div>

        {/* Min Altitude */}
        <div className="gf-param-row" data-testid="gf-alt-min">
          <div className="gf-param-info">
            <span className="gf-param-label">Minimum Altitude</span>
            <span className="gf-param-id">FENCE_ALT_MIN</span>
          </div>
          <div className="gf-param-control">
            <input
              type="number"
              className="gf-input"
              min={-100}
              max={100}
              step={1}
              value={altMin.effective ?? -10}
              onChange={(e) =>
                handleNumericChange("FENCE_ALT_MIN", parseFloat(e.target.value) || -10)
              }
              disabled={!connected}
              data-testid="gf-alt-min-input"
            />
            <span className="gf-unit">m</span>
          </div>
          <div className="gf-param-meta">
            {altMin.live !== null && (
              <span className="gf-current">Current: {altMin.live} m</span>
            )}
            {altMin.staged !== null && altMin.staged !== altMin.live && (
              <span className="gf-modified-badge">Modified</span>
            )}
          </div>
        </div>
      </div>

      {/* ---- Circular Fence ---- */}
      <div className="gf-section">
        <div className="gf-section-title">Circular Fence</div>

        <div className="gf-param-row" data-testid="gf-radius">
          <div className="gf-param-info">
            <span className="gf-param-label">Circular Radius</span>
            <span className="gf-param-id">FENCE_RADIUS</span>
          </div>
          <div className="gf-param-control">
            <input
              type="number"
              className="gf-input"
              min={30}
              max={10000}
              step={10}
              value={radius.effective ?? 150}
              onChange={(e) =>
                handleNumericChange("FENCE_RADIUS", parseFloat(e.target.value) || 150)
              }
              disabled={!connected}
              data-testid="gf-radius-input"
            />
            <span className="gf-unit">m</span>
          </div>
          <div className="gf-param-meta">
            {radius.live !== null && (
              <span className="gf-current">Current: {radius.live} m</span>
            )}
            {radius.staged !== null && radius.staged !== radius.live && (
              <span className="gf-modified-badge">Modified</span>
            )}
          </div>
        </div>
      </div>

      {/* ---- Margin ---- */}
      <div className="gf-section">
        <div className="gf-section-title">Fence Margin</div>

        <div className="gf-param-row" data-testid="gf-margin">
          <div className="gf-param-info">
            <span className="gf-param-label">Vertical Margin</span>
            <span className="gf-param-id">FENCE_MARGIN</span>
          </div>
          <div className="gf-param-control">
            <input
              type="number"
              className="gf-input"
              min={1}
              max={10}
              step={0.5}
              value={margin.effective ?? 2}
              onChange={(e) =>
                handleNumericChange("FENCE_MARGIN", parseFloat(e.target.value) || 2)
              }
              disabled={!connected}
              data-testid="gf-margin-input"
            />
            <span className="gf-unit">m</span>
          </div>
          <div className="gf-param-meta">
            {margin.live !== null && (
              <span className="gf-current">Current: {margin.live} m</span>
            )}
            {margin.staged !== null && margin.staged !== margin.live && (
              <span className="gf-modified-badge">Modified</span>
            )}
          </div>
        </div>

        <div className="gf-param-row" data-testid="gf-margin-xy">
          <div className="gf-param-info">
            <span className="gf-param-label">Horizontal Margin</span>
            <span className="gf-param-id">FENCE_MARGIN_XY</span>
          </div>
          <div className="gf-param-control">
            <input
              type="number"
              className="gf-input"
              min={0}
              max={50}
              step={1}
              value={marginXY.effective ?? 0}
              onChange={(e) =>
                handleNumericChange("FENCE_MARGIN_XY", parseFloat(e.target.value) || 0)
              }
              disabled={!connected}
              data-testid="gf-margin-xy-input"
            />
            <span className="gf-unit">m</span>
          </div>
          <div className="gf-param-meta">
            {marginXY.live !== null && (
              <span className="gf-current">Current: {marginXY.live} m</span>
            )}
            {marginXY.staged !== null && marginXY.staged !== marginXY.live && (
              <span className="gf-modified-badge">Modified</span>
            )}
          </div>
        </div>
      </div>

      {/* ---- Breach Action ---- */}
      <div className="gf-section">
        <div className="gf-section-title">Breach Action</div>

        <div className="gf-param-row" data-testid="gf-action">
          <div className="gf-param-info">
            <span className="gf-param-label">Fence Breach Action</span>
            <span className="gf-param-id">FENCE_ACTION</span>
          </div>
          <div className="gf-param-control">
            <select
              className="gf-select"
              value={action.effective ?? 1}
              onChange={(e) => handleActionChange(parseInt(e.target.value))}
              disabled={!connected}
              data-testid="gf-action-select"
            >
              {FENCE_ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="gf-param-meta">
            {action.staged !== null && action.staged !== action.live && (
              <span className="gf-modified-badge">Modified</span>
            )}
          </div>
        </div>
      </div>

      {/* ---- Auto-Enable ---- */}
      <div className="gf-section">
        <div className="gf-section-title">Auto-Enable</div>

        <div className="gf-param-row" data-testid="gf-autoenable">
          <div className="gf-param-info">
            <span className="gf-param-label">Auto-Enable Mode</span>
            <span className="gf-param-id">FENCE_AUTOENABLE</span>
          </div>
          <div className="gf-param-control">
            <select
              className="gf-select"
              value={autoEnable.effective ?? 0}
              onChange={(e) =>
                handleNumericChange("FENCE_AUTOENABLE", parseInt(e.target.value))
              }
              disabled={!connected}
              data-testid="gf-autoenable-select"
            >
              <option value={0}>Off</option>
              <option value={1}>On Takeoff</option>
              <option value={2}>Disable Floor on Landing</option>
              <option value={3}>Only When Armed</option>
            </select>
          </div>
          <div className="gf-param-meta">
            {autoEnable.staged !== null && autoEnable.staged !== autoEnable.live && (
              <span className="gf-modified-badge">Modified</span>
            )}
          </div>
        </div>
      </div>

      {/* ---- Polygon Info (read-only) ---- */}
      <div className="gf-section">
        <div className="gf-section-title">Polygon Fence</div>
        <div className="gf-param-row" data-testid="gf-total">
          <div className="gf-param-info">
            <span className="gf-param-label">Polygon Points</span>
            <span className="gf-param-id">FENCE_TOTAL</span>
          </div>
          <div className="gf-param-value">
            {total.effective ?? 0}
          </div>
          <div className="gf-param-hint">
            Configure in PLAN → FENCES
          </div>
        </div>
      </div>

      {/* ---- Save button ---- */}
      <div className="gf-actions">
        <button
          type="button"
          className="gf-save-btn"
          onClick={handleSave}
          disabled={!hasChanges || store.writePhase === "running"}
          data-testid="gf-save-btn"
        >
          {store.writePhase === "running" ? (
            <Loader size={14} className="gf-spinner" />
          ) : (
            <Save size={14} />
          )}
          {store.writePhase === "running"
            ? "Saving..."
            : `Save Fence Settings${stagedCount > 0 ? ` (${stagedCount})` : ""}`}
        </button>
      </div>
    </div>
  );
}
