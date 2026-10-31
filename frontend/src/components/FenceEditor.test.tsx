import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import FenceEditor from "./FenceEditor";

const mockFenceApi = {
  uploadFence: vi.fn(),
  downloadFence: vi.fn(),
  clearFence: vi.fn(),
  verifyFence: vi.fn(),
};

vi.mock("../api/fence", () => ({
  uploadFence: (...args: unknown[]) => mockFenceApi.uploadFence(...args),
  downloadFence: (...args: unknown[]) => mockFenceApi.downloadFence(...args),
  clearFence: (...args: unknown[]) => mockFenceApi.clearFence(...args),
  verifyFence: (...args: unknown[]) => mockFenceApi.verifyFence(...args),
}));

vi.mock("../utils/fenceFile", () => ({
  downloadFenceFile: vi.fn(),
  loadFenceFile: vi.fn(),
}));

vi.mock("../hooks/useSocketTelemetry", () => ({
  default: () => ({
    mode: "STABILIZE",
    armed: false,
    vehicleType: "QUADROTOR",
    fenceBreachStatus: 1,
    fenceBreachCount: 2,
    fenceBreachType: 1,
  }),
}));

import * as fenceFile from "../utils/fenceFile";
import type { FencePoint } from "../api/fence";

const samplePoints: FencePoint[] = [
  { lat: 13.012, lng: 77.703, command: 5001, param1: 3 },
  { lat: 13.014, lng: 77.7035, command: 5001, param1: 3 },
  { lat: 13.013, lng: 77.706, command: 5001, param1: 3 },
];

describe("FenceEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFenceApi.downloadFence.mockResolvedValue({
      success: true,
      points: [],
      count: 0,
      message: "Downloaded 0 fence points.",
    });
    mockFenceApi.clearFence.mockResolvedValue({ success: true, message: "Cleared." });
  });

  it("renders header and actions", () => {
    render(<FenceEditor />);
    expect(screen.getByText("Fences", { selector: ".fence-header h3" })).toBeTruthy();
    expect(screen.getByTitle("Upload fence to vehicle")).toBeTruthy();
    expect(screen.getByTitle("Verify fence by uploading and downloading back")).toBeTruthy();
    expect(screen.getByTitle("Save fence to file")).toBeTruthy();
    expect(screen.getByTitle("Load fence from file")).toBeTruthy();
  });

  it("shows breach banner when fence is breached", () => {
    render(<FenceEditor />);
    const banner = screen.getByTestId("fence-breach");
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain("Boundary breach");
    expect(banner.textContent).toContain("2 triggered");
  });

  it("saves fence points to file", async () => {
    mockFenceApi.downloadFence.mockResolvedValue({
      success: true,
      points: samplePoints,
      count: 3,
      message: "Downloaded 3 fence points.",
    });
    render(<FenceEditor />);
    await screen.findByText(/Downloaded 3 fence points/);
    fireEvent.click(screen.getByTitle("Save fence to file"));
    expect(fenceFile.downloadFenceFile).toHaveBeenCalledWith(samplePoints);
  });

  it("loads fence points from a file", async () => {
    vi.mocked(fenceFile.loadFenceFile).mockResolvedValue([{ lat: 13.1, lng: 77.1, command: 5003, param1: 50 }]);
    render(<FenceEditor />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File([JSON.stringify({ points: [] })], "fence.json", { type: "application/json" });
    fireEvent.change(input!, { target: { files: [file] } });
    await screen.findByText(/Loaded 1 fence points from fence\.json/);
    expect(fenceFile.loadFenceFile).toHaveBeenCalledWith(file);
  });

  it("verifies fence points round-trip on vehicle", async () => {
    mockFenceApi.verifyFence.mockResolvedValue({
      success: true,
      count: 3,
      points: samplePoints,
      message: "Verified 3 fence points.",
    });
    mockFenceApi.downloadFence.mockResolvedValue({
      success: true,
      points: samplePoints,
      count: 3,
      message: "Downloaded 3 fence points.",
    });
    render(<FenceEditor />);
    await screen.findByText(/Downloaded 3 fence points/);
    fireEvent.click(screen.getByTitle("Verify fence by uploading and downloading back"));
    await screen.findByText(/Verified 3 fence points/);
    expect(mockFenceApi.verifyFence).toHaveBeenCalledWith(samplePoints);
  });
});