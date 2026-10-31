import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, Joystick } from "lucide-react";

import { useTelemetry } from "../../hooks/useTelemetry";
import { useMotorTest } from "../../hooks/useMotorTest";
import { useMotorsSetup } from "../../hooks/useMotorsSetup";
import SetupReadOnlyState from "./SetupReadOnlyState";

/**
 * Motors Setup.
 *
 * Phase 2 — the page drives the real backend functionality while keeping the
 * approved visual composition byte-for-byte: same slots, same six vertical
 * controls, same diagram, same reverse row, same Motor Outputs table.
 *
 * Safety properties that must not regress:
 *  - The lock control stays a permanently disabled button: this page can never
 *    arm the vehicle.
 *  - Motor tests are only reachable through the backend's SITL gate, and are
 *    always bounded (0-20% / 1-10s) and firmware self-terminating.
 *  - A motor slot is only live if that motor number was actually discovered on
 *    the vehicle via SERVOx_FUNCTION. Slots 5/6 stay unavailable on a quad.
 *  - Reverse direction is configuration only; it is never reported as
 *    physically verified.
 */
const MOTOR_SLOTS: number = 6;

const shown = (value: string | number | null) =>
  value === null || value === "" ? "Unavailable" : String(value);

function MotorSlider({
  index,
  value,
  max,
  disabled,
  onChange,
  onCommit,
}: {
  index: number;
  value: number;
  max: number;
  disabled: boolean;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  // The level the user has actually asked for. The commit on release must use
  // this, never a stale render value, so a quick tap cannot send the previous
  // level to the vehicle.
  const pending = useRef(value);
  useEffect(() => {
    pending.current = value;
  }, [value]);

  const levelFrom = (track: HTMLDivElement, clientY: number) => {
    const rect = track.getBoundingClientRect();
    if (rect.height === 0) return null;
    return Math.min(max, Math.max(0, Math.round(max - ((clientY - rect.top) / rect.height) * max)));
  };

  return (
    <div
      className="motor-slider"
      data-testid={`motor-slider-${index}`}
      data-available={!disabled}
    >
      <span className="motor-slider-number">{index}</span>
      <div
        className="motor-slider-track"
        data-testid={`motor-slider-track-${index}`}
        role="slider"
        tabIndex={0}
        aria-label={`Motor ${index} test level`}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-disabled={disabled ? "true" : "false"}
        onPointerDown={(e) => {
          if (disabled) return;
          const next = levelFrom(e.currentTarget, e.clientY);
          if (next === null) return;
          pending.current = next;
          onChange(next);
        }}
        onPointerUp={() => {
          if (disabled) return;
          onCommit(pending.current);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          let next: number;
          if (e.key === "ArrowUp") next = Math.min(max, value + 1);
          else if (e.key === "ArrowDown") next = Math.max(0, value - 1);
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = max;
          else return;
          e.preventDefault();
          pending.current = next;
          onChange(next);
        }}
        onKeyUp={(e) => {
          if (disabled) return;
          if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End") {
            onCommit(pending.current);
          }
        }}
      >
        <div
          className="motor-slider-fill"
          style={{ height: `${max === 0 ? 0 : (value / max) * 100}%` }}
          data-testid={`motor-slider-fill-${index}`}
        />
        <div
          className="motor-slider-handle"
          style={{ bottom: `calc(${(max === 0 ? 0 : (value / max) * 100)}% - 11px)` }}
          data-testid={`motor-slider-handle-${index}`}
        />
      </div>
    </div>
  );
}

