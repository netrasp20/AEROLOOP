import { useEffect } from "react";
import type { UploadError } from "../types/mission";

type UploadErrorPopupProps = {
  type: "error" | "success";
  error?: UploadError | null;
  title?: string;
  message?: string;
  onClose: () => void;
  autoCloseMs?: number;
};

function UploadErrorPopup({
  type,
  error,
  title,
  message,
  onClose,
  autoCloseMs,
}: UploadErrorPopupProps) {
  useEffect(() => {
    if (!autoCloseMs || autoCloseMs <= 0) return;
    const timer = setTimeout(onClose, autoCloseMs);
    return () => clearTimeout(timer);
  }, [autoCloseMs, onClose]);

  const displayTitle = title || error?.title || "";
  const displayMessage = message || error?.message || "";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content upload-popup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="upload-popup-icon">
          {type === "success" ? (
            <div className="upload-popup-check">✓</div>
          ) : (
            <div className="upload-popup-cross">✕</div>
          )}
        </div>

        <h3 className="upload-popup-title">{displayTitle}</h3>

        <p className="upload-popup-message">{displayMessage}</p>

        <button className="upload-popup-btn" onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}

export default UploadErrorPopup;
