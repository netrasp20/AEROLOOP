import { useEffect, useRef, useState } from "react";
import { WhepClient } from "../utils/whep";

type Props = {
  whepUrl: string;
  onError?: () => void;
};

function WebRTCVideo({ whepUrl, onError }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<WhepClient | null>(null);
  const [state, setState] = useState<"connecting" | "connected" | "failed">("connecting");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const client = new WhepClient();
    clientRef.current = client;

    let settled = false;
    // If the WHEP server is unreachable/half-dead the fetch may hang instead of
    // rejecting, leaving the widget stuck on the black "Connecting…" overlay.
    // Force a fallback to the MJPEG stream after a short timeout.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      setState("failed");
      onError?.();
      client.close();
    }, 4000);

    client.connect(whepUrl, video)
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setState("connected");
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setState("failed");
        onError?.();
      });

    return () => {
      settled = true;
      clearTimeout(timer);
      client.close();
      clientRef.current = null;
    };
  }, [whepUrl, onError]);

  return (
    <>
      {state === "connecting" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#6b7280", fontSize: 13, gap: 8 }}>
          <span className="spin-icon" style={{ width: 12, height: 12, border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "#a78bfa", borderRadius: "50%" }} />
          Connecting WebRTC...
        </div>
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000", display: state === "connected" ? "block" : "none" }}
      />
    </>
  );
}

export default WebRTCVideo;
