import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Video, VideoOff, Camera, Thermometer, Settings, Minimize2 } from "lucide-react";
import LeftSidebar from "../layout/LeftSidebar";
import MapPanel from "../layout/MapPanel";
import CameraViewPanel from "../components/CameraViewPanel";
import CameraGrid from "../components/CameraGrid";
import CameraConfigDialog from "../components/CameraConfigDialog";
import BottomRecControl from "../components/BottomRecControl";
import { useCameraContext } from "../context/CameraContext";

import "../styles/mission.css";

const SIDEBAR_DEFAULT_WIDTH = 360;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MIN_MAP = 380;
const SIDEBAR_HANDLE = 8;
const SIDEBAR_STORAGE_KEY = "yantrayug.data.sidebarWidth";

function clampSidebarWidth(width: number): number {
  const viewport = typeof window !== "undefined" ? window.innerWidth : 1600;
  const max = Math.max(SIDEBAR_MIN_WIDTH, viewport - SIDEBAR_MIN_MAP - SIDEBAR_HANDLE);
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), max));
}

function loadSidebarWidth(): number {
  const fallback = clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (raw != null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) return clampSidebarWidth(parsed);
    }
  } catch {
    /* ignore storage errors */
  }
  return fallback;
}

type SlotContent =
  | { type: "map" }
  | { type: "camera"; id: string }
  | { type: "camera-empty"; cameraType: "live" | "thermal" };

interface Viewport {
  main: SlotContent;
  preview1: SlotContent;
  preview2: SlotContent;
}

