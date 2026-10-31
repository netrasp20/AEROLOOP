import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Gamepad2,
  Loader,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Save,
  SlidersHorizontal,
  WifiOff,
  XCircle,
} from "lucide-react";

import { useTelemetry } from "../../hooks/useTelemetry";
import { useRadioSetup } from "../../hooks/useRadioSetup";
import { useParameters } from "../../context/ParameterContext";
import type {
  RadioChannelConfig,
  RadioStatus,
} from "../../api/setup";

const RC_STALE_MS = 2000;
const MAJOR_AXES_LABELS: Record<string, string> = {
  Roll: "Roll (aileron)",
  Pitch: "Pitch (elevator)",
  Throttle: "Throttle",
  Yaw: "Yaw (rudder)",
};
const MAX_CHANNELS = 16;

export type TransmitterMode = "1" | "2" | "3" | "4";

/**
 * Standard RC mode semantics: which function sits on which stick axis.
 *
 *   mode 1  left = throttle/yaw   right = pitch/roll
 *   mode 2  left = throttle/yaw   right = roll/pitch      (most common)
 *   mode 3  left = roll/pitch     right = throttle/yaw
 *   mode 4  left = throttle/roll  right = yaw/pitch
 *
 * This is presentation only. Selecting a mode never writes a vehicle parameter
 * and never changes the real mapping, which always comes from RCMAP_*.
 */
const MODE_LAYOUT: Record<
  TransmitterMode,
  { left: { vertical: string; horizontal: string }; right: { vertical: string; horizontal: string } }
> = {
  "1": {
    left: { vertical: "Throttle", horizontal: "Yaw" },
    right: { vertical: "Pitch", horizontal: "Roll" },
  },
  "2": {
    left: { vertical: "Throttle", horizontal: "Yaw" },
    right: { vertical: "Pitch", horizontal: "Roll" },
  },
  "3": {
    left: { vertical: "Pitch", horizontal: "Roll" },
    right: { vertical: "Throttle", horizontal: "Yaw" },
  },
  "4": {
    left: { vertical: "Throttle", horizontal: "Roll" },
    right: { vertical: "Pitch", horizontal: "Yaw" },
  },
};

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="setup-page setup-radio-page" data-testid="setup-radio">
      <div className="setup-page-header">
        <h2 className="setup-page-title">Radio Setup</h2>
        <p className="setup-page-subtitle">
          Radio Setup is used to calibrate your transmitter and assign Roll,
          Pitch, Yaw and Throttle control channels.
        </p>
      </div>
      {children}
    </div>
  );
}

function signalLabel(signal: string | undefined): string {
  switch (signal) {
    case "RECEIVING":
      return "RECEIVING";
    case "NO_SIGNAL":
      return "NO SIGNAL";
    case "WAITING":
      return "WAITING FOR TELEMETRY";
    default:
      return "UNKNOWN";
  }
}

function signalClass(signal: string | undefined): string {
  return signal === "RECEIVING"
    ? "radio-signal-ok"
    : signal === "NO_SIGNAL"
      ? "radio-signal-bad"
      : "radio-signal-warn";
}

/** One live channel bar. Values come exclusively from telemetry.rcChannels. */
function ChannelBar({
  channel,
  value,
  pwmMin,
  pwmMax,
  pwmTrim,
  stale,
  state,
  testIdPrefix = "radio-bar",
}: {
  channel: number;
  value: number;
  pwmMin: number;
  pwmMax: number;
  pwmTrim?: number | null;
  stale: boolean;
  state?: "LIVE" | "WAITING" | "STALE" | "UNAVAILABLE";
  testIdPrefix?: string;
}) {
  const span = Math.max(1, pwmMax - pwmMin);
  const clamped = Math.min(Math.max(value, pwmMin), pwmMax);
  const pct = ((clamped - pwmMin) / span) * 100;
  const trimPct =
    pwmTrim != null && pwmTrim > 0
      ? Math.min(100, Math.max(0, ((pwmTrim - pwmMin) / span) * 100))
      : null;
  return (
    <div className={`radio-bar-row${stale ? " radio-bar-stale" : ""}`} data-testid={`${testIdPrefix}-${channel}`}>
      <span className="radio-bar-channel">CH{channel}</span>
      <div className="radio-bar-track">
        <div className="radio-bar-fill" style={{ width: `${pct}%` }} />
        {trimPct != null && (
          <div
            className="radio-bar-trim"
            style={{ left: `${trimPct}%` }}
            data-testid={`${testIdPrefix}-trim-${channel}`}
          />
        )}
      </div>
      <span className="radio-bar-value" data-testid={`${testIdPrefix}-value-${channel}`}>
        {value > 0 ? value : "—"}
      </span>
      <div className="radio-monitor-row-meta">
        {state && (
          <span
            className={`radio-channel-state is-${state.toLowerCase()}`}
            data-testid={`${testIdPrefix}-state-${channel}`}
          >
            {state}
          </span>
        )}
        <span data-testid={`${testIdPrefix}-min-${channel}`}>MIN {pwmMin}</span>
        {trimPct != null && <span data-testid={`${testIdPrefix}-trimval-${channel}`}>TRIM {pwmTrim}</span>}
        <span data-testid={`${testIdPrefix}-max-${channel}`}>MAX {pwmMax}</span>
      </div>
    </div>
  );
}

/**
 * Dual-stick transmitter visualization.
 *
 * The marker position comes only from a real RC_CHANNELS value routed through the
 * genuine RCMAP mapping. With no live value the marker sits centred and the row
 * reads "—" — it is never parked at a plausible-looking default.
 */
