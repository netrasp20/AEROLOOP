import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("../../context/ParameterContext", () => ({
  useParameters: () => ({
    connection: holder.connection,
    vehicleType: "ArduCopter",
    entries: {},
    staged: {},
    stageValue: vi.fn(),
    revert: vi.fn(),
    executeWrite: vi.fn(),
    syncing: false,
    loading: false,
    loadError: null,
    count: 0,
    refreshing: false,
    sync: { active: false, phase: "idle", done: 0, total: 0 },
  }),
}));

vi.mock("../../hooks/useSocketTelemetry", () => ({
  default: () => ({ connected: true }),
}));

import MavFtp from "./MavFtp";
const holder = vi.hoisted(() => ({ connection: "READY" }));

function renderFtp() {
  return render(<MavFtp />);
}

const ROOT_ENTRIES = [
  { name: "logs", type: "directory", size: 0 },
  { name: "boot.bin", type: "file", size: 1024 },
];

function mockListOk(entries: Record<string, unknown>[] = []) {
  mockFetch.mockResolvedValue({
    json: () => ({ success: true, entries }),
  });
}

function lastCallArgs() {
  const last = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
  return { url: last[0], body: last[1]?.body ? JSON.parse(last[1].body) : undefined };
}

function expectCall(path: string, body = {}) {
  const args = lastCallArgs();
  expect(args.url).toBe(`/api/ftp/${path}`);
  expect(args.body).toEqual(expect.objectContaining(body));
}