function DataPage() {
  const { cameras, streams, whepUrls, disconnectAll, disconnectCamera, connectCamera, addCamera, connecting, recording, recordingDuration, toggleRecording, pendingRecording, requestSaveAs } = useCameraContext();
  const [viewport, setViewport] = useState<Viewport>({
    main: { type: "map" },
    preview1: { type: "camera-empty", cameraType: "live" },
    preview2: { type: "camera-empty", cameraType: "thermal" },
  });
  const [gridView, setGridView] = useState(false);
  const [configuring, setConfiguring] = useState<"live" | "thermal" | null>(null);

  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSidebarWidth);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const sidebarDrag = useRef({ startX: 0, startWidth: 0 });
  const sidebarWidthRef = useRef(sidebarWidth);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    if (sidebarResizing) {
      document.body.classList.add("sidebar-resizing");
      return () => {
        document.body.classList.remove("sidebar-resizing");
      };
    }
    return undefined;
  }, [sidebarResizing]);

  useEffect(() => {
    const onViewportResize = () => {
      setSidebarWidth((prev) => clampSidebarWidth(prev));
    };
    window.addEventListener("resize", onViewportResize);
    return () => window.removeEventListener("resize", onViewportResize);
  }, []);

  const onResizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    sidebarDrag.current = { startX: e.clientX, startWidth: sidebarWidthRef.current };
    setSidebarResizing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!sidebarResizing) return;
    const { startX, startWidth } = sidebarDrag.current;
    const next = clampSidebarWidth(startWidth + (e.clientX - startX));
    sidebarWidthRef.current = next;
    setSidebarWidth(next);
  }, [sidebarResizing]);

  const onResizeEnd = useCallback(() => {
    if (!sidebarResizing) return;
    setSidebarResizing(false);
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidthRef.current));
    } catch {
      /* ignore storage errors */
    }
  }, [sidebarResizing]);

  const liveCam = useMemo(() => cameras.find((c) => c.type === "live") ?? null, [cameras]);
  const thermalCam = useMemo(() => cameras.find((c) => c.type === "thermal") ?? null, [cameras]);

  /* A preview slot holds the map when its own content (camera or empty box) is
     currently in the main area; otherwise it holds its camera or an empty box. */
  const derivePreview = useCallback((slot: "preview1" | "preview2", main: SlotContent): SlotContent => {
    const type = slot === "preview1" ? "live" : "thermal";
    const cam = type === "live" ? liveCam : thermalCam;
    const inMain =
      main.type === "camera"
        ? main.id === cam?.id
        : main.type === "camera-empty" && main.cameraType === type;
    if (inMain) return { type: "map" };
    if (cam) return { type: "camera", id: cam.id };
    return { type: "camera-empty", cameraType: type };
  }, [liveCam, thermalCam]);

  const effectiveViewport = useMemo(() => {
    let main: SlotContent = viewport.main;
    if (main.type === "camera") {
      const mainId = main.id;
      const cam = cameras.find((c) => c.id === mainId);
      if (!cam) main = { type: "map" };
    }
    return {
      main,
      preview1: derivePreview("preview1", main),
      preview2: derivePreview("preview2", main),
    };
  }, [viewport.main, cameras, derivePreview]);

  const handleSwap = useCallback((slot: "preview1" | "preview2") => {
    setViewport((prev) => {
      const clicked = derivePreview(slot, prev.main);
      const next: Viewport = {
        main: { type: "map" },
        preview1: prev.preview1,
        preview2: prev.preview2,
      };

      if (clicked.type === "camera") {
        const cam = cameras.find((c) => c.id === clicked.id);
        if (!cam) return prev;
        next.main = { type: "camera", id: cam.id };
        next[slot] = { type: "map" };
        return next;
      }

      if (clicked.type === "camera-empty") {
        next.main = { type: "camera-empty", cameraType: clicked.cameraType };
        next[slot] = { type: "map" };
        return next;
      }

      const prevMain = prev.main;
      if (prevMain.type === "camera") {
        const cam = cameras.find((c) => c.id === prevMain.id);
        if (cam) {
          const destSlot: "preview1" | "preview2" = cam.type === "live" ? "preview1" : "preview2";
          next[destSlot] = { type: "camera", id: cam.id };
        }
      } else if (prevMain.type === "camera-empty") {
        const destSlot: "preview1" | "preview2" = prevMain.cameraType === "live" ? "preview1" : "preview2";
        next[destSlot] = { type: "camera-empty", cameraType: prevMain.cameraType };
      }
      return next;
    });
    setGridView(false);
  }, [cameras, derivePreview]);

  const handleDisconnectAll = useCallback(async () => {
    await disconnectAll();
  }, [disconnectAll]);

  const handleRefresh = useCallback((id: string) => {
    disconnectCamera(id).then(() => connectCamera(id));
  }, [disconnectCamera, connectCamera]);

  const handleConfigureConnect = useCallback(async (url: string) => {
    if (!configuring) return false;
    const id = configuring === "live" ? "cam-live" : "cam-thermal";
    const name = configuring === "live" ? "Live Camera" : "Thermal Camera";
    addCamera({ id, name, url, type: configuring });
    const res = await connectCamera(id, url);
    return res.success === true;
  }, [configuring, addCamera, connectCamera]);

  const handleMainClick = useCallback(() => {
    setViewport((prev) => {
      const main = prev.main;
      const next: Viewport = {
        main: { type: "map" },
        preview1: prev.preview1,
        preview2: prev.preview2,
      };

      if (main.type === "camera") {
        const cam = cameras.find((c) => c.id === main.id);
        if (!cam) return prev;
        const destSlot: "preview1" | "preview2" = cam.type === "live" ? "preview1" : "preview2";
        next[destSlot] = { type: "camera", id: cam.id };
        return next;
      }

      if (main.type === "camera-empty") {
        const destSlot: "preview1" | "preview2" = main.cameraType === "live" ? "preview1" : "preview2";
        next[destSlot] = { type: "camera-empty", cameraType: main.cameraType };
        return next;
      }

      return prev;
    });
  }, [cameras]);

  const hasAnyCam = cameras.length > 0;

  const mainSlot = effectiveViewport.main;
  const mainCamera = mainSlot.type === "camera"
    ? cameras.find((c) => c.id === mainSlot.id) ?? null
    : null;

  const viewTitle = mainCamera
    ? mainCamera.name
    : mainSlot.type === "camera-empty"
    ? `${mainSlot.cameraType === "live" ? "Live" : "Thermal"} Camera`
    : gridView
    ? "All Cameras"
    : "Satellite Map";

  const renderPreview = (slot: "preview1" | "preview2") => {
    const content = slot === "preview1" ? effectiveViewport.preview1 : effectiveViewport.preview2;
    const slotType = slot === "preview1" ? "live" : "thermal";

    const anchor = slot === "preview1" ? "bottomleft" : "bottomright";

    if (content.type === "camera") {
      const cam = cameras.find((c) => c.id === content.id) ?? null;
      if (cam) {
        return (
          <CameraViewPanel
            key={`camera-${cam.id}`}
            camera={cam}
            streamUrl={streams[cam.id] ?? null}
            whepUrl={whepUrls[cam.id] ?? null}
            onActivate={() => handleSwap(slot)}
            isActive={false}
            anchor={anchor}
            onRefresh={() => handleRefresh(cam.id)}
            onRetry={() => handleRefresh(cam.id)}
            onConfigure={() => setConfiguring(cam.type === "thermal" ? "thermal" : "live")}
            connecting={connecting[cam.id]}
            recording={recording[cam.id]}
            recordingDuration={recordingDuration[cam.id]}
            onToggleRecording={() => toggleRecording(cam.id)}
            pendingRecording={!!pendingRecording[cam.id]}
            onSavePendingRecording={() => requestSaveAs(cam.id)}
          />
        );
      }
    }

    const iconBig = slotType === "live" ? <Camera size={24} /> : <Thermometer size={24} />;
    const label = slotType === "live" ? "Live Camera" : "Thermal Camera";

    if (content.type === "camera-empty") {
      return (
        <div
          className="preview-map"
          style={{ [anchor === "bottomleft" ? "left" : "right"]: 16, [anchor]: 16, borderStyle: "dashed", background: "#0a0a14", backdropFilter: "none", cursor: "pointer" }}
          onClick={() => handleSwap(slot)}
        >
          <div className="dock-panel-header">
            <div className="dock-panel-preview-badge">ADD</div>
            <div className="dock-panel-title">
              <span className="dock-panel-icon">{iconBig}</span>
              <span>{label}</span>
            </div>
            <button
              className="dock-panel-btn camera-settings-btn"
              onClick={(e) => {
                e.stopPropagation();
                setConfiguring(slotType);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title="Camera Settings"
            >
              <Settings size={14} />
            </button>
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
            {iconBig}
            <span style={{ fontSize: 14, fontWeight: 600, color: "#6b7280" }}>{label}</span>
            <span style={{ fontSize: 11, color: "#4b5563" }}>No camera configured</span>
          </div>
        </div>
      );
    }

    return (
      <div
        className="preview-map preview-map-live"
        style={{ [anchor === "bottomleft" ? "left" : "right"]: 16, [anchor]: 16, background: "#0a0a14", backdropFilter: "none", cursor: "pointer" }}
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t.closest(".leaflet-control, .leaflet-interactive, .leaflet-popup, a")) return;
          handleSwap(slot);
        }}
      >
        <MapPanel page="DATA" />
        <button
          className="preview-map-expand"
          title="Click to restore map to main area"
          onClick={(e) => {
            e.stopPropagation();
            handleSwap(slot);
          }}
        >
          <Minimize2 size={12} /> Restore
        </button>
      </div>
    );
  };

  return (
    <div className="dashboard-layout">
      <LeftSidebar width={sidebarWidth} />
      <div
        className={`sidebar-resizer${sidebarResizing ? " resizing" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize data panel"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
      />
      <div className="data-main">
        <div className="view-main" key="main-view">
          {effectiveViewport.main.type === "map" && !gridView && <MapPanel page="DATA" />}
          {gridView && (
            <CameraGrid onSelectCamera={(id) => {
              setGridView(false);
              setViewport((prev) => ({ ...prev, main: { type: "camera", id } }));
            }} />
          )}
          {effectiveViewport.main.type === "camera-empty" && !gridView && (
            <div className="camera-full" onClick={handleMainClick}>
              <div className="camera-full-badge">
                ● {effectiveViewport.main.cameraType === "live" ? "Live Camera" : "Thermal Camera"}
              </div>
              <div className="camera-full-text">No camera configured</div>
              <button
                className="camera-full-restore"
                title="Click to return to camera panel"
                onClick={(e) => {
                  e.stopPropagation();
                  handleMainClick();
                }}
              >
                <Minimize2 size={12} /> Restore
              </button>
            </div>
          )}
          {mainCamera && (
            <div className="camera-full" onClick={handleMainClick}>
              <div className={`camera-full-badge ${streams[mainCamera.id] ? "connected" : ""}`}>
                ● {mainCamera.name}
              </div>
              {streams[mainCamera.id] ? (
                <img
                  src={streams[mainCamera.id]!}
                  alt={mainCamera.name}
                  style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
                />
              ) : (
                <div className="camera-full-text">{mainCamera.name}</div>
              )}
              <button
                className="camera-full-restore"
                title="Click to return to camera panel"
                onClick={(e) => {
                  e.stopPropagation();
                  handleMainClick();
                }}
              >
                <Minimize2 size={12} /> Restore
              </button>
            </div>
          )}

          <div className="view-main-label">
            <span>{viewTitle}</span>
            {hasAnyCam && (
              <>
                {mainCamera || mainSlot.type === "camera-empty" || gridView ? (
                  <button className="connect-camera-btn" onClick={() => setGridView(false)}>
                    <Video size={14} /> Map
                  </button>
                ) : null}
                {!gridView && (
                  <button className="connect-camera-btn" onClick={() => setGridView(true)}>
                    <Video size={14} /> All
                  </button>
                )}
                <button className="connect-camera-btn connected" onClick={handleDisconnectAll} title="Disconnect All Cameras">
                  <VideoOff size={14} /> Disconnect All
                </button>
                {/* Global recording control — belongs with the camera UI on the
                    DATA page (recording is a camera function), not on PLAN. */}
                <BottomRecControl />
              </>
            )}
          </div>
        </div>

        {renderPreview("preview1")}
        {renderPreview("preview2")}
      </div>

      {configuring && (
        <CameraConfigDialog
          cameraType={configuring}
          initialUrl={(configuring === "live" ? liveCam : thermalCam)?.url ?? ""}
          onConnect={handleConfigureConnect}
          onClose={() => setConfiguring(null)}
        />
      )}
    </div>
  );
}

export default DataPage;
