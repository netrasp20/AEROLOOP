import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TelemetryProvider,
  useTelemetry,
} from "./TelemetryProvider";

const { emitter } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    emitter: {
      on: (event: string, fn: (payload?: unknown) => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(fn);
      },
      off: (event: string, fn: (payload?: unknown) => void) => {
        handlers.get(event)?.delete(fn);
      },
      emit: (event: string, payload?: unknown) => {
        handlers.get(event)?.forEach((fn) => fn(payload));
      },
    },
  };
});

vi.mock("../socket/socket", () => ({ default: emitter }));

function Sink() {
  const t = useTelemetry();
  return (
    <div data-testid="sink">
      <span data-testid="connected">{String(t.connected)}</span>
      <span data-testid="connection-state">{t.connectionState ?? ""}</span>
      <span data-testid="reason">{t.disconnectReason ?? ""}</span>
      <span data-testid="mode">{t.mode}</span>
      <span data-testid="battery">{t.batteryVoltage.toFixed(2)}</span>
      <span data-testid="battery-pct">{t.batteryRemaining}</span>
      <span data-testid="gps-fix">{t.gpsFix}</span>
      <span data-testid="sats">{t.satellites}</span>
      <span data-testid="lat">{t.latitude.toFixed(3)}</span>
    </div>
  );
}

function renderSink() {
  return render(
    <TelemetryProvider>
      <Sink />
    </TelemetryProvider>
  );
}

function liveTelemetry() {
  return {
    connected: true,
    mode: "STABILIZE",
    armed: false,
    gpsFix: 3,
    satellites: 10,
    batteryVoltage: 16.4,
    batteryRemaining: 87,
    latitude: 12.345,
    longitude: 56.789,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TelemetryProvider — connection state", () => {
  it("starts fully disconnected with no stale readings", () => {
    renderSink();
    expect(screen.getByTestId("connected").textContent).toBe("false");
    expect(screen.getByTestId("connection-state").textContent).toBe("DISCONNECTED");
    expect(screen.getByTestId("battery").textContent).toBe("0.00");
    expect(screen.getByTestId("gps-fix").textContent).toBe("0");
  });

  it("applies live telemetry from telemetry:update", () => {
    renderSink();
    act(() => {
      emitter.emit("telemetry:update", liveTelemetry());
    });
    expect(screen.getByTestId("connected").textContent).toBe("true");
    expect(screen.getByTestId("battery").textContent).toBe("16.40");
    expect(screen.getByTestId("gps-fix").textContent).toBe("3");
  });

  it("CONNECTED event marks the vehicle connected and clears the reason", () => {
    renderSink();
    act(() => {
      emitter.emit("connection_state", { state: "DISCONNECTED", reason: "heartbeat_timeout" });
    });
    expect(screen.getByTestId("connected").textContent).toBe("false");
    expect(screen.getByTestId("reason").textContent).toBe("heartbeat_timeout");

    act(() => {
      emitter.emit("connection_state", { state: "CONNECTED" });
    });
    expect(screen.getByTestId("connected").textContent).toBe("true");
    expect(screen.getByTestId("connection-state").textContent).toBe("CONNECTED");
    expect(screen.getByTestId("reason").textContent).toBe("");
  });

  it("CONNECTING is surfaced without marking connected", () => {
    renderSink();
    act(() => {
      emitter.emit("connection_state", { state: "CONNECTING" });
    });
    expect(screen.getByTestId("connected").textContent).toBe("false");
    expect(screen.getByTestId("connection-state").textContent).toBe("CONNECTING");
  });

  it("DISCONNECTED zeroes stale gauges and keeps the reason", () => {
    renderSink();
    act(() => {
      emitter.emit("telemetry:update", liveTelemetry());
    });
    expect(screen.getByTestId("battery").textContent).toBe("16.40");

    act(() => {
      emitter.emit("connection_state", {
        state: "DISCONNECTED",
        reason: "heartbeat_timeout",
      });
    });
    expect(screen.getByTestId("connected").textContent).toBe("false");
    expect(screen.getByTestId("connection-state").textContent).toBe("DISCONNECTED");
    expect(screen.getByTestId("reason").textContent).toBe("heartbeat_timeout");
    expect(screen.getByTestId("battery").textContent).toBe("0.00");
    expect(screen.getByTestId("battery-pct").textContent).toBe("0");
    expect(screen.getByTestId("gps-fix").textContent).toBe("0");
    expect(screen.getByTestId("sats").textContent).toBe("0");
    expect(screen.getByTestId("lat").textContent).toBe("0.000");
    expect(screen.getByTestId("mode").textContent).toBe("DISCONNECTED");
  });

  it("reconnects cleanly after a loss round-trip", () => {
    renderSink();
    act(() => {
      emitter.emit("telemetry:update", liveTelemetry());
    });
    act(() => {
      emitter.emit("connection_state", { state: "DISCONNECTED", reason: "heartbeat_timeout" });
    });
    expect(screen.getByTestId("connected").textContent).toBe("false");

    act(() => {
      emitter.emit("connection_state", { state: "CONNECTED", reason: "reconnected" });
    });
    act(() => {
      emitter.emit("telemetry:update", {
        connected: true,
        mode: "GUIDED",
        gpsFix: 3,
        satellites: 12,
        batteryVoltage: 16.4,
        batteryRemaining: 85,
        latitude: 12.345,
        longitude: 56.789,
      });
    });
    expect(screen.getByTestId("connected").textContent).toBe("true");
    expect(screen.getByTestId("mode").textContent).toBe("GUIDED");
    expect(screen.getByTestId("battery").textContent).toBe("16.40");
    expect(screen.getByTestId("sats").textContent).toBe("12");
    expect(screen.getByTestId("reason").textContent).toBe("");
  });

  it("vehicleStatus with connected:false is a stale-gauge fallback", () => {
    renderSink();
    act(() => {
      emitter.emit("telemetry:update", liveTelemetry());
    });
    act(() => {
      emitter.emit("vehicleStatus", {
        connected: false,
        mode: "DISCONNECTED",
        armed: false,
      });
    });
    expect(screen.getByTestId("connected").textContent).toBe("false");
    expect(screen.getByTestId("battery").textContent).toBe("0.00");
    expect(screen.getByTestId("gps-fix").textContent).toBe("0");
    expect(screen.getByTestId("mode").textContent).toBe("DISCONNECTED");
  });
});