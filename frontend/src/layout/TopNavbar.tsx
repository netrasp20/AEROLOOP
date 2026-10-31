import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Dispatch,
  SetStateAction,
  ChangeEvent,
  MouseEvent,
} from "react";
import type { ActivePage } from "../pages/MissionPlanner";

import {
  Database,
  Route,
  Settings,
  Cpu,
  Radio,
  Plug,
  RefreshCw,
  Heart,
  HeartOff,
} from "lucide-react";

import { useTelemetry } from "../providers/TelemetryProvider";
import { useOperatorLocation } from "../context/OperatorLocationContext";

import {
  connectVehicle,
  disconnectVehicle,
  changeMode,
  getVehicleStatus,
  getSerialPorts,
} from "../api/vehicle";



import "../styles/navbar.css";

type SerialPort = {
  label: string;
  manufacturer: string;
};

type Props = {
  page: ActivePage;
  setPage: Dispatch<SetStateAction<ActivePage>>;
};

const menuItems = [
  {
    name: "DATA" as ActivePage,
    icon: <Database size={18} />,
  },
  {
    name: "PLAN" as ActivePage,
    icon: <Route size={18} />,
  },
  {
    name: "SETUP" as ActivePage,
    icon: <Settings size={18} />,
  },
  {
    name: "CONFIG" as ActivePage,
    icon: <Cpu size={18} />,
  },
];

