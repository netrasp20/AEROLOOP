import { useEffect, useMemo, useState } from "react";
import { Radio, Save, Loader, AlertTriangle } from "lucide-react";

import { useParameters } from "../../context/ParameterContext";
import { useTelemetry } from "../../hooks/useTelemetry";

import {
  FM_SLOTS,
  FM_CHANNEL_OPTIONS,
  FLTMODE_CH_PARAM,
  FM_CHANNEL_DISABLED,
  RC_STALE_MS,
  getCopterModes,
  modesFromVehicleMetadata,
  modeName,
  activeModeName,
  positionForActiveMode,
  slotModeCode,
  isFlightModeCapable,
  resolveSwitchPosition,
  switchPositionText,
  channelLabel,
  copterGate,
} from "../../parameters/flightModesLogic";

import "../../styles/flightModes.css";

export default function FlightModes() {
  const store = useParameters();
  const telemetry = useTelemetry();

  const connected = store.connection === "READY";
  const vehicleType = store.vehicleType ?? telemetry?.vehicleType ?? null;
  const gate = copterGate(vehicleType);
  const capable = isFlightModeCapable(store.entries);

  const modes = useMemo(() => getCopterModes(store.entries), [store.entries]);
  const metadataDriven = useMemo(
    () => modesFromVehicleMetadata(store.entries),
    [store.entries]
  );

  // FLTMODE_CH — never defaulted. An absent parameter is UNKNOWN, not channel 5.
  const fltModeChEntry = store.entries[FLTMODE_CH_PARAM];
  const fltModeChLive = fltModeChEntry?.live?.value ?? null;
  const fltModeChStaged = store.staged[FLTMODE_CH_PARAM] ?? null;
  const effectiveChannel =
    fltModeChStaged?.stagedValue ?? fltModeChLive ?? null;
  const channelDisplay = channelLabel(effectiveChannel);

  // Raw HEARTBEAT.custom_mode → authoritative name. Never from a dropdown.
  const modeCode =
    telemetry?.modeCode ??
    (telemetry?.mode
      ? (() => {
          const m = modes.find((mm) => mm.name.toUpperCase() === telemetry.mode.toUpperCase());
          return m?.value ?? null;
        })()
      : null);
  const activeMode = activeModeName(modeCode, store.entries, modes) ?? telemetry?.mode ?? null;

  // Live switch position from the mode channel's real PWM.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const position = useMemo(
    () => resolveSwitchPosition(effectiveChannel, telemetry ?? null, now),
    [effectiveChannel, telemetry, now]
  );

  // The single position whose assigned mode equals the active mode. Null when
  // the active mode came from a GCS command / aux function, or is unassigned, or
  // the same mode is assigned twice.
  const matchingSlot = useMemo(
    () => positionForActiveMode(modeCode, store.entries),
    [modeCode, store.entries]
  );

  const hasChanges = useMemo(() => {
    const channelChanged =
      fltModeChStaged !== null && fltModeChStaged.stagedValue !== fltModeChLive;
    const modesChanged = FM_SLOTS.some(
      (slot) => store.staged[slot.paramId] !== undefined
    );
    return channelChanged || modesChanged;
  }, [store.staged, fltModeChLive, fltModeChStaged]);

  const stagedCount = useMemo(() => {
    let count = 0;
    if (
      fltModeChStaged !== null &&
      fltModeChStaged.stagedValue !== fltModeChLive
    ) {
      count++;
    }
    for (const slot of FM_SLOTS) {
      if (store.staged[slot.paramId] !== undefined) count++;
    }
    return count;
  }, [store.staged, fltModeChLive, fltModeChStaged]);

  function handleChannelChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newChannel = Number(e.target.value);
    if (Number.isFinite(newChannel) && fltModeChEntry) {
      store.stageValue(FLTMODE_CH_PARAM, newChannel);
    }
  }

  function handleModeChange(slotParamId: string, value: number) {
    store.stageValue(slotParamId, value);
  }

  function handleSave() {
    store.executeWrite();
  }

  if (!connected) {
    return (
      <div className="fm-screen" data-testid="fm-screen">
        <div className="fm-header">
          <Radio size={16} />
          <span>Flight Modes</span>
        </div>
        <div className="fm-disconnected" data-testid="fm-disconnected">
          <AlertTriangle size={20} />
          <p>Vehicle not connected.</p>
          <p className="fm-disconnected-hint">
            Connect to an ArduCopter vehicle to configure flight modes.
          </p>
        </div>
      </div>
    );
  }

  if (gate === "NOT_COPTER") {
    return (
      <div className="fm-screen" data-testid="fm-screen">
        <div className="fm-header">
          <Radio size={16} />
          <span>Flight Modes</span>
        </div>
        <div className="fm-disconnected" data-testid="fm-non-copter">
          <AlertTriangle size={20} />
          <p>Flight modes are only available for ArduCopter vehicles.</p>
          <p className="fm-disconnected-hint">
            Detected vehicle: {vehicleType ?? "Unknown"}
          </p>
        </div>
      </div>
    );
  }

  if (!capable) {
    return (
      <div className="fm-screen" data-testid="fm-screen">
        <div className="fm-header">
          <Radio size={16} />
          <span>Flight Modes</span>
        </div>
        <div className="fm-disconnected" data-testid="fm-unsupported">
          <AlertTriangle size={20} />
          <p>Flight mode switch configuration is unsupported on this firmware.</p>
          <p className="fm-disconnected-hint">
            No FLTMODE1–FLTMODE6 or FLTMODE_CH parameter was reported by the
            vehicle.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fm-screen" data-testid="fm-screen">
      <div className="fm-header">
        <Radio size={16} />
        <span>Flight Modes</span>
        {position.kind === "OK" && (
          <span className="fm-active-badge" data-testid="fm-switch-badge">
            Switch: Position {position.position}
          </span>
        )}
      </div>

      {gate === "UNKNOWN" && (
        <div className="fm-notice" data-testid="fm-vehicle-unknown">
          Vehicle type not reported. Showing ArduCopter flight mode configuration.
        </div>
      )}

      {/* Three separate facts: active mode, mode channel, switch position. */}
      <div className="fm-facts">
        <div className="fm-fact">
          <span className="fm-fact-label">Active flight mode</span>
          <span className="fm-fact-value" data-testid="fm-active-mode">
            {activeMode ?? (telemetry?.mode ?? "UNKNOWN")}
          </span>
          <span className="fm-fact-source">from vehicle telemetry</span>
        </div>

        <div className="fm-fact">
          <span className="fm-fact-label">Mode channel</span>
          <span className="fm-fact-value" data-testid="fm-channel-value">
            {channelDisplay ?? "UNKNOWN"}
          </span>
          <span className="fm-fact-source">from FLTMODE_CH</span>
        </div>

        <div className="fm-fact">
          <span className="fm-fact-label">Switch position</span>
          <span
            className="fm-fact-value"
            data-testid="fm-switch-position"
            data-state={position.kind}
          >
            {switchPositionText(position)}
          </span>
          <span className="fm-fact-source">
            {position.kind === "OK"
              ? `PWM ${position.pwm} µs`
              : `stale after ${RC_STALE_MS} ms`}
          </span>
        </div>
      </div>

      {/* Flight mode channel */}
      <div className="fm-channel-row">
        <label className="fm-channel-label" htmlFor="fm-channel">
          Flight Mode Channel
        </label>
        <select
          id="fm-channel"
          className="fm-channel-select"
          value={effectiveChannel ?? ""}
          onChange={handleChannelChange}
          disabled={!connected}
          data-testid="fm-channel-select"
        >
          {/* Honest placeholder: an absent FLTMODE_CH is UNKNOWN, never "Channel 5". */}
          {effectiveChannel === null && (
            <option value="" disabled>
              UNKNOWN
            </option>
          )}
          {FM_CHANNEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {fltModeChStaged !== null &&
          fltModeChStaged.stagedValue !== fltModeChLive && (
            <span className="fm-staged-indicator" data-testid="fm-channel-modified">
              Modified
            </span>
          )}
      </div>

      {effectiveChannel === FM_CHANNEL_DISABLED && (
        <div className="fm-notice fm-notice--warn" data-testid="fm-channel-disabled">
          FLTMODE_CH is 0 (Disabled). The autopilot is not monitoring any RC
          flight-mode channel; these six positions are stored but inactive.
        </div>
      )}

      {/* Six switch positions */}
      <div className="fm-slots">
        {FM_SLOTS.map((slot) => {
          const liveValue = slotModeCode(slot, store.entries);
          const staged = store.staged[slot.paramId];
          const effectiveValue = staged?.stagedValue ?? liveValue;
          const isModified = staged !== undefined;
          const isSwitchHere = position.kind === "OK" && position.position === slot.index;
          const isActive = matchingSlot?.index === slot.index;

          return (
            <div
              key={slot.paramId}
              className={`fm-slot ${isActive ? "fm-slot--active" : ""} ${isModified ? "fm-slot--modified" : ""}`}
              data-testid={`fm-slot-${slot.index}`}
            >
              <div className="fm-slot-head">
                <span className="fm-slot-label">{slot.label}</span>
                <span className="fm-slot-pwm">
                  {slot.pwmRange} µs
                  <span className="fm-slot-pwm-nominal"> (≈{slot.nominalPwm})</span>
                </span>
                {isSwitchHere && (
                  <span
                    className="fm-slot-switch-dot"
                    data-testid={`fm-switch-at-${slot.index}`}
                    title="Switch is currently at this position"
                  />
                )}
                {isActive && (
                  <span
                    className="fm-slot-active-dot"
                    data-testid={`fm-active-${slot.index}`}
                    title="Active flight mode matches this position"
                  />
                )}
              </div>
              <select
                className="fm-mode-select"
                value={effectiveValue ?? ""}
                onChange={(e) =>
                  handleModeChange(slot.paramId, Number(e.target.value))
                }
                disabled={!connected}
                data-testid={`fm-mode-select-${slot.index}`}
              >
                {/* Honest placeholder: an absent FLTMODE* is UNKNOWN, never "Stabilize". */}
                {effectiveValue === null && (
                  <option value="" disabled>
                    UNKNOWN
                  </option>
                )}
                {modes.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.name}
                  </option>
                ))}
              </select>
              {isModified && (
                <div className="fm-slot-modified" data-testid={`fm-modified-${slot.index}`}>
                  {modeName(liveValue, modes)} &rarr;{" "}
                  {modeName(Number(effectiveValue), modes)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!metadataDriven && (
        <div className="fm-notice" data-testid="fm-modes-fallback">
          Mode list is from the ArduPilot default table; the vehicle has not
          advertised parameter metadata for FLTMODE1.
        </div>
      )}

      {/* Save button */}
      <div className="fm-actions">
        <button
          type="button"
          className="fm-save-btn"
          onClick={handleSave}
          disabled={!hasChanges || store.writePhase === "running"}
          data-testid="fm-save-btn"
        >
          {store.writePhase === "running" ? (
            <Loader size={14} className="fm-spinner" />
          ) : (
            <Save size={14} />
          )}
          {store.writePhase === "running"
            ? "Saving..."
            : `Save Flight Modes${stagedCount > 0 ? ` (${stagedCount})` : ""}`}
        </button>
      </div>
    </div>
  );
}