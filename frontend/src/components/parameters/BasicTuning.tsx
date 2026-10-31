import { useMemo } from "react";
import { Sliders, Save, Loader, AlertTriangle, Info } from "lucide-react";

import { useParameters } from "../../context/ParameterContext";
import useSocketTelemetry from "../../hooks/useSocketTelemetry";
import { isCopterVehicle } from "../../parameters/flightModesLogic";

import "../../styles/basicTuning.css";

/* ------------------------------------------------------------------ */
/* Parameter definitions for ArduCopter Basic Tuning                    */
/* ------------------------------------------------------------------ */

interface TuningSlider {
  id: string;
  label: string;
  description: string;
  params: string[];
  min: number;
  max: number;
  step: number;
  unit?: string;
}

const TUNING_SLIDERS: TuningSlider[] = [
  {
    id: "roll-pitch",
    label: "Roll/Pitch Response",
    description:
      "Controls how aggressively the copter responds to roll and pitch inputs. " +
      "Move left for more gentle response, right for more aggressive.",
    params: ["ATC_ANG_RLL_P", "ATC_ANG_PIT_P"],
    min: 3.0,
    max: 12.0,
    step: 0.1,
  },
  {
    id: "throttle-hover",
    label: "Throttle Hover",
    description:
      "Adjust until the copter hovers at mid-throttle stick position. " +
      "Move left if hover throttle is too high, right if too low.",
    params: ["MOT_THST_HOVER"],
    min: 0.125,
    max: 0.6875,
    step: 0.01,
  },
  {
    id: "throttle-accel",
    label: "Throttle Accel / Climb Sensitivity",
    description:
      "Controls how aggressively the copter gains or loses altitude. " +
      "Move right for more aggressive climb, left for gentler response.",
    params: ["PSC_D_ACC_P"],
    min: 0.01,
    max: 0.25,
    step: 0.001,
  },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatValue(v: number, step: number): string {
  if (step >= 1) return v.toFixed(0);
  if (step >= 0.1) return v.toFixed(1);
  if (step >= 0.01) return v.toFixed(2);
  return v.toFixed(3);
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function BasicTuning() {
  const store = useParameters();
  const telemetry = useSocketTelemetry();

  const connected = store.connection === "READY";
  const vehicleType = store.vehicleType ?? telemetry?.vehicleType ?? null;
  const isCopter = isCopterVehicle(vehicleType);

  // Read all relevant params from the store
  const paramValues = useMemo(() => {
    const allParamIds = TUNING_SLIDERS.flatMap((s) => s.params);
    const result: Record<string, { live: number | null; staged: number | null }> = {};
    for (const id of allParamIds) {
      const entry = store.entries[id];
      const staged = store.staged[id];
      result[id] = {
        live: entry?.live?.value ?? null,
        staged: staged?.stagedValue ?? null,
      };
    }
    return result;
  }, [store.entries, store.staged]);

  // Determine effective value for each slider (staged > live)
  const effectiveValues = useMemo(() => {
    const result: Record<string, number> = {};
    for (const slider of TUNING_SLIDERS) {
      const paramId = slider.params[0];
      const pv = paramValues[paramId];
      result[slider.id] = pv?.staged ?? pv?.live ?? slider.min;
    }
    return result;
  }, [paramValues]);

  // Check if any slider has changes
  const hasChanges = useMemo(() => {
    return TUNING_SLIDERS.some((slider) => {
      return slider.params.some((paramId) => store.staged[paramId] !== undefined);
    });
  }, [store.staged]);

  const stagedCount = useMemo(() => {
    let count = 0;
    for (const slider of TUNING_SLIDERS) {
      for (const paramId of slider.params) {
        if (store.staged[paramId] !== undefined) count++;
      }
    }
    return count;
  }, [store.staged]);

  function handleSliderChange(slider: TuningSlider, value: number) {
    for (const paramId of slider.params) {
      store.stageValue(paramId, value);
    }
  }

  function handleSave() {
    store.executeWrite();
  }

  // Disconnected state
  if (!connected) {
    return (
      <div className="bt-screen" data-testid="bt-screen">
        <div className="bt-header">
          <Sliders size={16} />
          <span>Basic Tuning</span>
        </div>
        <div className="bt-disconnected" data-testid="bt-disconnected">
          <AlertTriangle size={20} />
          <p>Vehicle not connected.</p>
          <p className="bt-disconnected-hint">
            Connect to an ArduCopter vehicle to configure basic tuning.
          </p>
        </div>
      </div>
    );
  }

  // Non-copter vehicle
  if (!isCopter) {
    return (
      <div className="bt-screen" data-testid="bt-screen">
        <div className="bt-header">
          <Sliders size={16} />
          <span>Basic Tuning</span>
        </div>
        <div className="bt-disconnected" data-testid="bt-non-copter">
          <AlertTriangle size={20} />
          <p>Basic tuning is only available for ArduCopter vehicles.</p>
          <p className="bt-disconnected-hint">
            Detected vehicle: {vehicleType ?? "Unknown"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bt-screen" data-testid="bt-screen">
      <div className="bt-header">
        <Sliders size={16} />
        <span>Basic Tuning</span>
        {stagedCount > 0 && (
          <span className="bt-staged-badge" data-testid="bt-staged-count">
            {stagedCount} modified
          </span>
        )}
      </div>

      <div className="bt-description">
        <Info size={14} />
        <span>
          Adjust the sliders to tune your copter's flight characteristics.
          Changes are staged and will be written to the vehicle when you click Save.
        </span>
      </div>

      <div className="bt-sliders">
        {TUNING_SLIDERS.map((slider) => {
          const effective = effectiveValues[slider.id];
          const isModified = slider.params.some(
            (pid) => store.staged[pid] !== undefined
          );
          const liveValue = paramValues[slider.params[0]]?.live;

          return (
            <div
              key={slider.id}
              className={`bt-slider-card ${isModified ? "bt-slider-card--modified" : ""}`}
              data-testid={`bt-slider-${slider.id}`}
            >
              <div className="bt-slider-head">
                <span className="bt-slider-label">{slider.label}</span>
                {isModified && liveValue !== null && (
                  <span className="bt-slider-modified-badge" data-testid={`bt-modified-${slider.id}`}>
                    {formatValue(liveValue, slider.step)} &rarr;{" "}
                    {formatValue(effective, slider.step)}
                  </span>
                )}
              </div>

              <div className="bt-slider-body">
                <input
                  type="range"
                  className="bt-range"
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  value={effective}
                  onChange={(e) =>
                    handleSliderChange(slider, parseFloat(e.target.value))
                  }
                  disabled={!connected}
                  data-testid={`bt-range-${slider.id}`}
                />
                <div className="bt-slider-value" data-testid={`bt-value-${slider.id}`}>
                  {formatValue(effective, slider.step)}
                </div>
              </div>

              <div className="bt-slider-range-labels">
                <span>{formatValue(slider.min, slider.step)}</span>
                <span>{formatValue(slider.max, slider.step)}</span>
              </div>

              <div className="bt-slider-desc">{slider.description}</div>

              {slider.params.length > 1 && (
                <div className="bt-slider-params">
                  Parameters: {slider.params.join(", ")}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Save button */}
      <div className="bt-actions">
        <button
          type="button"
          className="bt-save-btn"
          onClick={handleSave}
          disabled={!hasChanges || store.writePhase === "running"}
          data-testid="bt-save-btn"
        >
          {store.writePhase === "running" ? (
            <Loader size={14} className="bt-spinner" />
          ) : (
            <Save size={14} />
          )}
          {store.writePhase === "running"
            ? "Saving..."
            : `Save Tuning${stagedCount > 0 ? ` (${stagedCount})` : ""}`}
        </button>
      </div>
    </div>
  );
}