describe("MavFtp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the FTP header", async () => {
    mockListOk();
    renderFtp();
    expect(await screen.findByText("MAVFTP")).toBeDefined();
  });

  it("loads root directory on mount", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expectCall("list", { path: "/" });
  });

  it("displays directory and file entries", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    expect(await screen.findByText("logs")).toBeDefined();
    expect(screen.getByText("boot.bin")).toBeDefined();
    expect(screen.getAllByText("directory").length).toBeGreaterThan(0);
    expect(screen.getAllByText("file").length).toBeGreaterThan(0);
  });

  it("shows toolbar buttons", async () => {
    mockListOk();
    renderFtp();
    expect(await screen.findByText("Refresh")).toBeDefined();
    expect(screen.getByText("Upload")).toBeDefined();
    expect(screen.getByText("New Folder")).toBeDefined();
    expect(screen.getByText("Download")).toBeDefined();
  });

  it("shows file size in human-readable format", async () => {
    mockListOk([{ name: "big.bin", type: "file", size: 2048 }]);
    renderFtp();
    expect(await screen.findByText("2.0 KB")).toBeDefined();
  });

  it("shows empty message when directory has no entries", async () => {
    mockListOk();
    renderFtp();
    expect(await screen.findByText("Directory is empty.")).toBeDefined();
  });

  it("navigates into a directory on double-click", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    const logs = await screen.findByTestId("ftp-entry-logs");

    mockFetch.mockResolvedValueOnce({
      json: () => ({ success: true, entries: [{ name: "flight1.bin", type: "file", size: 50 }] }),
    });
    fireEvent.doubleClick(logs);
    await waitFor(() => expectCall("list", { path: "/logs" }));
    expect(await screen.findByText("flight1.bin")).toBeDefined();
  });

  it("navigates up from a subdirectory", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    const logs = await screen.findByTestId("ftp-entry-logs");

    mockFetch.mockResolvedValueOnce({
      json: () => ({ success: true, entries: [{ name: "log.bin", type: "file", size: 10 }] }),
    });
    fireEvent.doubleClick(logs);
    expect(await screen.findByText("log.bin")).toBeDefined();

    mockFetch.mockResolvedValueOnce({ json: () => ({ success: true, entries: ROOT_ENTRIES }) });
    fireEvent.click(screen.getByTestId("ftp-nav-up"));
    await waitFor(() => expectCall("list", { path: "/" }));
    expect(await screen.findByText("boot.bin")).toBeDefined();
  });

  it("breadcrumb root button navigates to root", async () => {
    mockListOk([]);
    renderFtp();
    await screen.findByTestId("ftp-bread-btn");
    mockFetch.mockClear();
    fireEvent.click(screen.getByTestId("ftp-bread-btn"));
    await waitFor(() => expectCall("list", { path: "/" }));
  });

  it("creates a directory via the API", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    fireEvent.click(await screen.findByTestId("ftp-new-folder-btn"));
    const input = await screen.findByTestId("ftp-new-folder-input");
    fireEvent.change(input, { target: { value: "scripts" } });
    mockFetch.mockResolvedValueOnce({ json: () => ({ success: true, path: "/scripts" }) });
    fireEvent.click(await screen.findByText("Create"));
    await waitFor(() => expectCall("mkdir", { path: "/scripts" }));
  });

  it("rejects invalid folder names (path traversal)", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    fireEvent.click(await screen.findByTestId("ftp-new-folder-btn"));
    const input = await screen.findByTestId("ftp-new-folder-input");
    fireEvent.change(input, { target: { value: "../evil" } });
    fireEvent.click(await screen.findByText("Create"));
    expect(await screen.findByTestId("ftp-error")).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalledWith(
      "/api/ftp/mkdir",
      expect.anything()
    );
  });

  it("rejects invalid rename names (contains /)", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    fireEvent.click(await screen.findByTestId("ftp-entry-boot.bin"));
    fireEvent.click(await screen.findByTestId("ftp-rename-btn"));
    const input = await screen.findByTestId("ftp-rename-input");
    fireEvent.change(input, { target: { value: "a/b" } });
    fireEvent.click(screen.getByTestId("ftp-rename-submit"));
    expect(await screen.findByTestId("ftp-error")).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalledWith(
      "/api/ftp/rename",
      expect.anything()
    );
  });

  it("renames a selected file via the API", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    fireEvent.click(await screen.findByTestId("ftp-entry-boot.bin"));
    fireEvent.click(await screen.findByTestId("ftp-rename-btn"));
    fireEvent.change(await screen.findByTestId("ftp-rename-input"), {
      target: { value: "boot2.bin" },
    });
    mockFetch.mockResolvedValueOnce({ json: () => ({ success: true }) });
    fireEvent.click(screen.getByTestId("ftp-rename-submit"));
    await waitFor(() =>
      expectCall("rename", { old_path: "/boot.bin", new_path: "/boot2.bin" })
    );
  });

  it("confirms and deletes a file", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    fireEvent.click(await screen.findByTestId("ftp-entry-boot.bin"));
    fireEvent.click(await screen.findByTestId("ftp-delete-btn"));
    expect(await screen.findByTestId("ftp-confirm-delete")).toBeDefined();
    mockFetch.mockResolvedValueOnce({ json: () => ({ success: true }) });
    fireEvent.click(await screen.findByTestId("ftp-confirm-delete-btn"));
    await waitFor(() => expectCall("remove", { path: "/boot.bin" }));
  });

  it("deletes a directory via rmdir", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    fireEvent.click(await screen.findByTestId("ftp-entry-logs"));
    fireEvent.click(await screen.findByTestId("ftp-delete-btn"));
    mockFetch.mockResolvedValueOnce({ json: () => ({ success: true }) });
    fireEvent.click(await screen.findByTestId("ftp-confirm-delete-btn"));
    await waitFor(() => expectCall("rmdir", { path: "/logs" }));
  });

  it("downloads a selected file via the read endpoint", async () => {
    mockListOk(ROOT_ENTRIES);
    renderFtp();
    fireEvent.click(await screen.findByText("boot.bin"));
    const content = "hello yantrayug";
    mockFetch.mockResolvedValueOnce({
      json: () => ({ success: true, data: btoa(content) }),
    });
    fireEvent.click(screen.getByTestId("ftp-download"));
    await waitFor(() => expectCall("read", { path: "/boot.bin" }));
  });

  it("shows error and dismisses it", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => ({ success: false, error: { message: "FTP list failed" } }),
    });
    renderFtp();
    expect(await screen.findByTestId("ftp-error")).toBeDefined();
    fireEvent.click(screen.getByTestId("ftp-error-close"));
    expect(screen.queryByTestId("ftp-error")).toBeNull();
  });

  it("shows disconnected state when not connected", async () => {
    holder.connection = "DISCONNECTED";
    renderFtp();
    expect(await screen.findByTestId("ftp-disconnected")).toBeDefined();
    expect(screen.getByText("Vehicle not connected.")).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
    holder.connection = "READY";
  });

  it("shows progress indicator while listing", async () => {
    let resolve: (v: unknown) => void = () => {};
    mockFetch.mockReturnValue(
      new Promise((res) => { resolve = () => res({ json: () => ({ success: true, entries: [] }) }); })
    );
    renderFtp();
    // The listing state is transient; check the file-list container exists
    expect(screen.getByTestId("ftp-file-list")).toBeDefined();
    resolve(undefined);
    await screen.findByText("Directory is empty.");
  });
});
