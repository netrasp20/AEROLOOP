import { useEffect } from "react";

type LoadResult = {
  filename: string;
  waypoints: number;
  home: boolean;
  loadedAt: string;
};

type Props = {
  type: "success" | "error";
  data?: LoadResult;
  message?: string;
  onDismiss: () => void;
};

const cardStyle: Record<string, React.CSSProperties> = {
  container: {
    borderRadius: 10,
    padding: "12px 14px",
    fontSize: 13,
    lineHeight: 1.5,
    position: "relative",
  },
  success: {
    background: "rgba(34,197,94,0.12)",
    border: "1px solid rgba(34,197,94,0.35)",
    color: "#86efac",
  },
  error: {
    background: "rgba(239,68,68,0.12)",
    border: "1px solid rgba(239,68,68,0.35)",
    color: "#fca5a5",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontWeight: 700,
    marginBottom: 6,
  },
  icon: {
    fontSize: 16,
  },
  row: {
    display: "flex",
    justifyContent: "space-between",
    padding: "2px 0",
  },
  label: {
    color: "rgba(255,255,255,0.5)",
  },
  value: {
    fontWeight: 600,
  },
  closeBtn: {
    position: "absolute",
    top: 6,
    right: 8,
    background: "none",
    border: "none",
    color: "inherit",
    cursor: "pointer",
    fontSize: 16,
    lineHeight: 1,
    opacity: 0.6,
    padding: 0,
  },
};

function MissionStatus({ type, data, message, onDismiss }: Props) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 7000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      style={{
        ...cardStyle.container,
        ...(type === "success"
          ? cardStyle.success
          : cardStyle.error),
      }}
    >
      <button style={cardStyle.closeBtn} onClick={onDismiss}>
        ×
      </button>

      {type === "success" && data ? (
        <>
          <div style={cardStyle.header}>
            <span style={cardStyle.icon}>✓</span>
            <span>Mission Loaded Successfully</span>
          </div>

          <div style={cardStyle.row}>
            <span style={cardStyle.label}>File:</span>
            <span style={cardStyle.value}>{data.filename}</span>
          </div>

          <div style={cardStyle.row}>
            <span style={cardStyle.label}>Waypoints:</span>
            <span style={cardStyle.value}>{data.waypoints}</span>
          </div>

          <div style={cardStyle.row}>
            <span style={cardStyle.label}>Home:</span>
            <span style={cardStyle.value}>
              {data.home ? "Available" : "Not Set"}
            </span>
          </div>

          <div style={cardStyle.row}>
            <span style={cardStyle.label}>Status:</span>
            <span style={cardStyle.value}>Ready to Upload</span>
          </div>

          <div style={cardStyle.row}>
            <span style={cardStyle.label}>Loaded:</span>
            <span style={cardStyle.value}>{data.loadedAt}</span>
          </div>
        </>
      ) : (
        <>
          <div style={cardStyle.header}>
            <span style={cardStyle.icon}>✕</span>
            <span>Mission Load Failed</span>
          </div>

          {message && (
            <div style={cardStyle.row}>
              <span style={cardStyle.label}>Reason:</span>
              <span style={cardStyle.value}>{message}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default MissionStatus;