function TransmitterVisualization({
  mappings,
  channels,
  mode,
  hasSignal,
}: {
  mappings: RadioStatus["mainControls"]["mappings"];
  channels: Array<{ channel: number; value: number }>;
  mode: TransmitterMode;
  hasSignal: boolean;
}) {
  const layout = MODE_LAYOUT[mode];
  const mappedValue = (functionName: string) => {
    const channel = mappings.find((mapping) => mapping.function === functionName)?.channel;
    return channel == null ? null : channels.find((item) => item.channel === channel)?.value ?? null;
  };
  const valueOf = {
    Roll: mappedValue("Roll"),
    Pitch: mappedValue("Pitch"),
    Yaw: mappedValue("Yaw"),
    Throttle: mappedValue("Throttle"),
  };
  /** Normalise a real PWM value into a 0-100 track position. */
  const position = (value: number | null) =>
    value == null ? 50 : Math.min(100, Math.max(0, ((value - 1000) / 1000) * 100));
  const stick = (
    axes: { vertical: string; horizontal: string },
    testId: string,
  ) => {
    const vertical = valueOf[axes.vertical as keyof typeof valueOf] ?? null;
    const horizontal = valueOf[axes.horizontal as keyof typeof valueOf] ?? null;
    return (
      <div className="radio-stick" data-testid={testId}>
        <span className="radio-stick-cap top">{axes.vertical}</span>
        <span className="radio-stick-cap bottom">{axes.vertical}</span>
        <span className="radio-stick-cap left">{axes.horizontal}</span>
        <span className="radio-stick-cap right">{axes.horizontal}</span>
        <span
          style={{ left: `${position(horizontal)}%`, top: `${100 - position(vertical)}%` }}
          data-testid={`${testId}-marker`}
        />
      </div>
    );
  };
  return (
    <div className="radio-transmitter-visual" data-testid="setup-radio-transmitter-visual">
      <div className="radio-stick-pair">
        {stick(layout.left, "setup-radio-stick-left")}
        {stick(layout.right, "setup-radio-stick-right")}
      </div>
      <div className="radio-transmitter-values">
        {(["Roll", "Pitch", "Yaw", "Throttle"] as const).map((label) => (
          <span key={label} data-testid={`radio-tx-value-${label.toLowerCase()}`}>
            {label}: <b>{valueOf[label] ?? "—"}</b>
          </span>
        ))}
      </div>
      {!hasSignal && (
        <p className="radio-transmitter-note" data-testid="setup-radio-transmitter-no-signal">
          No live RC input — stick markers are parked at centre. They move only
          when the vehicle reports real RC_CHANNELS values.
        </p>
      )}
    </div>
  );
}