function TopNavbar({
  page,
  setPage,
}: Props) {
  const telemetry = useTelemetry();
  const operator = useOperatorLocation();

  const operatorStatus = operator.loading
    ? { label: "Operator GPS...", color: "#f59e0b" }
    : operator.error && operator.latitude === null
    ? { label: "No Operator GPS", color: "#ef4444" }
    : operator.isFallback
    ? { label: "Operator GPS Active (fixed)", color: "#f59e0b" }
    : { label: "Operator GPS Active", color: "#22c55e" };

  const [connecting, setConnecting] =
    useState(false);

  const [currentMode, setCurrentMode] =
    useState("DISCONNECTED");

  // Sliding active-tab indicator
  const menuRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{
    left: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    function updateIndicator() {
      const nav = menuRef.current;

      if (!nav) return;

      const btn =
        nav.querySelector<HTMLButtonElement>(
          ".nav-item.active"
        );

      if (!btn) return;

      setIndicator({
        left: btn.offsetLeft + 12,
        width: btn.offsetWidth - 24,
      });
    }

    updateIndicator();

    window.addEventListener(
      "resize",
      updateIndicator
    );

    return () =>
      window.removeEventListener(
        "resize",
        updateIndicator
      );
  }, [page]);

  // Derive connected state from telemetry
  const connected = telemetry.connected;

  // Authoritative header connection state (QGC-style single source of truth,
  // derived from the backend connection_state events — never a frontend timer):
  //   CONNECTED / CONNECTING... / MAVLink CONNECTION LOST / NO VEHICLE
  const connState = telemetry.connectionState ?? "DISCONNECTED";
  const headerState =
    connState === "CONNECTED"
      ? "connected"
      : connState === "CONNECTING"
      ? "connecting"
      : telemetry.disconnectReason
      ? "lost"
      : "no-vehicle";
  const headerStateLabel =
    headerState === "connected"
      ? "CONNECTED"
      : headerState === "connecting"
      ? "CONNECTING..."
      : headerState === "lost"
      ? "MAVLink CONNECTION LOST"
      : "NO VEHICLE";

  // Connection Type
  const [connectionType, setConnectionType] =
    useState<"tcp" | "udp" | "serial">("udp");

  // Host & Port
  // Bind to 0.0.0.0 so the backend listens on all interfaces (ethernet H12 Pro
  // and localhost SITL) instead of loopback-only 127.0.0.1.
  const [udpHost, setUdpHost] =
    useState("0.0.0.0");

  const [selectedPort, setSelectedPort] =
    useState("14550");

  useEffect(() => {
    setSelectedPort(connectionType === "udp" ? "14550" : "5760");
  }, [connectionType]);

  // Serial
  const [serialPort, setSerialPort] =
    useState("COM3");

  const [baudRate, setBaudRate] =
    useState(115200);

  // Available COM Ports
  const [
    availablePorts,
    setAvailablePorts,
  ] = useState<SerialPort[]>([]);

  // -------------------------
  // Load Serial Ports
  // -------------------------
  const loadSerialPorts = useCallback(async () => {
    try {
      const res = await getSerialPorts();

      if (!res.success) return;

      const mappedPorts: SerialPort[] =
        res.ports.map(
          (port: {
            label: string;
            manufacturer: string;
          }) => ({
            label: port.label,
            manufacturer:
              port.manufacturer ?? "",
          })
        );

      // Only re-render when the detected set actually changed,
      // so the dropdown never flickers while polling.
      setAvailablePorts((prev) => {
        const same =
          prev.length ===
            mappedPorts.length &&
          prev.every(
            (p, i) =>
              p.label ===
              mappedPorts[i].label
          );
        return same ? prev : mappedPorts;
      });

      // Keep the selected COM label valid. Auto-select the first
      // detected port (COM3) when the current selection is stale.
      setSerialPort((prev) =>
        mappedPorts.length > 0 &&
        mappedPorts.some((p) => p.label === prev)
          ? prev
          : mappedPorts.length > 0
          ? mappedPorts[0].label
          : "COM3"
      );
    } catch (err) {
      console.error(err);
    }
  }, []);

  // -------------------------
  // Auto-refresh serial ports
  // -------------------------
  // While the Serial transport is selected, re-scan every 2s so plugging
  // in (or unplugging) the Pixhawk updates the COM3 dropdown without a
  // page reload. Polling stops while connected.
  useEffect(() => {
    if (connectionType !== "serial" || connected) {
      return;
    }

    loadSerialPorts();

    const poll = window.setInterval(
      loadSerialPorts,
      2000
    );

    return () => window.clearInterval(poll);
  }, [connectionType, connected, loadSerialPorts]);

  // -------------------------
  // Load Vehicle Status
  // -------------------------
  useEffect(() => {
    async function loadStatus() {
      try {
        const status =
          await getVehicleStatus();
        setCurrentMode(status.mode);
      } catch (err) {
        console.error(err);
      }
    }

    loadStatus();
  }, []);

  // Sync mode from telemetry whenever it updates
  useEffect(() => {
    if (telemetry.mode && telemetry.mode !== "DISCONNECTED") {
      setCurrentMode(telemetry.mode);
    }
  }, [telemetry.mode]);

  // -------------------------
  // Ripple Effect
  // -------------------------
  function spawnRipple(
    e: MouseEvent<HTMLButtonElement>
  ) {
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const size =
      Math.max(rect.width, rect.height) * 2;
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }

  // -------------------------
  // Connect / Disconnect
  // -------------------------
  async function handleConnect() {
    if (connected) {
      await disconnectVehicle();
      return;
    }

    if (
      connectionType === "serial" &&
      (availablePorts.length === 0 ||
        !availablePorts.some(
          (p) => p.label === serialPort
        ))
    ) {
      alert(
        "Pixhawk not detected. Plug the Pixhawk into a USB port and click the refresh button next to the port dropdown."
      );
      return;
    }

    setConnecting(true);

    try {
      let res;

      if (connectionType === "tcp") {
        res =
          await connectVehicle({
            connectionType:
              "tcp",
            host: udpHost,
            port: Number(selectedPort),
          });
      } else if (connectionType === "udp") {
        res =
          await connectVehicle({
            connectionType:
              "udp",
            host: udpHost,
            port: Number(selectedPort),
          });
      } else {
        res =
          await connectVehicle({
            connectionType:
              "serial",
            device: serialPort,
            baudRate,
          });
      }

      if (!res.success) {
        alert(
          res.message || "Connection Failed"
        );
        return;
      }
    } catch (err) {
      console.error(err);
      alert("Connection Failed");
    } finally {
      setConnecting(false);
    }
  }

  // -------------------------
  // Mode Change
  // -------------------------
  async function handleModeChange(
    e: ChangeEvent<HTMLSelectElement>
  ) {
    const mode = e.target.value;

    try {
      const res =
        await changeMode(mode);

      if (res.success) {
        setCurrentMode(mode);
      }
    } catch (err) {
      console.error(err);
    }
  }
  return (
  <header className="navbar">
    <div className="navbar-left">
      <div className="logo-box">
        <div className="logo-icon">
          <span>Y</span>
        </div>

        <div className="logo-text">
          <h2>YANTRAYUG</h2>
          <span>GROUND CONTROL STATION</span>
        </div>
      </div>

      <nav className="navbar-menu" ref={menuRef}>
        {menuItems.map((item) => (
          <button
            key={item.name}
            className={`nav-item ${
              page === item.name ? "active" : ""
            }`}
            onClick={() => setPage(item.name)}
          >
            {item.icon}
            <span>{item.name}</span>
          </button>
        ))}

        <div
          className="nav-indicator"
          style={
            indicator
              ? {
                  left: indicator.left,
                  width: indicator.width,
                }
              : { opacity: 0 }
          }
        />
      </nav>
    </div>

    <div className="navbar-right">
      <div
        className={`telemetry-icon ${
          connected ? "alive" : ""
        }`}
      >
        <Radio size={16} />
      </div>

      {/* Flight Mode */}
      <div className="dropdown-wrap">
        <select
          className="dropdown-button"
          value={currentMode}
          onChange={handleModeChange}
          disabled={!connected}
        >
          <option value="MANUAL">MANUAL</option>
          <option value="GUIDED">GUIDED</option>
          <option value="AUTO">AUTO</option>
          <option value="HOLD">HOLD</option>
          <option value="RTL">RTL</option>
        </select>
        <span className="caret" />
      </div>

      {/* Connection Type */}
      <select
        className="dropdown-button"
        value={connectionType}
        disabled={connected}
        onChange={(e) =>
          setConnectionType(
            e.target.value as "tcp" | "udp" | "serial"
          )
        }
      >
        <option value="tcp">TCP</option>
        <option value="udp">UDP</option>
        <option value="serial">Serial</option>
      </select>

      {/* TCP / UDP */}
      {(connectionType === "tcp" || connectionType === "udp") && (
        <>
          <input
            className="dropdown-button port-input"
            type="text"
            value={udpHost}
            disabled={connected}
            onChange={(e) =>
              setUdpHost(e.target.value)
            }
            placeholder="0.0.0.0"
            title="UDP Host"
            style={{ width: "120px" }}
          />
          <span style={{ color: "#94A3B8" }}>:</span>
          <input
            className="dropdown-button port-input"
            list="udpPorts"
            type="text"
            value={selectedPort}
            disabled={connected}
            onChange={(e) => {
              const value = e.target.value;

              if (/^\d*$/.test(value)) {
                setSelectedPort(value);
              }
            }}
            placeholder="14550"
            title="UDP Port"
            style={{ width: "80px" }}
          />

          <datalist id="udpPorts">
            <option value="14550" />
            <option value="14551" />
          </datalist>
        </>
      )}

      {/* SERIAL */}
      {connectionType === "serial" && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <select
              className="dropdown-button"
              value={serialPort}
              disabled={connected}
              onChange={(e) =>
                setSerialPort(e.target.value)
              }
            >
              {availablePorts.length === 0 ? (
                <option value="" disabled>
                  Pixhawk not detected
                </option>
              ) : (
                availablePorts.map((port) => (
                  <option
                    key={port.label}
                    value={port.label}
                  >
                    {port.label}
                  </option>
                ))
              )}
            </select>

            <button
              onClick={loadSerialPorts}
              disabled={connected}
              title="Refresh COM Ports"
              style={{
                height: "36px",
                width: "36px",
                borderRadius: "8px",
                border: "1px solid #7C3AED",
                background: "#151C2D",
                color: "white",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <RefreshCw size={16} />
            </button>
          </div>

          <select
            className="dropdown-button"
            value={baudRate}
            disabled={connected}
            onChange={(e) =>
              setBaudRate(Number(e.target.value))
            }
          >
            <option value={57600}>
              57600
            </option>
            <option value={115200}>
              115200
            </option>
          </select>
        </>
      )}

      {/* Connect */}
      <button
        className="connect-button"
        onClick={(e) => {
          spawnRipple(e);
          handleConnect();
        }}
        disabled={connecting}
        style={{
          background: connecting
            ? "#f59e0b"
            : connected
            ? `${telemetry.armed ? "#dc2626" : "#7c3aed"}`
            : "#2563eb",
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}
      >
        {connecting
          ? <><RefreshCw size={16} className="spin-icon" /> CONNECTING...</>
          : connected
          ? <><Plug size={16} /> {telemetry.armed ? "DISCONNECT (ARMED)" : "DISCONNECT"}</>
          : <><Plug size={16} /> CONNECT</>}
      </button>

      {/* Operator GPS indicator */}
      <div
        className="heartbeat-indicator"
        style={{ background: operatorStatus.color }}
        title={operatorStatus.label}
      >
        <Radio size={14} />
      </div>

      {/* Heartbeat indicator */}
      <div
        className={`heartbeat-indicator ${connected ? "alive" : "dead"}`}
        data-testid="heartbeat-indicator"
        title={
          connected
            ? `Heartbeat OK — ${telemetry.mode}`
            : telemetry.disconnectReason
              ? `Connection lost — ${telemetry.disconnectReason}`
              : "No Heartbeat"
        }
      >
        {connected
          ? <Heart size={14} />
          : <HeartOff size={14} />}
      </div>

      <span
        className={`connection-state-chip connection-state-${headerState}`}
        data-testid="connection-state-chip"
        data-state={headerState}
        title={
          headerState === "lost" && telemetry.disconnectReason
            ? `Connection lost — ${telemetry.disconnectReason}`
            : undefined
        }
      >
        {headerStateLabel}
      </span>
    </div>
  </header>
);

}

export default TopNavbar;