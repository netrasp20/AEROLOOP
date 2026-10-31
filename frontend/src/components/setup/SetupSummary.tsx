import { RefreshCw, WifiOff } from "lucide-react";

import { useTelemetry } from "../../hooks/useTelemetry";
import { useFirmwareInfo } from "../../hooks/useFirmwareInfo";
import type { SetupStatusItem, SetupSummaryData, SetupTone } from "../../api/setup";

interface Props {
  summary: SetupSummaryData | null;
  onNavigate: (id: string) => void;
}

const toneClass: Record<SetupTone, string> = {
  good: "setup-summary-tone-good",
  warn: "setup-summary-tone-warn",
  unsupported: "setup-summary-tone-bad",
  unknown: "setup-summary-tone-muted",
  waiting: "setup-summary-tone-waiting",
};

/**
 * Severity ordering used to derive a panel-header dot from its items. The dot
 * must never overstate health: the worst member of the panel wins, so a
 * panel whose individual states are healthy can still go amber/red honestly.
 */
const TONE_SEVERITY: Record<SetupTone, number> = {
  good: 0,
  waiting: 1,
  unknown: 2,
  warn: 3,
  unsupported: 4,
};

function worstTone(tones: SetupTone[]): SetupTone {
  return tones.reduce<SetupTone>(
    (worst, tone) => (TONE_SEVERITY[tone] > TONE_SEVERITY[worst] ? tone : worst),
    "good"
  );
}

function StatusDot({ tone }: { tone: SetupTone }) {
  return (
    <span
      className={`setup-summary-dot ${toneClass[tone]}`}
      data-tone={tone}
      title={tone}
      aria-hidden="true"
    />
  );
}

