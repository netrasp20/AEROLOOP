import { AlertCircle, AlertTriangle, Loader, RefreshCw, WifiOff } from "lucide-react";
import type { ActuatorSetupState } from "../../api/setup";

interface Snapshot {
  success: boolean;
  supported: boolean;
  unsupportedReason?: string;
  state: ActuatorSetupState;
}

interface Props {
  page: string;
  icon: React.ReactNode;
  subtitle: string;
  connected: boolean;
  connectionState: string;
  disconnectReason: string | null;
  connectionLost: boolean;
  snapshot: Snapshot | null;
  onRefresh: () => Promise<void>;
  children: React.ReactNode;
  /** Extra class on the page root. Defaults keep Servo/ESC markup unchanged. */
  pageClassName?: string;
  /** Visible heading override. `page` still drives the id and messages. */
  title?: string;
}

export default function SetupReadOnlyState(props: Props) {
  const id = props.page.toLowerCase().replaceAll(" ", "-");
  const connecting = props.connectionState === "CONNECTING";
  const lost = !props.connected && !connecting && props.disconnectReason != null;

  const shell = (content: React.ReactNode) => (
    <div
      className={`setup-page actuator-page${props.pageClassName ? ` ${props.pageClassName}` : ""}`}
      data-testid={`setup-${id}`}
    >
      <div className="setup-page-header">
        <h2 className="setup-page-title actuator-page-title">{props.icon}{props.title ?? props.page}</h2>
        <p className="setup-page-subtitle">{props.subtitle}</p>
      </div>
      {content}
    </div>
  );

  if (!props.connected) {
    return shell(
      <div className="setup-disconnected" data-testid={`setup-${id}-${connecting ? "connecting" : lost ? "lost" : "waiting"}`}>
        {connecting ? <Loader size={26} className="setup-spinner" /> : <WifiOff size={26} />}
        <p className="setup-disconnected-title">{connecting ? "Connecting..." : lost ? "MAVLink connection lost" : "Waiting for vehicle"}</p>
        <p className="setup-disconnected-hint">
          {connecting ? "Establishing a MAVLink link with the flight controller." : lost ? `Reason: ${props.disconnectReason}` : "Connect a MAVLink vehicle to inspect actual output data."}
        </p>
        {props.connectionLost && <p className="setup-note">The previous snapshot was cleared and will be fetched again after reconnect.</p>}
      </div>,
    );
  }

  if (!props.snapshot || props.snapshot.state === "SYNCING" || props.snapshot.state === "CONNECTING" || props.snapshot.state === "WAITING") {
    return shell(<section className="setup-card"><div className="setup-fw-loading" data-testid={`setup-${id}-syncing`}><Loader size={18} className="setup-spinner" />Synchronizing actual vehicle data...</div></section>);
  }

  if (!props.snapshot.supported || props.snapshot.state === "UNSUPPORTED") {
    return shell(<section className="setup-card" data-testid={`setup-${id}-unsupported`}><div className="setup-fw-error"><AlertTriangle size={18} /><div><p className="setup-fw-error-title">Unsupported vehicle or firmware</p><p>{props.snapshot.unsupportedReason ?? `${props.page} data is not supported by the connected vehicle.`}</p></div></div></section>);
  }

  if (!props.snapshot.success || props.snapshot.state === "ERROR") {
    return shell(<section className="setup-card" data-testid={`setup-${id}-error`}><div className="setup-fw-error"><AlertCircle size={18} />Actual vehicle data could not be retrieved.</div><button type="button" className="setup-refresh-btn" onClick={props.onRefresh}><RefreshCw size={13} />Retry</button></section>);
  }

  return shell(<>{props.children}<button type="button" className="setup-refresh-btn" onClick={props.onRefresh} data-testid={`setup-${id}-refresh`}><RefreshCw size={13} />Refresh data</button></>);
}
