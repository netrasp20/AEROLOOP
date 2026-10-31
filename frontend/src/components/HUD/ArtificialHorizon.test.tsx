import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import ArtificialHorizon from "./ArtificialHorizon";
import type { TelemetryData } from "../../providers/TelemetryProvider";

const { telemetry } = vi.hoisted(() => ({
  telemetry: {
    connected: true,
    connectionState: "CONNECTED",
    disconnectReason: null,
    systemId: 1,
    componentId: 1,
    vehicleType: "QUADROTOR",
    autopilot: "ARDUPILOTMEGA",
    mode: "STABILIZE",
    armed: false,
    latitude: 0,
    longitude: 0,
    altitude: 0,
    relativeAltitude: 0,
    homeLatitude: 0,
    homeLongitude: 0,
    homeAltitude: 0,
    groundSpeed: 0,
    airSpeed: 0,
    verticalSpeed: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    batteryVoltage: 0,
    batteryCurrent: 0,
    batteryRemaining: 0,
    gpsFix: 0,
    satellites: 0,
    hdop: 0,
    distance: 0,
    distanceToHome: 0,
    atHome: true,
    missionUploaded: false,
    missionCurrent: 0,
    missionReached: 0,
    missionRunning: false,
    missionCompleted: false,
    missionTotalDistance: 0,
    statusText: "",
    rcChannels: [],
    rcSignal: "UNKNOWN",
    rcChannelCount: 0,
    rcRssi: 0,
    rcReceivedAt: 0,
    timestamp: 0,
  } as TelemetryData,
}));

vi.mock("../../providers/TelemetryProvider", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useTelemetry: () => telemetry };
});

const CY = 150;
const PITCH_SCALE = 4;
const CX = 200;

function setAttitude(rollDeg: number, pitchDeg: number) {
  telemetry.roll = (rollDeg * Math.PI) / 180;
  telemetry.pitch = (pitchDeg * Math.PI) / 180;
}

function renderHorizon(rollDeg: number, pitchDeg: number) {
  setAttitude(rollDeg, pitchDeg);
  const { container, unmount } = render(<ArtificialHorizon />);
  const result = { container, unmount };
  return result;
}

function attitudeGroup(container: HTMLElement): SVGGElement {
  const group = container.querySelector<SVGGElement>(
    "g[clip-path] > g[transform]",
  );
  if (!group) throw new Error("attitude group not found");
  return group;
}

function layerRect(container: HTMLElement, fill: string): SVGRectElement {
  const rect = container.querySelector<SVGRectElement>(`rect[fill="${fill}"]`);
  if (!rect) throw new Error(`layer ${fill} not found`);
  return rect;
}

function pitchLabelY(container: HTMLElement, label: string): number {
  const texts = Array.from(container.querySelectorAll("text"));
  const match = texts.find((t) => t.textContent === label);
  if (!match) throw new Error(`pitch label ${label} not found`);
  return Number(match.getAttribute("y"));
}

function rotationFromTransform(transform: string): number {
  const match = transform.match(/rotate\((-?[\d.]+)/);
  if (!match) throw new Error(`no rotation in ${transform}`);
  return Number(match[1]);
}

describe("ArtificialHorizon — sky/ground geometry", () => {
  it("places sky above the horizon and ground below it at level attitude", () => {
    const { container, unmount } = renderHorizon(0, 0);

    const sky = layerRect(container, "url(#skyGrad)");
    const ground = layerRect(container, "url(#groundGrad)");

    const skyBottom = Number(sky.getAttribute("y")) + Number(sky.getAttribute("height"));
    const groundTop = Number(ground.getAttribute("y"));

    expect(skyBottom).toBe(CY);
    expect(groundTop).toBe(CY);
    expect(skyBottom).toBeLessThanOrEqual(groundTop);

    unmount();
  });

  it("keeps the horizon centred with no rotation or pitch offset at roll 0 pitch 0", () => {
    const { container, unmount } = renderHorizon(0, 0);

    expect(attitudeGroup(container).getAttribute("transform")).toBe(
      "translate(0 0) rotate(0 200 150)",
    );

    unmount();
  });
});

describe("ArtificialHorizon — pitch ladder direction", () => {
  it("renders positive pitch above the horizon and negative pitch below it", () => {
    const { container, unmount } = renderHorizon(0, 0);

    expect(pitchLabelY(container, "10")).toBeLessThan(CY);
    expect(pitchLabelY(container, "20")).toBeLessThan(CY);
    expect(pitchLabelY(container, "30")).toBeLessThan(CY);

    expect(pitchLabelY(container, "-10")).toBeGreaterThan(CY);
    expect(pitchLabelY(container, "-20")).toBeGreaterThan(CY);
    expect(pitchLabelY(container, "-30")).toBeGreaterThan(CY);

    unmount();
  });

  it("maps pitch to screen Y with the horizon moving down for nose-up pitch", () => {
    const up = renderHorizon(0, 10);
    expect(attitudeGroup(up.container).getAttribute("transform")).toBe(
      `translate(0 ${10 * PITCH_SCALE}) rotate(0 ${CX} ${CY})`,
    );
    up.unmount();

    const down = renderHorizon(0, -10);
    expect(attitudeGroup(down.container).getAttribute("transform")).toBe(
      `translate(0 ${-10 * PITCH_SCALE}) rotate(0 ${CX} ${CY})`,
    );
    down.unmount();
  });
});

describe("ArtificialHorizon — roll handling", () => {
  it("applies the incoming roll rotation to the attitude group", () => {
    const { container, unmount } = renderHorizon(30, 0);

    const transform = attitudeGroup(container).getAttribute("transform") ?? "";
    expect(transform).toContain("translate(0 0)");
    expect(rotationFromTransform(transform)).toBeCloseTo(30, 6);

    unmount();
  });

  it("rotates by 180 degrees when the vehicle reports an inverted roll", () => {
    const { container, unmount } = renderHorizon(180, 0);

    const transform = attitudeGroup(container).getAttribute("transform") ?? "";
    expect(transform).toMatch(/rotate\((-?180(\.\d+)?) 200 150\)/);

    unmount();
  });
});