function MotorDiagram() {
  // Informational hexacopter-style layout. This is NOT the connected vehicle's
  // real mapping; the discovered motor<->output mapping is listed in the Motor
  // Outputs table below, read live from SERVOx_FUNCTION.
  const cx = 110;
  const cy = 110;
  const radius = 78;
  const angles = [90, 30, -30, -90, -150, 150];
  const motors = angles.map((deg, i) => {
    const rad = (deg * Math.PI) / 180;
    return { n: i + 1, x: cx + radius * Math.cos(rad), y: cy - radius * Math.sin(rad) };
  });

  return (
    <div className="motor-diagram" data-testid="motor-diagram">
      <svg
        viewBox="0 0 220 220"
        className="motor-diagram-svg"
        role="img"
        aria-label="Vehicle motor position diagram"
      >
        {motors.map((m) => (
          <line
            key={`arm-${m.n}`}
            x1={cx}
            y1={cy}
            x2={m.x}
            y2={m.y}
            className="motor-diagram-arm"
          />
        ))}
        <ellipse cx={cx} cy={cy} rx="30" ry="38" className="motor-diagram-body" />
        <path
          d={`M${cx - 10} ${cy - 30} L${cx} ${cy - 46} L${cx + 10} ${cy - 30} Z`}
          className="motor-diagram-nose"
        />
        <circle cx={cx} cy={cy} r="12" className="motor-diagram-hub" />
        {motors.map((m) => (
          <g key={m.n}>
            <circle cx={m.x} cy={m.y} r="16" className="motor-diagram-motor" />
            <text x={m.x} y={m.y + 4.5} className="motor-diagram-label">
              {m.n}
            </text>
          </g>
        ))}
      </svg>
      <p className="motor-diagram-note">
        Motor layout will be resolved from the connected vehicle configuration.
      </p>
    </div>
  );
}

