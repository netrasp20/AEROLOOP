import { useState, useCallback } from "react";

import type {
  Mission,
  UploadResult,
  UploadProgress,
  UploadStatus,
  UploadError,
} from "../types/mission";

import { missionUploadService } from "../services/MissionUploadService";

export function useMissionUpload() {
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [popupError, setPopupError] = useState<UploadError | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  const upload = useCallback(
    async (mission: Mission, vehicleConnected: boolean): Promise<UploadResult> => {
      setStatus("uploading");
      setResult(null);
      setPopupError(null);
      setShowSuccess(false);

      const res = await missionUploadService.upload(
        mission,
        vehicleConnected,
        (p: UploadProgress) => {
          setProgress(p);
        }
      );

      if (!res.success && res.errorInfo) {
        setPopupError(res.errorInfo);
      }

      if (res.success) {
        setShowSuccess(true);
      }

      setStatus(res.success ? "success" : "error");
      setResult(res);

      return res;
    },
    []
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setProgress(null);
    setResult(null);
    setPopupError(null);
    setShowSuccess(false);
  }, []);

  const dismissPopup = useCallback(() => {
    setPopupError(null);
    setShowSuccess(false);
    setStatus("idle");
  }, []);

  return {
    status,
    progress,
    result,
    popupError,
    showSuccess,
    upload,
    reset,
    dismissPopup,
  };
}
