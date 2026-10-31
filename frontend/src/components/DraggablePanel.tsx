import { useState, useRef, useCallback, useEffect } from "react";
import type { ReactNode, CSSProperties } from "react";
import { ChevronDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react";

type Anchor = "topleft" | "topright" | "bottomleft" | "bottomright";

type Props = {
  id: string;
  title: string | ReactNode;
  children: ReactNode;
  defaultWidth?: number;
  defaultHeight?: number;
  defaultPos?: { x: number; y: number };
  anchor?: Anchor;
  icon?: ReactNode;
  actions?: ReactNode;
  onActivate?: () => void;
  isActive?: boolean;
};

type StyleState = {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
};

function DraggablePanel({
  id,
  title,
  children,
  defaultWidth = 320,
  defaultHeight = 200,
  defaultPos,
  anchor = "bottomleft",
  icon,
  actions,
  onActivate,
  isActive,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [size, setSize] = useState({ w: defaultWidth, h: defaultHeight });

  const initX = defaultPos?.x ?? 16;
  const initY = defaultPos?.y ?? 16;

  const initStyle = (): StyleState => {
    switch (anchor) {
      case "bottomleft":
        return { left: initX, bottom: initY };
      case "bottomright":
        return { right: initX, bottom: initY };
      case "topright":
        return { right: initX, top: initY };
      default:
        return { left: initX, top: initY };
    }
  };

  const [styleState, setStyleState] = useState<StyleState>(initStyle);

  const dragRef = useRef({
    dragging: false,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startRight: 0,
    startTop: 0,
    startBottom: 0,
  });
  const resizeRef = useRef({
    resizing: false,
    startX: 0,
    startY: 0,
    startW: 0,
    startH: 0,
  });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (collapsed) return;
    dragRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: styleState.left ?? 0,
      startRight: styleState.right ?? 0,
      startTop: styleState.top ?? 0,
      startBottom: styleState.bottom ?? 0,
    };
  }, [collapsed, styleState]);

  const handleResizeDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (collapsed || fullscreen) return;
    resizeRef.current = {
      resizing: true,
      startX: e.clientX,
      startY: e.clientY,
      startW: size.w,
      startH: size.h,
    };
  }, [collapsed, fullscreen, size]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (d.dragging) {
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        setStyleState((prev) => {
          const next: StyleState = {};
          if (anchor === "bottomleft" || anchor === "topleft") {
            next.left = d.startLeft + dx;
          } else {
            next.right = Math.max(0, d.startRight - dx);
          }
          if (anchor === "bottomleft" || anchor === "bottomright") {
            next.bottom = d.startBottom - dy;
          } else {
            next.top = d.startTop + dy;
          }
          return { ...prev, ...next };
        });
      }
      const r = resizeRef.current;
      if (r.resizing) {
        setSize({
          w: Math.max(240, r.startW + (e.clientX - r.startX)),
          h: Math.max(120, r.startH + (e.clientY - r.startY)),
        });
      }
    };
    const handleMouseUp = () => {
      dragRef.current.dragging = false;
      resizeRef.current.resizing = false;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [anchor]);

  const style: CSSProperties = fullscreen
    ? { position: "absolute", inset: 0, zIndex: 1100 }
    : {
        position: "absolute",
        left: styleState.left,
        right: styleState.right,
        top: styleState.top,
        bottom: styleState.bottom,
        width: size.w,
        height: collapsed ? "auto" : size.h,
        zIndex: 1100,
        cursor: dragRef.current.dragging ? "grabbing" : undefined,
      };

  return (
    <div
      ref={useRef<HTMLDivElement>(null)}
      className="dock-panel"
      style={style}
      data-panel-id={id}
    >
      <div
        className="dock-panel-header"
        onMouseDown={handleMouseDown}
        onClick={() => onActivate?.()}
        style={{ cursor: collapsed ? "default" : "grab" }}
      >
        {!isActive && (
          <div className="dock-panel-preview-badge">PREVIEW</div>
        )}
        <div className="dock-panel-title">
          {icon && <span className="dock-panel-icon">{icon}</span>}
          <span>{title}</span>
        </div>
        <div className="dock-panel-actions">
          {actions}
          <button
            className="dock-panel-btn"
            onClick={() => setFullscreen(!fullscreen)}
            title={fullscreen ? "Restore" : "Fullscreen"}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="dock-panel-btn"
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="dock-panel-body" style={{ height: fullscreen ? "calc(100% - 36px)" : "calc(100% - 36px)" }} onClick={() => onActivate?.()}>
          {children}
        </div>
      )}
      {!collapsed && !fullscreen && (
        <div className="dock-panel-resize" onMouseDown={handleResizeDown} />
      )}
    </div>
  );
}

export default DraggablePanel;
