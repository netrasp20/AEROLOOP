import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Compass,
  Fan,
  Gauge,
  Globe,
  Loader,
  MousePointerClick,
  RotateCcw,
  Timer,
  XCircle,
} from "lucide-react";

import { useTelemetry } from "../../hooks/useTelemetry";
import { useAccelCalibration } from "../../hooks/useAccelCalibration";
import { useSensorCalibration } from "../../hooks/useSensorCalibration";
import { useParameters } from "../../context/ParameterContext";
import { formatCompassStatus, sensorStateLabel } from "./setupSensorFormat";
import type {
  CompassConfiguration,
  DetectedDevice,
  SensorCalState,
} from "../../api/setup";

function CalResult({ result }: { result: "success" | "failed" | "cancelled" | null }) {
  if (result === null) return null;
  return (
    <div className="accel-result" data-testid={`setup-sensor-result-${result}`}>
      {result === "success" && (
        <>
          <CheckCircle2 size={18} />
          <span>Calibration completed successfully.</span>
        </>
      )}
      {result === "failed" && (
        <>
          <XCircle size={18} />
          <span>Calibration failed — retry the calibration.</span>
        </>
      )}
      {result === "cancelled" && <span>Calibration cancelled.</span>}
    </div>
  );
}

function SensorStatusChip({
  state,
  testId,
}: {
  state: SensorCalState | undefined;
  testId: string;
}) {
  const label = sensorStateLabel(state);
  return (
    <span className={`sensor-status-chip sensor-status-${state ?? "unknown"}`} data-testid={testId}>
      {label}
    </span>
  );
}

/** Orientation enum options pulled from parameter metadata when available. */
function enumOptions(metaValues?: Record<string, string> | null): Array<{ code: number; label: string }> {
  return Object.entries(metaValues ?? {})
    .map(([code, label]) => ({ code: Number(code), label }))
    .sort((a, b) => a.code - b.code);
}

function SensorCalButton({
  busy,
  label,
  onClick,
  disabled,
  testId,
}: {
  busy: boolean;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="setup-params-btn setup-params-btn-primary"
      onClick={onClick}
      disabled={busy || disabled}
      data-testid={testId}
    >
      {busy ? <Loader size={13} className="setup-spinner" /> : <RotateCcw size={13} />}
      {label}
    </button>
  );
}