export default function SetupRadio() {
  const telemetry = useTelemetry();
  const store = useParameters();
  const {
    radio,
    calibration,
    message,
    busy,
    connectionLost,
    refresh,
    beginCalibration,
    capture,
    cancelCalibration,
  } = useRadioSetup(telemetry.connected);

  // ---- per-channel configuration draft state (editable before staging) ----
  // Displayed values come straight from the store's live RC parameters unless
  // the user has "touched" a field — then the user's draft wins until the write
  // resolves or the user reverts. This avoids effect-chasing races where a stale
  // store snapshot would clobber an in-progress edit or a freshly verified value.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [draftReversed, setDraftReversed] = useState<Record<string, boolean>>({});
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [configError, setConfigError] = useState<string | null>(null);
  const [writeVisible, setWriteVisible] = useState(false);
  // Local text draft so the field can be cleared mid-edit; the staged parameter
  // value stays the source of truth for what will actually be written.
  const [mapDraft, setMapDraft] = useState<Record<string, string>>({});
  // Scoped so a mapping write never shows an "aux applied" banner, and so the
  // banner survives the staging area being cleared by a successful Apply.
  const [mapWriteVisible, setMapWriteVisible] = useState(false);
  const [auxWriteVisible, setAuxWriteVisible] = useState(false);
  const [pendingWrite, setPendingWrite] = useState(false);
  const [transmitterMode, setTransmitterMode] = useState<TransmitterMode>("1");

  const config = radio?.channelConfig ?? [];
  const auxChannels = radio?.auxChannels;

  const liveValue = (pid: string, fallback: number | null): number | null => {
    const v = store.entries[pid]?.live?.value;
    return typeof v === "number" ? v : fallback;
  };
  const fieldString = (pid: string, fallback: number | null): string => {
    if (touched.has(pid)) return draft[pid] ?? "";
    const v = liveValue(pid, fallback);
    return v === null ? "" : String(v);
  };
  const fieldNumber = (pid: string, fallback: number | null): number | null => {
    const raw = fieldString(pid, fallback);
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const markTouched = (pid: string, value: string) => {
    setDraft((prev) => ({ ...prev, [pid]: value }));
    setTouched((prev) => new Set(prev).add(pid));
  };
  const markReversedTouched = (pid: string, checked: boolean) => {
    setDraftReversed((prev) => ({ ...prev, [pid]: checked }));
    setTouched((prev) => new Set(prev).add(pid));
  };
  const clearRadioEdits = useCallback(() => {
    setTouched(new Set());
    setDraft({});
    setDraftReversed({});
  }, []);

  // ---- channel configuration writes (verified pipeline via ParameterContext) ----
  const radioParamStaged = useMemo(() => {
    if (!store.staged) return 0;
    return Object.keys(store.staged).filter(
      (pid) => /^RC\d+_(MIN|TRIM|MAX|REVERSED)$/.test(pid)
    ).length;
  }, [store.staged]);

  // ---- staged radio writes (RCMAP mapping + aux function assignments) ----
  // Both use the same verified pipeline as the channel endpoints: nothing reaches
  // the vehicle until Apply, and a value is only believed once the autopilot
  // echoes PARAM_VALUE back. Declared before any early return so the hook order
  // is identical on every render.
  const stagedKeys = useMemo(() => Object.keys(store.staged ?? {}), [store.staged]);
  const mapStagedCount = useMemo(
    () => stagedKeys.filter((pid) => pid.startsWith("RCMAP_")).length,
    [stagedKeys],
  );
  const auxStagedCount = useMemo(
    () => stagedKeys.filter((pid) => /^RC\d+_(OPTION|OPT)$/.test(pid)).length,
    [stagedKeys],
  );
  /** True only when the vehicle's own metadata demands a reboot. */
  const mapRebootRequired = useMemo(
    () =>
      (radio?.mainControls.mappings ?? []).some(
        (m) =>
          store.staged?.[m.param] != null &&
          store.entries[m.param]?.metadata?.rebootRequired === true,
      ),
    [radio, store.staged, store.entries],
  );

  // Drop local drafts once nothing is staged any more (Apply or Revert).
  useEffect(() => {
    if (mapStagedCount === 0) setMapDraft({});
  }, [mapStagedCount]);

  const handleConfigApply = () => {
    setConfigError(null);
    const toStage: { pid: string; value: number }[] = [];
    for (const row of config) {
      const pidMin = `RC${row.channel}_MIN`;
      const pidTrim = `RC${row.channel}_TRIM`;
      const pidMax = `RC${row.channel}_MAX`;
      const minRaw = fieldNumber(pidMin, row.min);
      const trimRaw = fieldNumber(pidTrim, row.trim);
      const maxRaw = fieldNumber(pidMax, row.max);
      if (minRaw === null || trimRaw === null || maxRaw === null) {
        setConfigError(`CH${row.channel}: MIN/TRIM/MAX must be numeric PWM values.`);
        return;
      }
      if (!(900 <= minRaw && minRaw <= 2200) ||
          !(900 <= trimRaw && trimRaw <= 2200) ||
          !(900 <= maxRaw && maxRaw <= 2200)) {
        setConfigError(`CH${row.channel}: values must be within 900–2200 µs.`);
        return;
      }
      if (!(minRaw < trimRaw)) {
        setConfigError(`CH${row.channel}: MIN (${minRaw}) must be less than TRIM (${trimRaw}).`);
        return;
      }
      if (!(trimRaw < maxRaw)) {
        setConfigError(`CH${row.channel}: TRIM (${trimRaw}) must be less than MAX (${maxRaw}).`);
        return;
      }
      const revPid = `RC${row.channel}_REVERSED`;
      toStage.push({ pid: pidMin, value: minRaw });
      toStage.push({ pid: pidTrim, value: trimRaw });
      toStage.push({ pid: pidMax, value: maxRaw });
      toStage.push({
        pid: revPid,
        value: touched.has(revPid)
          ? draftReversed[revPid]
            ? 1
            : 0
          : liveValue(revPid, row.reversed) === 1
            ? 1
            : 0,
      });
    }
    for (const item of toStage) {
      const result = store.stageValue(item.pid, item.value);
      if (!result.ok) {
        setConfigError(result.error ?? `Unable to stage ${item.pid}.`);
        return;
      }
    }
    setWriteVisible(true);
    setPendingWrite(true);
  };

  // executeWrite reads the latest staged snapshot from the store's render
  // closure, so it must run AFTER the staged updates from the apply handler
  // have been committed — never synchronously in the same event handler.
  // Covers all three staged groups: channel endpoints, RCMAP mapping and aux
  // function assignments.
  useEffect(() => {
    if (!pendingWrite) return;
    const staged = radioParamStaged + mapStagedCount + auxStagedCount;
    if (staged > 0 && store.connection === "READY") {
      setPendingWrite(false);
      void store.executeWrite();
    } else if (staged === 0) {
      setPendingWrite(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingWrite, radioParamStaged, mapStagedCount, auxStagedCount, store.connection, store.executeWrite]);

  // After a reconnect the backend re-downloads the parameter set before it can
  // answer the radio snapshot with a populated channelConfig. Re-fetch the
  // snapshot exactly once the RC parameters are actually present, so the
  // configuration rows re-populate automatically — no browser refresh needed.
  // The TRIM set is deliberately static (RC1..RC8): right after a reconnect
  // the fetched snapshot has channelConfig [] until the backend download
  // lands, and the trigger must still fire on the parameter entries.
  const rcTrimPids = useMemo(
    () => Array.from({ length: 8 }, (_, i) => `RC${i + 1}_TRIM`),
    [],
  );
  const rcParamsPresent = useMemo(
    () =>
      rcTrimPids.length > 0 &&
      rcTrimPids.some((pid) => typeof store.entries[pid]?.live?.value === "number"),
    [rcTrimPids, store.entries],
  );
  const prevRcPresent = useRef<boolean>(false);
  useEffect(() => {
    if (rcParamsPresent && !prevRcPresent.current) {
      prevRcPresent.current = true;
      void refresh();
    } else if (!rcParamsPresent) {
      prevRcPresent.current = false;
    }
  }, [rcParamsPresent, refresh]);

  const handleConfigRevert = () => {
    setConfigError(null);
    if (radioParamStaged > 0) store.discardAll();
    clearRadioEdits();
    setWriteVisible(false);
  };

  // A failed/interrupted write never modified the vehicle: drop the staged
  // radio values and the local edits so the honest live readback appears. A
  // verified success replaces the live values, so the drafts must clear too.
  const prevWritePhase = useRef<string | null>(null);
  useEffect(() => {
    const phase = store.writePhase;
    const cameFromRunning = prevWritePhase.current === "running";
    prevWritePhase.current = phase;
    if (!cameFromRunning) return;
    if (phase === "error" || phase === "interrupted") {
      store.discardAll();
      clearRadioEdits();
      setWriteVisible(true);
    } else if (phase === "success") {
      clearRadioEdits();
      setWriteVisible(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.writePhase, clearRadioEdits]);

  // ---- live RC freshness (bars must never show stale data as current) ----
  const rcReceivedAt = telemetry.rcReceivedAt ?? 0;
  const hasLiveRc =
    (Array.isArray(telemetry.rcChannels) && telemetry.rcChannels.length > 0) ||
    (radio?.rc.channels?.length ?? 0) > 0;
  const freshRc =
    rcReceivedAt > 0 && (Date.now() / 1000 - rcReceivedAt) * 1000 <= RC_STALE_MS;

  const liveSignal: "RECEIVING" | "NO_SIGNAL" | "WAITING" | "UNKNOWN" = useMemo(() => {
    if (!telemetry.connected) return "NO_SIGNAL";
    if (!hasLiveRc) return "WAITING";
    if (!freshRc) return "NO_SIGNAL";
    if ((telemetry.rcRssi ?? 0) <= 0) return "NO_SIGNAL";
    return "RECEIVING";
  }, [telemetry.connected, hasLiveRc, freshRc, telemetry.rcRssi]);

  const liveChannels = useMemo(() => {
    const rcChannels = telemetry.rcChannels;
    if (rcChannels && rcChannels.length > 0 && freshRc) {
      const count = telemetry.rcChannelCount || rcChannels.length;
      return rcChannels.slice(0, Math.min(count, MAX_CHANNELS)).map((value, idx) => ({
        channel: idx + 1,
        value: value ?? 0,
      }));
    }
    // Fall back to the last backend snapshot when live is unavailable, but the
    // UI marks the whole monitor stale — never presented as current.
    const stored = radio?.rc.channels ?? [];
    const count = radio?.rc.channelCount || stored.length || 0;
    return stored.slice(0, Math.min(count, MAX_CHANNELS)).map((c) => ({
      channel: c.channel,
      value: c.value,
    }));
  }, [telemetry.rcChannels, telemetry.rcChannelCount, freshRc, radio]);

  const endpointFor = (channel: number, key: "min" | "max" | "trim"): number | null => {
    const row = radio?.channelConfig.find((c) => c.channel === channel);
    const live = store.entries[`RC${channel}_${key.toUpperCase()}`]?.live?.value;
    const value = live ?? row?.[key];
    return typeof value === "number" && value > 0 ? value : null;
  };

  /**
   * Per-channel honesty for the monitor: a channel is only LIVE when a real
   * value with a usable range has just arrived. Existing is not the same as live.
   */
  const channelState = (
    value: number,
    hasRange: boolean,
  ): "LIVE" | "WAITING" | "STALE" | "UNAVAILABLE" => {
    if (!hasRange) return "UNAVAILABLE";
    if (liveSignal === "RECEIVING") return value > 0 ? "LIVE" : "WAITING";
    if (liveSignal === "WAITING") return "WAITING";
    return "STALE";
  };

  /**
 * Header state is derived from live telemetry, which keeps arriving over the
 * socket. The one-time `rcState` from the snapshot is deliberately not used
 * here: it would go stale and could contradict the newest RC_CHANNELS frame.
 */
const rcStateLabel = signalLabel(liveSignal);

  // ---- page state machine (authoritative, derived) ----
  const connecting = telemetry.connectionState === "CONNECTING";
  const lost =
    !telemetry.connected && !connecting && telemetry.disconnectReason != null;
  const unsupported = radio?.success === true && radio.supported === false;
  const syncing = radio === null;
  const failed = !syncing && radio?.success !== true;

  if (!telemetry.connected) {
    const reason = connecting
      ? "Establishing a MAVLink link with the flight controller."
      : lost
        ? `Reason: ${telemetry.disconnectReason}`
        : "Connect a Pixhawk or MAVLink vehicle to inspect its RC receiver.";
    return (
      <PageShell>
        <div
          className="setup-disconnected"
          data-testid={connecting ? "setup-radio-connecting" : lost ? "setup-radio-lost" : "setup-radio-waiting"}
        >
          {connecting ? (
            <Loader size={26} className="setup-spinner" />
          ) : lost ? (
            <WifiOff size={26} />
          ) : (
            <RadioTower size={26} />
          )}
          <p className="setup-disconnected-title">
            {connecting
              ? "Connecting to vehicle"
              : lost
                ? "MAVLink connection lost"
                : "Waiting for vehicle"}
          </p>
          {lost && (
            <p className="setup-disconnected-reason" data-testid="setup-radio-lost-reason">
              {reason}
            </p>
          )}
          <p className="setup-disconnected-hint">
            {reason}
          </p>
          {connectionLost && (
            <p className="setup-note" data-testid="setup-radio-connection-lost">
              RC telemetry was cleared. It will be restored automatically after reconnect.
            </p>
          )}
        </div>
      </PageShell>
    );
  }

  if (syncing) {
    return (
      <PageShell>
        <section className="setup-card">
          <div className="setup-fw-loading" data-testid="setup-radio-syncing">
            <Loader size={18} className="setup-spinner" />
            Syncing radio telemetry and RC parameters from the vehicle…
          </div>
        </section>
      </PageShell>
    );
  }

  if (failed) {
    return (
      <PageShell>
        <section className="setup-card" data-testid="setup-radio-error">
          <div className="setup-fw-error">
            <AlertCircle size={18} />
            {radio?.success === false && (
              <span>{radio.message ?? "Radio information could not be retrieved."}</span>
            )}
            {!radio && <span>Radio information could not be retrieved.</span>}
          </div>
          <button
            type="button"
            className="setup-refresh-btn"
            onClick={refresh}
            data-testid="setup-radio-retry"
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </section>
      </PageShell>
    );
  }

  const info = radio as RadioStatus & { success: true };

  const unsupportedCard = (
    <>
      <section className="setup-card" data-testid="setup-radio-unsupported">
        <div className="setup-fw-error">
          <AlertTriangle size={18} />
          <div>
            <p className="setup-fw-error-title">Unsupported vehicle</p>
            <p>
              YantraYug Radio Setup is ArduCopter-only. The connected vehicle is
              not supported.
            </p>
            {info.unsupportedReason && (
              <p className="setup-fw-error-reason">{info.unsupportedReason}</p>
            )}
          </div>
        </div>
      </section>
    </>
  );

  if (unsupported) {
    return (
      <PageShell>
        {unsupportedCard}
      </PageShell>
    );
  }

  // ---------------------------------------------------------------------
  // READY — full Radio surface
  // ---------------------------------------------------------------------
  const rcCount = liveChannels.length || info.rc.channelCount || 0;
  const lastRc = info.rc.receivedAt
    ? new Date(info.rc.receivedAt * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";

  // ---- calibration stage rail ----
  const calibrationStage =
    (calibration.stage as string | undefined) ??
    (radio?.calibrationStage as string | undefined) ??
    "IDLE";
  const stageOrder = ["READY", "CALIBRATING", "FINALIZING", "SUCCESS"];
  const stageIndex = stageOrder.indexOf(calibrationStage);

  // ---- calibration helpers ----
  const calibrationRequiresSignal = liveSignal !== "RECEIVING";

  const calibrationPanel = (() => {
    switch (calibration.state) {
      case "idle":
        return (
          <div className="radio-cal-step">
            <p className="radio-cal-hint" data-testid="radio-cal-idle">
              Calibration reads your transmitter stick positions from the live
              RC telemetry, then writes the captured MIN / TRIM / MAX values to
              the vehicle with the same verified write pipeline used by the
              channel configuration below. Nothing is applied unless the vehicle
              echoes it.
            </p>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={beginCalibration}
              disabled={busy}
              data-testid="radio-cal-start"
            >
              {busy ? <Loader size={13} className="setup-spinner" /> : <Gamepad2 size={13} />}
              Calibrate Radio
            </button>
          </div>
        );
      case "ready":
        return (
          <div className="radio-cal-step">
            <p className="radio-cal-hint" data-testid="radio-cal-ready">
              Move the transmitter sticks to their CENTER position, then press
              Capture Center.
            </p>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={() => capture("center")}
              disabled={busy || calibrationRequiresSignal}
              data-testid="radio-cal-capture-center"
            >
              Capture Center
            </button>
          </div>
        );
      case "center-done":
        return (
          <div className="radio-cal-step">
            <p className="radio-cal-hint" data-testid="radio-cal-center-done">
              Center captured. Hold ALL sticks at their MINIMUM, then press
              Capture Minimum.
            </p>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={() => capture("min")}
              disabled={busy || calibrationRequiresSignal}
              data-testid="radio-cal-capture-min"
            >
              Capture Minimum
            </button>
          </div>
        );
      case "min-done":
        return (
          <div className="radio-cal-step">
            <p className="radio-cal-hint" data-testid="radio-cal-min-done">
              Minimum captured. Hold ALL sticks at their MAXIMUM, then press
              Capture Maximum.
            </p>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={() => capture("max")}
              disabled={busy || calibrationRequiresSignal}
              data-testid="radio-cal-capture-max"
            >
              Capture Maximum
            </button>
          </div>
        );
      case "capturing-center":
      case "capturing-min":
      case "capturing-max":
        return (
          <div className="radio-cal-step" data-testid={`radio-cal-${calibration.state}`}>
            <div className="radio-cal-running">
              <Loader size={16} className="setup-spinner" />
              <span>
                {calibration.message ||
                  "Capturing live RC frames… move the sticks as instructed."}
              </span>
            </div>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-danger"
              onClick={cancelCalibration}
              disabled={busy}
              data-testid="radio-cal-cancel"
            >
              Cancel
            </button>
          </div>
        );
      case "validating":
        return (
          <div className="radio-cal-step" data-testid="radio-cal-validating">
            <div className="radio-cal-running">
              <Loader size={16} className="setup-spinner" />
              <span>Validating captured endpoints and writing to the vehicle…</span>
            </div>
          </div>
        );
      case "completed":
        // "completed" only means the machine finished. The backend sets that
        // state only after the verified write succeeds, but the success claim
        // still has to be backed by the result payload itself. If the result is
        // missing or reports failure, do not render a success banner.
        if (!calibration.result || calibration.result.result !== "success") {
          return (
            <div className="radio-cal-step" data-testid="radio-cal-unverified">
              <div className="radio-cal-failed">
                <AlertTriangle size={16} />
                <span>
                  {calibration.result?.message ||
                    calibration.message ||
                    "Calibration finished but the vehicle did not confirm the endpoints."}
                </span>
              </div>
              <button
                type="button"
                className="setup-params-btn setup-params-btn-primary"
                onClick={beginCalibration}
                disabled={busy}
                data-testid="radio-cal-restart"
              >
                Calibrate Again
              </button>
            </div>
          );
        }
        return (
          <div className="radio-cal-step" data-testid="radio-cal-completed">
            <div className="radio-cal-success">
              <CheckCircle2 size={16} />
              <span>
                {calibration.result.message ||
                  "Calibration completed — endpoints verified on the vehicle."}
              </span>
            </div>
            {calibration.result?.values && (
              <ul className="radio-cal-values">
                {calibration.result.values.map((v) => (
                  <li key={v.param}>
                    <span>{v.param}</span>
                    <span>{v.value}</span>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={beginCalibration}
              disabled={busy}
              data-testid="radio-cal-restart"
            >
              Calibrate Again
            </button>
          </div>
        );
      case "failed":
      case "timeout":
      case "cancelled":
        return (
          <div className="radio-cal-step" data-testid={`radio-cal-${calibration.state}`}>
            <div className="radio-cal-failed">
              <AlertTriangle size={16} />
              <span>{calibration.message || "Radio calibration did not complete."}</span>
            </div>
            <button
              type="button"
              className="setup-params-btn setup-params-btn-primary"
              onClick={beginCalibration}
              disabled={busy}
              data-testid="radio-cal-restart-failed"
            >
              Restart Calibration
            </button>
          </div>
        );
      default:
        return null;
    }
  })();

  return (
    <PageShell>
      {message && (
        <div className="radio-page-message" data-testid="setup-radio-message">
          <AlertCircle size={14} />
          {message}
        </div>
      )}

      <section className="radio-status-strip" data-testid="setup-radio-status-card">
        <span className="radio-status-connected">Connected</span>
        <span>•</span>
        <strong>{info.transport}</strong>
        <span className="radio-status-identity">{info.vehicleType}</span>
        <span className="radio-status-identity">{info.autopilot}</span>
        <span>•</span>
        <span className={`radio-signal-badge ${signalClass(liveSignal)}`} data-testid="setup-radio-signal">
          <Activity size={13} />
          {rcStateLabel}
        </span>
        <span>•</span>
        {/* MAVLink uses 0 and 255 as "no valid RC link" / "RSSI unknown". Neither
            is a signal strength, so both render as an explicit unavailable
            state instead of a misleading number. */}
        {info.rc.rssiReport?.available ? (
          <span data-testid="setup-radio-rssi">RSSI {info.rc.rssiReport.value}</span>
        ) : (
          <span
            className="radio-rssi-unavailable"
            data-testid="setup-radio-rssi"
            title={info.rc.rssiReport?.unavailableReason ?? undefined}
          >
            RSSI Unavailable
          </span>
        )}
        <span>•</span>
        <span data-testid="setup-radio-chancount">
          {rcCount > 0 ? `${rcCount} channels` : "No channels reported"}
        </span>
      </section>
      <div className="radio-main-workspace">
        <div className="radio-main-column">
        <section className="radio-section radio-attitude-card" data-testid="setup-radio-maincontrols">
        <h3 className="setup-card-title">Attitude Controls</h3>
        <div className="setup-fw-grid">
        {info.mainControls.supported ? (
          <div className="radio-attitude-rows" data-testid="setup-radio-mapping">
              {info.mainControls.mappings.map((m) => {
                const live = liveChannels.find((c) => c.channel === m.channel);
                const min = m.channel != null ? endpointFor(m.channel, "min") : null;
                const max = m.channel != null ? endpointFor(m.channel, "max") : null;
                const trim = m.channel != null ? endpointFor(m.channel, "trim") : null;
                const staged = m.param ? store.staged?.[m.param]?.stagedValue : undefined;
                const current = m.param ? store.entries[m.param]?.live?.value : undefined;
                return (
                  <div className="radio-attitude-row" key={m.function} data-testid={`setup-radio-map-${m.function.toLowerCase()}`}>
                    <span className="radio-attitude-label">{MAJOR_AXES_LABELS[m.function] ?? m.function}</span>
                    <span className="radio-attitude-map">
                      {m.param} · {m.channel != null ? `CH${m.channel}` : "Unavailable"}
                    </span>
                    <span className="radio-map-row">
                      <input
                        className="radio-map-input"
                        type="number"
                        min={1}
                        max={MAX_CHANNELS}
                        aria-label={`${m.param} channel`}
                        data-testid={`setup-radio-map-input-${m.function.toLowerCase()}`}
                        disabled={store.writePhase === "running" || store.connection !== "READY"}
                        value={
                          mapDraft[m.param] ??
                          String(staged ?? current ?? (m.channel != null ? m.channel : ""))
                        }
                        onChange={(e) => {
                          const raw = e.target.value;
                          setMapDraft((prev) => ({ ...prev, [m.param]: raw }));
                          // An empty field is a transient edit state, not a value.
                          if (raw.trim() === "") return;
                          const next = Number(raw);
                          if (!Number.isInteger(next) || next < 1 || next > MAX_CHANNELS) {
                            // Drop any pending value from an earlier keystroke so the
                            // PENDING badge can never contradict the field contents.
                            store.revert(m.param);
                            setConfigError(
                              `${m.param}: channel must be a whole number between 1 and ${MAX_CHANNELS}.`,
                            );
                            return;
                          }
                          setConfigError(null);
                          const result = store.stageValue(m.param, next);
                          if (!result.ok) setConfigError(result.error ?? `Unable to stage ${m.param}.`);
                        }}
                      />
                      <span
                        className={`radio-map-current${staged != null ? " is-pending" : ""}`}
                        data-testid={`setup-radio-map-current-${m.function.toLowerCase()}`}
                      >
                        {staged != null
                          ? `PENDING ${staged} (current ${current ?? "—"})`
                          : `CURRENT ${current ?? "—"}`}
                      </span>
                      {live && min !== null && max !== null ? (
                        <ChannelBar
                          channel={m.channel as number}
                          value={live.value}
                          pwmMin={min}
                          pwmMax={max}
                          pwmTrim={trim}
                          stale={liveSignal !== "RECEIVING"}
                          state={channelState(live.value, true)}
                          testIdPrefix="radio-attitude-bar"
                        />
                      ) : (
                        <span className="radio-no-data" data-testid={`setup-radio-nodata-${m.function.toLowerCase()}`}>
                          No live channel data
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
              {mapStagedCount > 0 && (
                <>
                  <div className="radio-config-actions" data-testid="setup-radio-map-actions">
                    <button
                      type="button"
                      className="setup-params-btn setup-params-btn-danger"
                      onClick={() => {
                        setConfigError(null);
                        if (mapStagedCount > 0) store.discardAll();
                      }}
                      disabled={store.writePhase === "running"}
                      data-testid="setup-radio-map-revert"
                    >
                      <RotateCcw size={13} />
                      Revert
                    </button>
                    <button
                      type="button"
                      className="setup-params-btn setup-params-btn-primary"
                      onClick={() => {
                        setConfigError(null);
                        setMapWriteVisible(true);
                        setWriteVisible(true);
                        setPendingWrite(true);
                      }}
                      disabled={
                        mapStagedCount === 0 ||
                        store.writePhase === "running" ||
                        store.connection !== "READY"
                      }
                      data-testid="setup-radio-map-apply"
                    >
                      {store.writePhase === "running" ? (
                        <Loader size={13} className="setup-spinner" />
                      ) : (
                        <Save size={13} />
                      )}
                      {store.writePhase === "running" ? "Applying…" : "Apply Mapping"}
                    </button>
                  </div>
                  {mapRebootRequired && (
                    <div className="radio-reboot-warning" data-testid="setup-radio-map-reboot-warning">
                      <AlertTriangle size={14} />
                      <span>
                        The vehicle reports this parameter needs a reboot to take
                        effect. The mapping is not applied until the autopilot
                        restarts — nothing is rebooted automatically from this page.
                      </span>
                    </div>
                  )}
                </>
              )}
              {/* Outcome banners live outside the staging gate so they survive
                  Apply clearing the staged values. */}
              {mapWriteVisible && store.writePhase === "success" && (
                <div className="radio-cal-success" data-testid="setup-radio-map-write-success">
                  <CheckCircle2 size={14} />
                  <span>
                    {store.writeSummary?.succeeded ?? store.writeSummary?.results?.length ?? 0}{" "}
                    mapping value(s) verified by the vehicle&apos;s parameter echo.
                  </span>
                </div>
              )}
              {mapWriteVisible && store.writeError && store.writePhase !== "running" && (
                <div className="frame-error" data-testid="setup-radio-map-write-error">
                  <XCircle size={14} />
                  {store.writeError.message ??
                    "Failed to apply the mapping — previous values were preserved."}
                </div>
              )}
          </div>
        ) : (
          <div className="setup-fw-error" data-testid="setup-radio-map-unavailable">
            <AlertTriangle size={16} />
            <span>Mapping information unavailable — RCMAP parameters were not found.</span>
          </div>
        )}
        <p className="setup-note">
          The main control mapping is read from the vehicle's genuine RCMAP
          parameters — it is never assumed to be CH1–CH4.
        </p>
        </div>
      </section>

      {/* Additional Radio Setup — every control below is backed by a parameter
          that genuinely exists on the connected ArduCopter firmware. A channel
          the firmware does not publish is reported unavailable, never faked. */}
      <section className="radio-section radio-additional-setup" data-testid="setup-radio-additional">
        <h3 className="setup-card-title">Additional Radio Setup</h3>
        {!auxChannels?.supported ? (
          <div className="radio-no-data" data-testid="setup-radio-aux-unsupported">
            Unavailable on this firmware — no RC function-assignment parameters
            (RCn_OPTION) were reported by the vehicle, so no aux or parameter
            channel can be configured. This is an ArduCopter capability check, not
            a disabled control.
          </div>
        ) : (
          <div className="radio-additional-grid" data-testid="setup-radio-aux-grid">
            {auxChannels.channels
              .filter((row) => row.supported && !row.isMainControl)
              .map((row) => {
                const pid = row.param as string;
                const pending = store.staged?.[pid]?.stagedValue;
                const current = store.entries[pid]?.live?.value;
                const shown = pending ?? current;
                return (
                  <label className="radio-aux-row" key={row.channel}>
                    <span className="radio-aux-channel">CH{row.channel}</span>
                    <span className="radio-aux-label" data-testid={`setup-radio-aux-label-${row.channel}`}>
                      {row.options.find((o) => o.value === shown)?.label ??
                        (shown != null ? `Value ${shown}` : "Unassigned")}
                    </span>
                    <select
                      value={shown != null ? String(shown) : ""}
                      disabled={store.writePhase === "running" || store.connection !== "READY"}
                      aria-label={`CH${row.channel} function`}
                      data-testid={`setup-radio-aux-select-${row.channel}`}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        const result = store.stageValue(pid, next);
                        if (!result.ok) setConfigError(result.error ?? `Unable to stage ${pid}.`);
                      }}
                    >
                      {row.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
          </div>
        )}
        <div className="radio-additional-actions">
          {/* PX4/QGC-only controls are named as unsupported rather than faked. */}
          <span className="radio-unsupported-control">Spectrum Bind · Unsupported on ArduCopter</span>
          <span className="radio-unsupported-control">Copy Trims · Unsupported on ArduCopter</span>
        </div>
        {auxStagedCount > 0 && (
          <div className="radio-unsaved" data-testid="setup-radio-aux-staged">
            <RotateCcw size={14} />
            <span>
              {auxStagedCount} function assignment{auxStagedCount === 1 ? "" : "s"} staged —
              the vehicle has not been modified yet.
            </span>
          </div>
        )}
        <div className="radio-config-actions">
          <button
            type="button"
            className="setup-params-btn setup-params-btn-danger"
            onClick={() => {
              setConfigError(null);
              if (auxStagedCount > 0) store.discardAll();
            }}
            disabled={store.writePhase === "running"}
            data-testid="setup-radio-aux-revert"
          >
            <RotateCcw size={13} />
            Revert
          </button>
          <button
            type="button"
            className="setup-params-btn setup-params-btn-primary"
            onClick={() => {
              setConfigError(null);
              setAuxWriteVisible(true);
              setWriteVisible(true);
              setPendingWrite(true);
            }}
            disabled={
              auxStagedCount === 0 ||
              store.writePhase === "running" ||
              store.connection !== "READY"
            }
            data-testid="setup-radio-aux-apply"
          >
            {store.writePhase === "running" ? (
              <Loader size={13} className="setup-spinner" />
            ) : (
              <Save size={13} />
            )}
            {store.writePhase === "running" ? "Applying…" : "Apply Changes"}
          </button>
        </div>
        {auxWriteVisible && store.writePhase === "success" && (
          <div className="radio-cal-success" data-testid="setup-radio-aux-write-success">
            <CheckCircle2 size={14} />
            <span>
              {store.writeSummary?.succeeded ?? store.writeSummary?.results?.length ?? 0}{" "}
              function assignment(s) verified on the vehicle.
            </span>
          </div>
        )}
        {auxWriteVisible && store.writeError && store.writePhase !== "running" && (
          <div className="frame-error" data-testid="setup-radio-aux-write-error">
            <XCircle size={14} />
            {store.writeError.message ?? "Failed to apply — previous values were preserved."}
          </div>
        )}
      </section>
      <details className="radio-section radio-advanced-config" data-testid="setup-radio-config">
        <summary className="setup-card-title">Advanced RC Channel Configuration</summary>
        <h3 className="setup-card-title radio-additional-title">RC endpoint parameters</h3>
        <div className="radio-additional-actions">
          <span className="radio-unsupported-control">Spectrum Bind · Unsupported</span>
          <span className="radio-unsupported-control">Copy Trims · Unsupported</span>
        </div>
        {(!radio?.channelConfig || radio.channelConfig.length === 0) ? (
          <div className="setup-fw-loading" data-testid="setup-radio-config-empty">
            Waiting for RC parameters from the vehicle…
          </div>
        ) : (
          <div className="radio-config-table">
            {(radio?.channelConfig ?? []).map((row: RadioChannelConfig) => (
              <div className="radio-config-row" key={row.channel} data-testid={`radio-config-${row.channel}`}>
                <span className="radio-config-channel">CH{row.channel}</span>
                <label className="radio-config-field">
                  <span className="radio-config-label">MIN</span>
                  <input
                    type="number"
                    value={fieldString(`RC${row.channel}_MIN`, row.min)}
                    disabled={store.writePhase === "running"}
                    onChange={(e) => markTouched(`RC${row.channel}_MIN`, e.target.value)}
                    data-testid={`radio-config-min-${row.channel}`}
                  />
                </label>
                <label className="radio-config-field">
                  <span className="radio-config-label">TRIM</span>
                  <input
                    type="number"
                    value={fieldString(`RC${row.channel}_TRIM`, row.trim)}
                    disabled={store.writePhase === "running"}
                    onChange={(e) => markTouched(`RC${row.channel}_TRIM`, e.target.value)}
                    data-testid={`radio-config-trim-${row.channel}`}
                  />
                </label>
                <label className="radio-config-field">
                  <span className="radio-config-label">MAX</span>
                  <input
                    type="number"
                    value={fieldString(`RC${row.channel}_MAX`, row.max)}
                    disabled={store.writePhase === "running"}
                    onChange={(e) => markTouched(`RC${row.channel}_MAX`, e.target.value)}
                    data-testid={`radio-config-max-${row.channel}`}
                  />
                </label>
                <label className="radio-config-field radio-config-reversed">
                  <input
                    type="checkbox"
                    checked={
                      touched.has(`RC${row.channel}_REVERSED`)
                        ? draftReversed[`RC${row.channel}_REVERSED`] ?? false
                        : liveValue(`RC${row.channel}_REVERSED`, row.reversed) === 1
                    }
                    disabled={store.writePhase === "running"}
                    onChange={(e) =>
                      markReversedTouched(`RC${row.channel}_REVERSED`, e.target.checked)
                    }
                    data-testid={`radio-config-reversed-${row.channel}`}
                  />
                  <span className="radio-config-label">Reversed</span>
                </label>
              </div>
            ))}
          </div>
        )}
        {configError && (
          <div className="frame-error" data-testid="radio-config-error">
            <AlertTriangle size={14} />
            {configError}
          </div>
        )}
        {radioParamStaged > 0 && (
          <div className="radio-unsaved">
            <RotateCcw size={14} />
            <span>
              {radioParamStaged} radio value{radioParamStaged === 1 ? "" : "s"} staged — the
              vehicle has not been modified yet.
            </span>
          </div>
        )}
        <div className="radio-config-actions">
          <button
            type="button"
            className="setup-params-btn"
            onClick={refresh}
            disabled={store.writePhase === "running"}
            data-testid="radio-config-refresh"
          >
            <RefreshCw size={13} />
            Refresh
          </button>
          <button
            type="button"
            className="setup-params-btn setup-params-btn-danger"
            onClick={handleConfigRevert}
            disabled={store.writePhase === "running"}
            data-testid="radio-config-revert"
          >
            <RotateCcw size={13} />
            Revert
          </button>
          <button
            type="button"
            className="setup-params-btn setup-params-btn-primary"
            onClick={handleConfigApply}
            disabled={store.writePhase === "running" || store.connection !== "READY"}
            data-testid="radio-config-apply"
          >
            {store.writePhase === "running" ? (
              <Loader size={13} className="setup-spinner" />
            ) : (
              <Save size={13} />
            )}
            {store.writePhase === "running" ? "Applying…" : "Apply Channel Changes"}
          </button>
        </div>
        {store.writePhase === "running" && (
          <div className="frame-write-running" data-testid="radio-config-writing">
            <Loader size={14} className="setup-spinner" />
            Writing
            {store.writeProgress.currentParamId ? ` ${store.writeProgress.currentParamId}` : ""}…
            <span>
              {store.writeProgress.completed} / {store.writeProgress.total} verified
            </span>
          </div>
        )}
        {writeVisible && store.writeError && store.writePhase !== "running" && (
          <div className="frame-error" data-testid="radio-config-write-error">
            <XCircle size={14} />
            {store.writeError.message ?? "Failed to apply parameter — previous values were preserved."}
          </div>
        )}
        {writeVisible && store.writePhase === "success" && (
          <div className="radio-cal-success" data-testid="radio-config-write-success">
            <CheckCircle2 size={14} />
            <span>
              {store.writeSummary?.succeeded ?? store.writeSummary?.results?.length ?? 0} parameter
              {store.writeSummary?.succeeded === 1 ? "" : "s"} verified on the vehicle.
            </span>
          </div>
        )}
        <p className="setup-note">
          Endpoint values are written through the verified parameter pipeline:
          PARAM_SET is sent and only confirmed after the vehicle echoes the new
          PARAM_VALUE. MIN &lt; TRIM &lt; MAX is enforced before anything is sent.
        </p>
      </details>

      {/* Radio calibration */}
      <section className="radio-section radio-calibration-section" data-testid="setup-radio-calibration">
        <h3 className="setup-card-title">
          <SlidersHorizontal size={15} />
          Radio Calibration
        </h3>
        <div className="radio-cal-stage" data-testid="radio-cal-stage">
          {["IDLE", "READY", "CALIBRATING", "FINALIZING", "SUCCESS"].map((stage) => {
            const idx = stageOrder.indexOf(stage);
            const isCurrent = stage === calibrationStage;
            const isDone = stageIndex > -1 && idx < stageIndex;
            return (
              <span
                key={stage}
                className={`radio-cal-stage-chip${isCurrent ? " is-current" : ""}${isDone ? " is-done" : ""}`}
                data-testid={`radio-cal-stage-${stage.toLowerCase()}`}
              >
                {stage}
              </span>
            );
          })}
          <span
            className={`radio-cal-stage-chip${calibrationStage === "WAITING_FOR_RC" ? " is-current" : ""}`}
            data-testid="radio-cal-stage-waiting"
          >
            WAITING FOR RC
          </span>
          {/* Terminal stages are not part of the forward progress order, so they
              get their own chip. Without this a FAILED / CANCELLED /
              DISCONNECTED stage left every chip unhighlighted, which reads as
              "nothing has happened" instead of "this ended badly". */}
          {["FAILED", "CANCELLED", "DISCONNECTED"].includes(calibrationStage) && (
            <span
              className="radio-cal-stage-chip is-current"
              data-testid="radio-cal-stage-terminal"
            >
              {calibrationStage}
            </span>
          )}
        </div>
        {calibrationRequiresSignal && calibration.state === "idle" && (
          <div className="radio-cal-warning" data-testid="radio-cal-no-signal">
            <AlertTriangle size={14} />
            <span>
              RC signal required to calibrate. Move a transmitter stick so the
              receiver is streaming, then try again.
            </span>
          </div>
        )}
        {calibrationPanel}
      </section>
        </div>
        <aside className="radio-side-column">
          <section className="radio-side-section radio-transmitter-card" data-testid="setup-radio-transmitter">
            <h3 className="setup-card-title">Transmitter</h3>
            <div className="radio-mode-toggle" role="group" aria-label="Transmitter visualization mode">
              {(["1", "2", "3", "4"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={transmitterMode === mode ? "is-selected" : ""}
                  aria-pressed={transmitterMode === mode}
                  onClick={() => setTransmitterMode(mode)}
                  data-testid={`setup-radio-mode-${mode}`}
                >
                  Mode {mode}
                </button>
              ))}
            </div>
            <TransmitterVisualization
              mappings={info.mainControls.mappings}
              channels={liveChannels}
              mode={transmitterMode}
              hasSignal={liveSignal === "RECEIVING"}
            />
            <p className="radio-transmitter-note" data-testid="setup-radio-mode-note">
              Mode {transmitterMode} changes how the sticks are drawn only. The real
              control mapping always comes from the vehicle&apos;s RCMAP parameters and
              is never altered by this selector.
            </p>
          </section>
          <section className="radio-side-section" data-testid="setup-radio-monitor">
            <h3 className="setup-card-title">
              Channel Monitor{" "}
              <span className={`radio-signal-badge ${signalClass(liveSignal)}`} data-testid="setup-radio-live-badge">
                {liveSignal === "RECEIVING" ? "Live" : signalLabel(liveSignal)}
              </span>
            </h3>
            {liveChannels.length === 0 ? (
              <div className="radio-no-data" data-testid="setup-radio-no-channels">
                {liveSignal === "WAITING"
                  ? "Waiting for the first RC_CHANNELS frame…"
                  : "No RC signal — move a transmitter stick, or check the receiver."}
              </div>
            ) : (
              <div className="radio-monitor" data-testid="setup-radio-monitor-grid">
                {liveChannels.map(({ channel, value }) => {
                  const min = endpointFor(channel, "min");
                  const max = endpointFor(channel, "max");
                  const trim = endpointFor(channel, "trim");
                  if (min !== null && max !== null) {
                    return (
                      <ChannelBar
                        key={channel}
                        channel={channel}
                        value={value}
                        pwmMin={min}
                        pwmMax={max}
                        pwmTrim={trim}
                        stale={liveSignal !== "RECEIVING"}
                        state={channelState(value, min !== null && max !== null)}
                        testIdPrefix="radio-bar"
                      />
                    );
                  }
                  return (
                    <div key={channel} className="radio-bar-row radio-bar-stale">
                      <span className="radio-bar-channel">CH{channel}</span>
                      <span className="radio-no-data">Range unavailable</span>
                      <span className="radio-bar-value">{value > 0 ? value : "—"}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {liveChannels.length > 0 && (
              <p className="setup-note" data-testid="setup-radio-last-update">
                Last RC frame: {lastRc} · {freshRc ? "fresh" : "stale"}
              </p>
            )}
          </section>
        </aside>
      </div>

      <button
        type="button"
        className="setup-refresh-btn"
        onClick={refresh}
        disabled={busy}
        data-testid="setup-radio-refresh"
      >
        <RefreshCw size={13} />
        Refresh
      </button>

      <p className="setup-note">
        Radio values shown here come from the live RC_CHANNELS telemetry and the
        vehicle's genuine RC parameters. No values are simulated.
      </p>
    </PageShell>
  );
}