export default function SetupMotors() {
  const telemetry = useTelemetry();
  const { motors, connectionLost, refresh } = useMotorsSetup(telemetry.connected);
  const { testStatus, reverseStates, busy, startTest, setReverse } = useMotorTest(
    telemetry.connected,
  );

  const [levels, setLevels] = useState<number[]>(() =>
    Array.from({ length: MOTOR_SLOTS }, () => 0),
  );

  const bounds = testStatus?.bounds;
  const max = bounds?.throttlePctMax ?? 20;
  const timeoutS = bounds?.timeoutSDefault ?? 3;
  const supported = Boolean(testStatus?.supported);
  const testing = testStatus?.state === "TESTING" ? testStatus : null;

  // Only motor numbers actually discovered on this vehicle are controllable.
  const discovered = useMemo(() => {
    const map = new Map<number, number>();
    for (const output of motors?.outputs ?? []) {
      if (output.motorNumber != null) map.set(output.motorNumber, output.output);
    }
    return map;
  }, [motors]);

  const controlsEnabled = supported && !busy && Boolean(motors) && !motors?.armed;
  const slotAvailable = (n: number) => discovered.has(n);
  const slotEnabled = (n: number) => controlsEnabled && slotAvailable(n);

  const setLevel = useCallback((index: number, value: number) => {
    setLevels((prev) => prev.map((old, j) => (j === index ? value : old)));
  }, []);

  const runTest = useCallback(
    async (motor: number, value: number) => {
      if (value <= 0) return;
      await startTest(motor, value, timeoutS);
    },
    [startTest, timeoutS],
  );

  // While a test runs, the active motor's slider reflects the commanded level.
  const slotValue = (n: number) => {
    if (testing && testing.activeMotor === n && testing.activeThrottlePct != null) {
      return testing.activeThrottlePct;
    }
    return levels[n - 1] ?? 0;
  };

  const reverseFor = (n: number) =>
    reverseStates.find((r) => r.motor === n)?.configured ?? false;

  const lockTitle = (() => {
    if (!telemetry.connected) return "Motor testing unavailable";
    if (!testStatus) return "Motor testing unavailable";
    if (!supported) return "Motor testing unavailable";
    if (testing && testing.activeMotor != null) {
      return `Testing Motor ${testing.activeMotor} at ${testing.activeThrottlePct}% for ${testing.activeTimeoutS}s`;
    }
    if (testStatus.state === "STOPPED" || testStatus.state === "ERROR") {
      return testStatus.lastResult?.message ?? "Motor test stopped";
    }
    return "Motor testing ready";
  })();

  // The lock statement is an invariant of the page, not a per-state string.
  const LOCK_SAFETY =
    "This control is locked and cannot arm the vehicle or enable any actuator output.";

  const lockHint = (() => {
    if (!telemetry.connected) {
      return `Connect a vehicle to discover its motors. ${LOCK_SAFETY}`;
    }
    if (!testStatus) {
      return `Reading motor test capability. ${LOCK_SAFETY}`;
    }
    if (!supported) {
      return `${testStatus.reasons[0]} ${LOCK_SAFETY}`;
    }
    if (testing && testing.activeMotor != null) {
      return `The vehicle stops this test on its own after ${testing.activeTimeoutS}s. Reverse direction is configuration only and is not physically verified. ${LOCK_SAFETY}`;
    }
    const discoveredCount = discovered.size;
    return `${discoveredCount} motor${discoveredCount === 1 ? "" : "s"} discovered on this vehicle. Tests are limited to ${bounds?.throttlePctMin ?? 0}-${max}% for ${bounds?.timeoutSMin ?? 1}-${bounds?.timeoutSMax ?? 10}s. Reverse direction is configuration only and is not physically verified. ${LOCK_SAFETY}`;
  })();

  return (
    <SetupReadOnlyState
      page="Motors"
      title="Motors Setup"
      icon={<Joystick size={18} />}
      subtitle="Motors Setup is used to manually test motor control and direction."
      connected={telemetry.connected}
      connectionState={telemetry.connectionState ?? "DISCONNECTED"}
      disconnectReason={telemetry.disconnectReason ?? null}
      connectionLost={connectionLost}
      snapshot={motors}
      onRefresh={refresh}
      pageClassName="setup-page-motors"
    >
      <div className="motor-test-area" data-testid="motor-test-area">
        <div className="motor-controls">
          <div className="motor-sliders">
            {Array.from({ length: MOTOR_SLOTS }, (_, i) => (
              <MotorSlider
                key={i}
                index={i + 1}
                value={slotValue(i + 1)}
                max={max}
                disabled={!slotEnabled(i + 1)}
                onChange={(v) => setLevel(i, v)}
                onCommit={(v) => {
                  setLevel(i, v);
                  void runTest(i + 1, v);
                }}
              />
            ))}
          </div>

          <div className="motor-reverse" data-testid="motor-reverse">
            <span className="motor-reverse-label">Reverse Motor Direction</span>
            <div className="motor-reverse-boxes">
              {Array.from({ length: MOTOR_SLOTS }, (_, i) => (
                <label key={i} className="motor-reverse-cell">
                  <input
                    type="checkbox"
                    checked={reverseFor(i + 1)}
                    disabled={!slotEnabled(i + 1)}
                    data-testid={`motor-reverse-${i + 1}`}
                    onChange={(e) => {
                      void setReverse(i + 1, e.target.checked);
                    }}
                  />
                  <span className="motor-reverse-box" aria-hidden="true" />
                </label>
              ))}
            </div>
          </div>
        </div>

        <MotorDiagram />
      </div>

      <div className="motor-lock" data-testid="motor-test-lock">
        <button
          type="button"
          className="motor-lock-knob"
          disabled
          aria-disabled="true"
          data-testid="motor-lock-knob"
        >
          <Lock size={18} />
        </button>
        <div className="motor-lock-text">
          <p className="motor-lock-title" data-testid="motor-lock-title">
            {lockTitle}
          </p>
          <p className="motor-lock-hint" data-testid="motor-lock-hint">
            {lockHint}
          </p>
        </div>
      </div>

      {motors && (
        <section className="setup-card motor-discovery">
          <h3 className="setup-card-title">
            Motor Outputs{" "}
            <span
              className={`actuator-arm-state ${motors.armed ? "armed" : "disarmed"}`}
            >
              {motors.armed ? "ARMED" : "DISARMED"}
            </span>
          </h3>
          {motors.outputs.length === 0 ? (
            <p className="setup-empty-note">
              No configured motor outputs were discovered.
            </p>
          ) : (
            <div className="actuator-table-wrap">
              <table className="actuator-table">
                <thead>
                  <tr>
                    <th>Output</th>
                    <th>Motor</th>
                    <th>Function</th>
                    <th>Function ID</th>
                    <th>Configured</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {motors.outputs.map((output) => (
                    <tr key={output.output} data-testid={`motor-output-${output.output}`}>
                      <td>{output.output}</td>
                      <td>{shown(output.motorLabel ?? output.motorNumber)}</td>
                      <td>{shown(output.functionLabel)}</td>
                      <td>{shown(output.functionId)}</td>
                      <td>{output.configured ? "Yes" : "No"}</td>
                      <td>{shown(output.source)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="setup-note">
            Reported live from the vehicle&apos;s <code>SERVOx_FUNCTION</code>{" "}
            configuration. Reverse direction writes <code>SERVOx_REVERSED</code>; it
            changes configuration only and does not verify the motor&apos;s physical
            direction.
          </p>
        </section>
      )}
    </SetupReadOnlyState>
  );
}