export default function SetupSensors() {
  const [selectedSensor, setSelectedSensor] = useState("accelerometer");
  const telemetry = useTelemetry();
  const accel = useAccelCalibration(telemetry.connected);
  const {
    sensors,
    gyro,
    baro,
    level,
    compass,
    compassReport,
    compassConfig,
    compassMot,
    message,
    connectionLost,
    runGyro,
    runBaro,
    runLevel,
    startCompass,
    acceptCompass,
    cancelCompass,
    startMotorTest,
    cancelMotorTest,
  } = useSensorCalibration(telemetry.connected);

  if (!telemetry.connected) {
    return (
      <div className="setup-page setup-sensors-page" data-testid="setup-sensors">
        <div className="setup-page-header">
          <h2 className="setup-page-title">Sensors</h2>
          <p className="setup-page-subtitle">Sensor calibration and status</p>
        </div>
        <div className="setup-disconnected" data-testid="setup-sensors-disconnected">
          <XCircle size={26} />
          <p className="setup-disconnected-title">
            {connectionLost ? "Pixhawk connection lost" : "Vehicle is not connected"}
          </p>
          <p className="setup-disconnected-hint">
            {connectionLost
              ? "Reconnect the Pixhawk, then restart any calibration explicitly."
              : "Connect an ArduCopter vehicle to calibrate its sensors."}
          </p>
        </div>
      </div>
    );
  }

  const identity = sensors ?? null;
  const compassStatusText = compass.active
    ? formatCompassStatus(compass.status, compass.completionPct)
    : sensorStateLabel(sensors?.sensors.compass?.status);

  const accelState = sensors?.sensors.accel?.status;
  const gyroState = sensors?.sensors.gyro?.status;
  const baroState = sensors?.sensors.baro?.status;
  const levelState = sensors?.sensors.level?.status;
  const compassState = sensors?.sensors.compass?.status;

  const compassFit = compassReport?.fitness ?? sensors?.sensors.compass?.calFit ?? null;
  const compassDetected = sensors?.sensors.compass?.detected ?? 0;

  return (
    <div className="setup-page setup-sensors-page" data-testid="setup-sensors">
      <div className="setup-page-header">
        <h2 className="setup-page-title">Sensors</h2>
        <p className="setup-page-subtitle">Sensor calibration and status</p>
      </div>

      {telemetry.armed && (
        <div className="setup-fw-error" data-testid="setup-sensors-armed">
          <AlertCircle size={18} />
          Disarm the vehicle before calibrating any sensor.
        </div>
      )}

      {message && (
        <div className="frame-error" data-testid="setup-sensors-message">
          <AlertCircle size={16} />
          {message}
        </div>
      )}

      <div className="setup-sensor-statusbar" data-testid="setup-sensors-statusbar">
        <span>Connected</span>
        <span>•</span><strong>{identity?.connectionType ?? "UNKNOWN"}</strong>
        <span>•</span><span>System {identity?.systemId ?? telemetry.systemId}/{identity?.componentId ?? telemetry.componentId}</span>
      </div>
      <section className="setup-card setup-sensor-identity-compact" data-testid="setup-sensors-identity">
        <h3 className="setup-card-title">Vehicle</h3>
        <div className="setup-identity-grid">
          <div className="setup-identity-tile">
            <span className="setup-identity-label">Connection</span>
            <span className="setup-identity-value setup-identity-pulse">{identity?.connected ? "CONNECTED" : "UNKNOWN"}</span>
          </div>
          <div className="setup-identity-tile">
            <span className="setup-identity-label">Vehicle Type</span>
            <span className="setup-identity-value">{identity?.vehicleType ?? telemetry.vehicleType}</span>
          </div>
          <div className="setup-identity-tile">
            <span className="setup-identity-label">Autopilot</span>
            <span className="setup-identity-value">{identity?.autopilot ?? telemetry.vehicleType}</span>
          </div>
          <div className="setup-identity-tile">
            <span className="setup-identity-label">Link</span>
            <span className="setup-identity-value">{identity?.connectionType ?? "UNKNOWN"}</span>
          </div>
          {identity && identity.systemId > 0 && (
            <div className="setup-identity-tile">
              <span className="setup-identity-label">System ID</span>
              <span className="setup-identity-value">
                {identity.systemId} / {identity.componentId}
              </span>
            </div>
          )}
        </div>
      </section>

      <div className="setup-sensors-layout" data-testid="setup-sensors-layout">
        <nav className="setup-sensor-list" aria-label="Sensors">
          {[
            ["compass", "Compass", compassState],
            ["gyro", "Gyroscope", gyroState],
            ["accelerometer", "Accelerometer", accelState],
            ["level", "Level Horizon", levelState],
            ["baro", "Barometer", baroState],
            ["compassmot", "CompassMot", compassMot.supported ? undefined : "unsupported"],
            ["settings", "Sensor Settings", undefined],
          ].map(([id, label, state]) => (
            <button key={id} type="button" className={`setup-sensor-list-item${selectedSensor === id ? " is-selected" : ""}`} onClick={() => setSelectedSensor(String(id))}>
              <span className={`setup-sensor-status-dot sensor-status-${state ?? "unknown"}`} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <main className={`setup-sensor-workspace selected-${selectedSensor}`}>

      <SensorCard
        icon={<Compass size={16} />}
        title="Accelerometer"
        subtitle="6-position level calibration"
        testId="setup-accel-card"
        sensorKey="accelerometer"
        active={accel.status.active}
      >
        {accel.status.active ? (
          <>
            <div className="accel-status-banner" data-testid="setup-accel-banner">
              <MousePointerClick size={18} />
              <span>
                Place the vehicle as shown and select{" "}
                <strong>Confirm Orientation</strong> to sample.
              </span>
            </div>
            {accel.status.step !== null && (
              <div className="accel-prompt" data-testid="setup-accel-prompt">
                <span className="accel-prompt-step">
                  {accel.status.order} / {accel.status.total}
                </span>
                <span className="accel-prompt-label">{accel.status.label}</span>
              </div>
            )}
            {accel.message && (
              <div className="frame-error" data-testid="setup-accel-message">
                <AlertCircle size={16} />
                {accel.message}
              </div>
            )}
            <div className="accel-actions">
              <button
                type="button"
                className="setup-params-btn setup-params-btn-primary"
                onClick={accel.confirm}
                disabled={accel.busy || accel.status.step === null}
                data-testid="setup-accel-confirm"
              >
                {accel.busy ? <Loader size={13} className="setup-spinner" /> : null}
                Confirm Orientation
              </button>
              <button
                type="button"
                className="setup-params-btn setup-params-btn-danger"
                onClick={accel.cancel}
                disabled={accel.busy}
                data-testid="setup-accel-cancel"
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="accel-readout">
              <span className="setup-identity-label">Status</span>
              <SensorStatusChip state={accelState} testId="setup-accel-chip" />
            </div>
            <CalResult result={accel.status.result} />
            {accel.message && (
              <div className="frame-error" data-testid="setup-accel-message">
                <AlertCircle size={16} />
                {accel.message}
              </div>
            )}
            <div className="accel-actions">
              <SensorCalButton
                busy={accel.busy}
                label="Start Calibration"
                onClick={accel.start}
                disabled={telemetry.armed}
                testId="setup-accel-start"
              />
            </div>
            <p className="setup-note">
              Six orientations are sampled (level, left, right, nose-down,
              nose-up and on its back). The vehicle must be disarmed.
            </p>
          </>
        )}
      </SensorCard>

      <SensorCard
        icon={<Gauge size={16} />}
        title="Gyroscope"
        subtitle="MAV_CMD_PREFLIGHT_CALIBRATION (gyro)"
        testId="setup-gyro-card"
        sensorKey="gyro"
        active={gyro.busy}
      >
        <div className="accel-readout">
          <span className="setup-identity-label">Status</span>
          <SensorStatusChip state={gyroState} testId="setup-gyro-chip" />
        </div>
        <CalResult result={gyro.result} />
        {gyro.message && (
          <div className="frame-error" data-testid="setup-gyro-message">
            <AlertCircle size={16} />
            {gyro.message}
          </div>
        )}
        <div className="accel-actions">
          <SensorCalButton
            busy={gyro.busy}
            label="Calibrate Gyro"
            onClick={runGyro}
            disabled={telemetry.armed}
            testId="setup-gyro-start"
          />
        </div>
      </SensorCard>

      <SensorCard
        icon={<Timer size={16} />}
        title="Barometer"
        subtitle="Ground pressure calibration"
        testId="setup-baro-card"
        sensorKey="baro"
        active={baro.busy}
      >
        <div className="accel-readout">
          <span className="setup-identity-label">Status</span>
          <SensorStatusChip state={baroState} testId="setup-baro-chip" />
        </div>
        <CalResult result={baro.result} />
        {baro.message && (
          <div className="frame-error" data-testid="setup-baro-message">
            <AlertCircle size={16} />
            {baro.message}
          </div>
        )}
        <div className="accel-actions">
          <SensorCalButton
            busy={baro.busy}
            label="Calibrate Barometer"
            onClick={runBaro}
            disabled={telemetry.armed}
            testId="setup-baro-start"
          />
        </div>
      </SensorCard>

      <SensorCard
        icon={<Globe size={16} />}
        title="Level Horizon"
        subtitle="Board level calibration"
        testId="setup-level-card"
        sensorKey="level"
        active={level.busy}
      >
        <div className="accel-readout">
          <span className="setup-identity-label">Status</span>
          <SensorStatusChip state={levelState} testId="setup-level-chip" />
        </div>
        <CalResult result={level.result} />
        {level.message && (
          <div className="frame-error" data-testid="setup-level-message">
            <AlertCircle size={16} />
            {level.message}
          </div>
        )}
        <div className="accel-actions">
          <SensorCalButton
            busy={level.busy}
            label="Calibrate Level"
            onClick={runLevel}
            disabled={telemetry.armed}
            testId="setup-level-start"
          />
        </div>
        <p className="setup-note">
          Place the vehicle level on its base before running.
        </p>
      </SensorCard>

      <SensorCard
        icon={<Gauge size={16} />}
        title="Compass"
        subtitle="Magnetometer calibration"
        testId="setup-compass-card"
        sensorKey="compass"
        active={compass.active}
      >
        <div className="accel-readout">
          <span className="setup-identity-label">Status</span>
          <span className="accel-readout-value">
            <SensorStatusChip state={compassState} testId="setup-compass-chip" />
          </span>
        </div>

        {compassReport && (
          <div className="compass-fit" data-testid="setup-compass-fit">
            <span>Fitness: <strong>{Math.round(compassReport.fitness * 100)}%</strong></span>
            <span>Offsets: {compassReport.ofsX.toFixed(1)} / {compassReport.ofsY.toFixed(1)} / {compassReport.ofsZ.toFixed(1)}</span>
          </div>
        )}
        {!compassReport && compassFit !== null && (
          <div className="compass-fit" data-testid="setup-compass-fit">
            <span>Fit: <strong>{Math.round(compassFit)}%</strong></span>
            {compassDetected > 0 && <span>{compassDetected} compass(es) detected</span>}
          </div>
        )}

        {compass.active && (
          <>
            <div className="compass-status-text" data-testid="setup-compass-status">
              {compassStatusText}
            </div>
            <div className="compass-progress" data-testid="setup-compass-progress">
              <div className="compass-progress-track">
                <div
                  className="compass-progress-fill"
                  style={{ width: `${compass.completionPct}%` }}
                />
              </div>
              <span className="compass-progress-label">{compass.completionPct}%</span>
            </div>
          </>
        )}

        <CalResult result={compass.result} />
        {message && (
          <div className="frame-error" data-testid="setup-compass-message">
            <AlertCircle size={16} />
            {message}
          </div>
        )}

        <div className="accel-actions">
          {compass.active ? (
            <>
              <button
                type="button"
                className="setup-params-btn setup-params-btn-primary"
                onClick={acceptCompass}
                disabled={compass.status !== "success"}
                data-testid="setup-compass-accept"
              >
                Accept Calibration
              </button>
              <button
                type="button"
                className="setup-params-btn setup-params-btn-danger"
                onClick={cancelCompass}
                data-testid="setup-compass-cancel"
              >
                Cancel
              </button>
            </>
          ) : (
            <SensorCalButton
              busy={false}
              label="Start Calibration"
              onClick={startCompass}
              disabled={telemetry.armed}
              testId="setup-compass-start"
            />
          )}
        </div>
        <p className="setup-note">
          Rotate the vehicle slowly in all orientations until the fitness is
          reached, then accept the result to save it.
        </p>
      </SensorCard>

        <CompassSettingsCard config={compassConfig} />

        <FlightControllerOrientationCard config={compassConfig} />

        <section className={`setup-card sensor-card sensor-card-wide${compassMot.active ? " sensor-card-active" : ""}`} data-testid="setup-compassmot-card" data-sensor-key="compassmot">
        <h3 className="setup-card-title">
          <span className="sensor-card-title">
            <span className="sensor-card-icon">
              <Fan size={16} />
            </span>
            CompassMot
          </span>
          <span className="sensor-card-subtitle">Motor interference test</span>
        </h3>
        <div className="accel-readout">
          <span className="setup-identity-label">Status</span>
          <SensorStatusChip
            state={compassMot.supported ? undefined : "unsupported"}
            testId="setup-compassmot-chip"
          />
        </div>

        {!compassMot.supported && (
          <p className="setup-note" data-testid="setup-compassmot-unsupported">
            CompassMot is hardware-only and is not exposed by the connected
            firmware/vehicle.
          </p>
        )}

        {compassMot.supported && (
          <>
            {compassMot.enabled !== null && (
              <div className="accel-readout">
                <span className="setup-identity-label">Compensation</span>
                <span className="accel-readout-value">
                  {["Disabled", "Use Throttle", "Use Current"][compassMot.enabled] ?? "Disabled"}
                </span>
              </div>
            )}
            {compassMot.active && (
              <div className="accel-readout" data-testid="setup-compassmot-readings">
                <span className="setup-identity-label">Throttle</span>
                <span className="accel-readout-value">{compassMot.throttle ?? 0}%</span>
                <span className="setup-identity-label">Interference</span>
                <span className="accel-readout-value">{compassMot.interference ?? 0}</span>
              </div>
            )}
            <div className="accel-actions">
              {compassMot.active ? (
                <button
                  type="button"
                  className="setup-params-btn setup-params-btn-danger"
                  onClick={cancelMotorTest}
                  data-testid="setup-compassmot-cancel"
                >
                  Stop Test
                </button>
              ) : (
                <SensorCalButton
                  busy={false}
                  label="Start Test"
                  onClick={startMotorTest}
                  disabled={telemetry.armed}
                  testId="setup-compassmot-start"
                />
              )}
            </div>
            <p className="setup-note">
              Measures magnetic interference across a throttle ramp. Only
              meaningful on real hardware — SITL accepts the command but cannot
              measure a physical curve.
            </p>
          </>
        )}
        </section>
        </main>
      </div>
    </div>
  );
}

function CompassSettingsCard({ config }: { config: CompassConfiguration | null }) {
  const store = useParameters();
  const [stageError, setStageError] = useState<string | null>(null);

  const connected = store.connection === "READY";
  const devices: DetectedDevice[] = config?.devices ?? [];
  const editableIds = [
    "COMPASS_ENABLE",
    ...devices.flatMap((d) => [d.useParam, d.orientParam].filter((p): p is string => Boolean(p))),
  ];
  const hasStaged = editableIds.some((id) => store.staged[id]);

  const handleStage = (paramId: string, value: number) => {
    const result = store.stageValue(paramId, value);
    setStageError(result.ok ? null : (result.error ?? "Unable to stage the selected value."));
  };

  const rebootWanted = editableIds.some(
    (id) => store.entries[id]?.metadata?.rebootRequired && store.staged[id]
  );

  return (
    <section className="setup-card sensor-card" data-testid="setup-compass-settings" data-sensor-key="settings">
      <h3 className="setup-card-title">
        <span className="sensor-card-title">
          <span className="sensor-card-icon">
            <Compass size={16} />
          </span>
          Compass Settings
        </span>
        <span className="sensor-card-subtitle">Detected compasses and enablement</span>
      </h3>

      {config && config.enabled !== null && (
        <div className="compass-settings-row" data-testid="setup-compass-enable">
          <span className="frame-field-label">Enable Compass(es)</span>
          <input
            type="checkbox"
            checked={(store.staged["COMPASS_ENABLE"]?.stagedValue ?? config.enabled) === 1}
            onChange={(e) => handleStage("COMPASS_ENABLE", e.target.checked ? 1 : 0)}
            disabled={!connected || store.writePhase === "running"}
            data-testid="setup-compass-enable-toggle"
          />
        </div>
      )}

      {devices.length === 0 ? (
        <p className="setup-note" data-testid="setup-compass-settings-empty">
          No compasses reported by the vehicle.
        </p>
      ) : (
        devices.map((device) => {
          const pendingUse = store.staged[device.useParam ?? ""];
          const pendingOrient = store.staged[device.orientParam ?? ""];
          const use = (pendingUse?.stagedValue ?? device.use ?? 0) === 1;
          const orient =
            pendingOrient?.stagedValue ??
            device.orient ??
            store.entries[device.orientParam ?? ""]?.live?.value;
          const metaValues = device.orientParam
            ? store.entries[device.orientParam]?.metadata?.values
            : undefined;
          return (
            <div className="compass-settings-device" data-testid={`setup-compass-device-${device.index}`} key={device.index}>
              <div className="compass-settings-row">
                <span className="frame-field-label">{device.name}</span>
                {device.useParam && (
                  <label className="compass-settings-toggle">
                    <input
                      type="checkbox"
                      checked={use}
                      onChange={(e) => handleStage(device.useParam!, e.target.checked ? 1 : 0)}
                      disabled={!connected || store.writePhase === "running"}
                    />
                    Use
                  </label>
                )}
              </div>
              {device.orientParam && (
                <div className="compass-settings-row">
                  <span className="frame-field-label">Orientation</span>
                  <select
                    className="frame-select"
                    value={String(orient ?? "")}
                    onChange={(e) => handleStage(device.orientParam!, Number(e.target.value))}
                    disabled={!connected || store.writePhase === "running"}
                    data-testid={`setup-compass-orient-${device.index}`}
                  >
                    {enumOptions(metaValues).map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          );
        })
      )}

      {!connected && (
        <p className="setup-note" data-testid="setup-compass-settings-sync-note">
          Waiting for parameter sync before compass settings can be edited.
        </p>
      )}
      {stageError && (
        <div className="frame-error" data-testid="setup-compass-settings-error">
          <AlertCircle size={16} />
          {stageError}
        </div>
      )}
      {rebootWanted && (
        <div className="frame-error" data-testid="setup-compass-settings-reboot">
          <AlertCircle size={16} />
          Rebooting is required to apply these changes.
        </div>
      )}
      {store.writePhase === "success" && (
        <div className="accel-result" data-testid="setup-compass-settings-result-success">
          <CheckCircle2 size={18} />
          <span>Compass settings written and verified.</span>
        </div>
      )}
      {store.writePhase === "error" && (
        <div className="frame-error" data-testid="setup-compass-settings-error">
          <AlertCircle size={16} />
          {store.writeError?.message ?? "Compass settings could not be applied."}
        </div>
      )}
      <div className="accel-actions">
        <button
          type="button"
          className="setup-params-btn setup-params-btn-primary"
          onClick={() => {
            setStageError(null);
            void store.executeWrite();
          }}
          disabled={!hasStaged || store.writePhase === "running" || !connected}
          data-testid="setup-compass-settings-apply"
        >
          Apply Settings
        </button>
        <button
          type="button"
          className="setup-params-btn setup-params-btn-danger"
          onClick={() => editableIds.forEach((id) => store.revert(id))}
          disabled={!hasStaged}
          data-testid="setup-compass-settings-revert"
        >
          Revert
        </button>
      </div>
    </section>
  );
}

function FlightControllerOrientationCard({ config }: { config: CompassConfiguration | null }) {
  const store = useParameters();
  const [stageError, setStageError] = useState<string | null>(null);

  const connected = store.connection === "READY";
  const paramId = "AHRS_ORIENTATION";
  const entry = store.entries[paramId];
  const staged = store.staged[paramId];
  const current = staged?.stagedValue ?? (entry?.live?.value ?? config?.orientation.value ?? null);
  const options = enumOptions(entry?.metadata?.values);

  const handleStage = (value: number) => {
    const result = store.stageValue(paramId, value);
    setStageError(result.ok ? null : (result.error ?? "Unable to stage the selected value."));
  };

  const metaNote = entry?.metadata ? null : (
    <span className="frame-meta-note">metadata unavailable — standard values</span>
  );

  return (
    <section className="setup-card sensor-card" data-testid="setup-orientation-card" data-sensor-key="settings">
      <h3 className="setup-card-title">
        <span className="sensor-card-title">
          <span className="sensor-card-icon">
            <Gauge size={16} />
          </span>
          Flight Controller Orientation
        </span>
        <span className="sensor-card-subtitle">{paramId}</span>
      </h3>
      <div className="compass-settings-row">
        <span className="frame-field-label">Rotation</span>
        {metaNote}
      </div>
      <div className="compass-settings-row">
        <select
          className="frame-select"
          value={String(current ?? "")}
          onChange={(e) => handleStage(Number(e.target.value))}
          disabled={!connected || store.writePhase === "running"}
          data-testid="setup-orientation-select"
        >
          {options.map((opt) => (
            <option key={opt.code} value={opt.code}>
              {opt.label}
            </option>
          ))}
        </select>
        <div className="frame-values">
          <span className="frame-current">
            Current: <strong>{(entry?.metadata?.values ?? {})[String(current)] ?? "—"}</strong>
          </span>
          {staged && (
            <span className="frame-pending" data-testid="setup-orientation-pending">
              Pending: <strong>{(entry?.metadata?.values ?? {})[String(staged.stagedValue)] ?? staged.stagedValue}</strong>
            </span>
          )}
        </div>
      </div>
      {entry?.metadata?.rebootRequired && staged && (
        <div className="frame-error" data-testid="setup-orientation-reboot">
          <AlertCircle size={16} />
          Rebooting is required to apply the new orientation.
        </div>
      )}
      {stageError && (
        <div className="frame-error" data-testid="setup-orientation-error">
          <AlertCircle size={16} />
          {stageError}
        </div>
      )}
      {store.writePhase === "success" && (
        <div className="accel-result" data-testid="setup-orientation-result-success">
          <CheckCircle2 size={18} />
          <span>Orientation saved and verified.</span>
        </div>
      )}
      <div className="accel-actions">
        <button
          type="button"
          className="setup-params-btn setup-params-btn-primary"
          onClick={() => {
            setStageError(null);
            void store.executeWrite();
          }}
          disabled={!staged || store.writePhase === "running" || !connected}
          data-testid="setup-orientation-apply"
        >
          Apply
        </button>
        <button
          type="button"
          className="setup-params-btn setup-params-btn-danger"
          onClick={() => store.revert(paramId)}
          disabled={!staged}
          data-testid="setup-orientation-revert"
        >
          Revert
        </button>
      </div>
    </section>
  );
}

function SensorCard({
  icon,
  title,
  subtitle,
  testId,
  sensorKey,
  active = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  testId: string;
  sensorKey: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`setup-card sensor-card${active ? " sensor-card-active" : ""}`} data-testid={testId} data-sensor-key={sensorKey}>
      <h3 className="setup-card-title">
        <span className="sensor-card-title">
          <span className="sensor-card-icon">{icon}</span>
          {title}
        </span>
        <span className="sensor-card-subtitle">{subtitle}</span>
      </h3>
      {children}
    </section>
  );
}
