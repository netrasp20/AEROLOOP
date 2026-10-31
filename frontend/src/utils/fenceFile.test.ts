import { describe, it, expect, vi, afterEach } from "vitest";
import { parseFenceFile, downloadFenceFile } from "../utils/fenceFile";
import type { FencePoint } from "../api/fence";

const samplePoints: FencePoint[] = [
  { lat: 13.012, lng: 77.703, command: 5001, param1: 3 },
  { lat: 13.014, lng: 77.7035, command: 5001, param1: 3 },
  { lat: 13.013, lng: 77.706, command: 5001, param1: 3 },
];

describe("fenceFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a valid fence JSON file", () => {
    const json = JSON.stringify({ version: 1, timestamp: "2026-01-01", points: samplePoints });
    const points = parseFenceFile(json);
    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({ lat: 13.012, lng: 77.703, command: 5001, param1: 3 });
  });

  it("defaults missing command/param1 fields", () => {
    const json = JSON.stringify({ version: 1, points: [{ lat: 13, lng: 77 }] });
    const points = parseFenceFile(json);
    expect(points[0].command).toBe(5001);
    expect(points[0].param1).toBe(0);
    expect(points[0].param2).toBe(0);
  });

  it("coerces numeric string fields to numbers", () => {
    const json = JSON.stringify({ points: [{ lat: "13.5", lng: "77.1", command: "5003", param1: "50" }] });
    const points = parseFenceFile(json);
    expect(points[0]).toMatchObject({ lat: 13.5, lng: 77.1, command: 5003, param1: 50 });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseFenceFile("{not valid")).toThrow();
  });

  it("throws when points array is missing", () => {
    expect(() => parseFenceFile(JSON.stringify({ version: 1 }))).toThrow("missing points array");
  });

  it("triggers a download fallback with the fence JSON", () => {
    const create = vi.fn().mockReturnValue("blob:url");
    const click = vi.fn();
    const append = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
    vi.stubGlobal("Blob", class { });
    const anchor = { href: "", download: "", click, addEventListener: vi.fn() };
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { appendChild: append, removeChild: remove },
    });

    downloadFenceFile(samplePoints);
    expect(create).toHaveBeenCalledTimes(1);
    expect(anchor.download).toBe("fence.json");
    expect(click).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});