function Panel({
  title,
  tone = "unknown",
  children,
  testId,
}: {
  title: string;
  tone?: SetupTone;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section className="setup-summary-panel" data-testid={testId}>
      <header className="setup-summary-panel-header">
        <h3>{title}</h3>
        <StatusDot tone={tone} />
      </header>
      <div className="setup-summary-panel-body">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="setup-summary-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function itemFor(items: SetupStatusItem[], id: string) {
  return items.find((item) => item.id === id);
}

function itemTone(items: SetupStatusItem[], id: string): SetupTone {
  return itemFor(items, id)?.tone ?? "unknown";
}

function itemValue(items: SetupStatusItem[], id: string, fallback = "Unavailable") {
  const item = itemFor(items, id);
  if (!item) return fallback;
  return item.detail ? `${item.message} · ${item.detail}` : item.message;
}

const SENSOR_ITEM_IDS = ["compass", "gyroscope", "accelerometer", "barometer", "level"];

function sensorTone(items: SetupStatusItem[]): SetupTone {
  return worstTone(SENSOR_ITEM_IDS.map((id) => itemTone(items, id)));
}

function capabilityTone(value?: string): SetupTone {
  if (!value || value === "Unavailable") return "unsupported";
  if (value === "Not configured") return "warn";
  return "good";
}

function capabilitiesTone(
  items: SetupStatusItem[],
  capabilities?: SetupSummaryData["capabilities"]
): SetupTone {
  return worstTone([
    itemTone(items, "esc"),
    itemTone(items, "logging"),
    capabilityTone(capabilities?.camera),
    capabilityTone(capabilities?.scripting),
  ]);
}

function gpsLabel(fix: number, satellites: number) {
  const labels: Record<number, string> = {
    0: "No GPS",
    1: "No Fix",
    2: "2D Fix",
    3: "3D Fix",
    4: "DGPS",
    5: "RTK Float",
    6: "RTK Fixed",
  };
  return satellites > 0 ? `${labels[fix] ?? "GPS"} · ${satellites} sats` : labels[fix] ?? "No GPS";
}

export default function SetupSummary({ summary, onNavigate }: Props) {
  const telemetry = useTelemetry();
  const { info: firmware, loading: firmwareLoading, refresh } = useFirmwareInfo(
    telemetry.connected
  );

  if (!telemetry.connected) {
    const lost = telemetry.disconnectReason != null;
    return (
      <div className="setup-page setup-summary-page" data-testid="setup-summary">
        <div className="setup-page-header">
          <h2 className="setup-page-title">Summary</h2>
          <p className="setup-page-subtitle">Vehicle preparation and configuration summary</p>
        </div>
        <div className="setup-disconnected" data-testid="setup-summary-disconnected">
          <WifiOff size={24} />
          <p className="setup-disconnected-title" data-testid="setup-summary-waiting-title">
            {lost ? "Vehicle connection lost" : "Waiting for vehicle"}
          </p>
          {lost && telemetry.disconnectReason && (
            <p className="setup-disconnected-reason" data-testid="setup-summary-reason">
              Reason: {telemetry.disconnectReason}
            </p>
          )}
          <p className="setup-disconnected-hint" data-testid="setup-summary-waiting-hint">
            Connect a Pixhawk or MAVLink vehicle to view vehicle settings.
          </p>
        </div>
      </div>
    );
  }

  const items = summary?.items ?? [];
  const frame = itemFor(items, "frame");
  const firmwareText = firmwareLoading
    ? "Loading..."
    : firmware?.success && firmware.version
      ? `${firmware.version}${firmware.custom ? ` (${firmware.custom})` : ""}`
      : firmware?.message ?? "Unavailable";
  const battery = telemetry.batteryVoltage > 0
    ? `${telemetry.batteryVoltage.toFixed(1)} V · ${telemetry.batteryRemaining}%`
    : "Unavailable";
  const syncText = summary?.sync.state === "complete"
    ? `${summary.sync.receivedCount}/${summary.sync.expectedCount}`
    : `${summary?.sync.receivedCount ?? 0}/${summary?.sync.expectedCount ?? 0}`;
  const flightModes = summary?.flightModes ?? [];
  const capability = (id: number) => flightModes.find((mode) => mode.slot === id)?.name ?? "Unavailable";

  return (
    <div className="setup-page setup-summary-page" data-testid="setup-summary">
      <div className="setup-page-header">
        <h2 className="setup-page-title">Summary</h2>
        <p className="setup-page-subtitle">Vehicle preparation and configuration summary</p>
      </div>

      <div className="setup-summary-grid" data-testid="setup-summary-grid">
        <Panel title="Airframe" tone={frame?.tone} testId="setup-vehicle-card">
          <Row label="System ID" value={`${telemetry.systemId} / ${telemetry.componentId}`} />
          <Row label="Airframe" value={frame?.message ?? "Unavailable"} />
          <Row label="Vehicle" value={telemetry.vehicleType || "Unknown"} />
          <Row label="Autopilot" value={telemetry.autopilot || "Unknown"} />
          <Row label="Firmware" value={<span data-testid="setup-firmware-version">{firmwareText}</span>} />
          <Row label="Mode" value={telemetry.mode || "Unknown"} />
          <Row label="State" value={telemetry.armed ? "ARMED" : "Disarmed"} />
          <div className="setup-summary-panel-actions">
            <button type="button" className="setup-summary-link" onClick={refresh} disabled={firmwareLoading} data-testid="setup-firmware-refresh">
              <RefreshCw size={12} /> Re-query
            </button>
            <button type="button" className="setup-summary-link" onClick={() => onNavigate("firmware")} data-testid="setup-firmware-card-link">
              Firmware page
            </button>
          </div>
        </Panel>

        <Panel title="Radio" tone={itemTone(items, "radio")} testId="setup-summary-radio">
          <Row label="Status" value={itemValue(items, "radio")} />
          <Row label="RC1" value={itemFor(items, "radio")?.detail ?? "Unavailable"} />
          <Row label="Signal" value={telemetry.rcSignal || "Unavailable"} />
          <Row label="Channels" value={telemetry.rcChannelCount || "Unavailable"} />
          <button type="button" className="setup-summary-panel-link" onClick={() => onNavigate("radio")}>Open Radio</button>
        </Panel>

        <Panel title="Sensors" tone={sensorTone(items)} testId="setup-summary-sensors">
          {[
            ["Compass", itemValue(items, "compass")],
            ["Gyro", itemValue(items, "gyroscope")],
            ["Accelerometer", itemValue(items, "accelerometer")],
            ["Barometer", itemValue(items, "barometer")],
            ["Level", itemValue(items, "level")],
          ].map(([label, value]) => <Row key={label} label={label} value={value} />)}
          <button type="button" className="setup-summary-panel-link" onClick={() => onNavigate("sensors")}>Open Sensors</button>
        </Panel>

        <Panel title="Flight Modes" tone={itemTone(items, "flightModes")} testId="setup-summary-modes">
          <Row label="Mode switch" value={itemFor(items, "flightModes")?.detail ?? "Unavailable"} />
          {[1, 2, 3, 4, 5, 6].map((n) => <Row key={n} label={`Flight Mode ${n}`} value={capability(n)} />)}
          <button type="button" className="setup-summary-panel-link" onClick={() => onNavigate("modes")}>Open Flight Modes</button>
        </Panel>

        <Panel title="Power" tone={itemTone(items, "power")} testId="setup-summary-power">
          <Row label="Battery" value={battery} />
          <Row label="GPS" value={gpsLabel(telemetry.gpsFix, telemetry.satellites)} />
          <Row label="Power status" value={itemValue(items, "power")} />
          <button type="button" className="setup-summary-panel-link" onClick={() => onNavigate("power")}>Open Power</button>
        </Panel>

        <Panel title="Safety" tone={itemTone(items, "safety")} testId="setup-summary-safety">
          <Row label="Status" value={itemValue(items, "safety")} />
          <Row label="Mode" value={telemetry.mode} />
          <Row label="Armed" value={telemetry.armed ? "ARMED" : "Disarmed"} />
          <Row label="Parameter sync" value={syncText} />
          <button type="button" className="setup-summary-panel-link" onClick={() => onNavigate("safety")}>Open Safety</button>
        </Panel>

        <Panel title="Capabilities" tone={capabilitiesTone(items, summary?.capabilities)} testId="setup-summary-capabilities">
          <Row label="Camera" value={summary?.capabilities?.camera ?? "Unavailable"} />
          <Row label="ESC" value={itemValue(items, "esc")} />
          <Row label="Logging" value={itemValue(items, "logging")} />
          <Row label="Scripting" value={summary?.capabilities?.scripting ?? "Unavailable"} />
        </Panel>
      </div>
    </div>
  );
}
