import { useState, useCallback, useEffect, useRef } from "react";
import {
  Shield,
  Upload,
  Download,
  Trash2,
  Loader,
  AlertTriangle,
  CheckCircle,
  MapPin,
  Circle,
  FolderOpen,
  BadgeCheck,
} from "lucide-react";

import { uploadFence, downloadFence, clearFence, verifyFence } from "../api/fence";
import type { FencePoint } from "../api/fence";
import { downloadFenceFile, loadFenceFile } from "../utils/fenceFile";
import useSocketTelemetry from "../hooks/useSocketTelemetry";

import "../styles/fence.css";

/* ------------------------------------------------------------------ */
/* Fence command constants                                             */
/* ------------------------------------------------------------------ */

const CMD_POLYGON_INCLUSION = 5001;
const CMD_POLYGON_EXCLUSION = 5002;
const CMD_CIRCLE_INCLUSION = 5003;
const CMD_CIRCLE_EXCLUSION = 5004;

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function FenceEditor() {
  const [fencePoints, setFencePoints] = useState<FencePoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fenceType, setFenceType] = useState<"polygon" | "circle">("polygon");
  const [fenceMode, setFenceMode] = useState<"inclusion" | "exclusion">("inclusion");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const telemetry = useSocketTelemetry();

  const breachStatus = telemetry?.fenceBreachStatus ?? 0;
  const breachCount = telemetry?.fenceBreachCount ?? 0;
  const breachType = telemetry?.fenceBreachType ?? 0;

  /* ---- Load fence from vehicle on mount ---- */
  useEffect(() => {
    handleDownload();
  }, []);

  /* ---- Clear messages after 3s ---- */
  useEffect(() => {
    if (success || error) {
      const t = setTimeout(() => {
        setSuccess(null);
        setError(null);
      }, 3000);
      return () => clearTimeout(t);
    }
  }, [success, error]);

  /* ---- Download fence from vehicle ---- */
  const handleDownload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await downloadFence();
      setFencePoints(result.points);
      setSuccess(`Downloaded ${result.count} fence points.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setLoading(false);
    }
  }, []);

  /* ---- Upload fence to vehicle ---- */
  const handleUpload = useCallback(async () => {
    if (fencePoints.length === 0) {
      setError("No fence points to upload.");
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await uploadFence(fencePoints);
      setSuccess(`Uploaded ${result.points} fence points.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setLoading(false);
    }
  }, [fencePoints]);

  /* ---- Verify fence (upload + download round-trip) ---- */
  const handleVerify = useCallback(async () => {
    if (fencePoints.length === 0) {
      setError("No fence points to verify.");
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await verifyFence(fencePoints);
      setSuccess(`Verified ${result.count} fence points on vehicle.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verify failed");
    } finally {
      setLoading(false);
    }
  }, [fencePoints]);

  /* ---- Clear fence from vehicle ---- */
  const handleClear = useCallback(async () => {
    if (!window.confirm("Clear all fence points from the vehicle?")) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await clearFence();
      setFencePoints([]);
      setSuccess("Fence cleared from vehicle.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clear failed");
    } finally {
      setLoading(false);
    }
  }, []);

  /* ---- Save fence to file ---- */
  const handleSaveFile = useCallback(() => {
    if (fencePoints.length === 0) {
      setError("No fence points to save.");
      return;
    }
    downloadFenceFile(fencePoints);
    setSuccess("Fence saved to file.");
  }, [fencePoints]);

  /* ---- Load fence from file ---- */
  const handleLoadFileClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setSuccess(null);
    try {
      const points = await loadFenceFile(file);
      setFencePoints(points);
      setSuccess(`Loaded ${points.length} fence points from ${file.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load fence file.");
    }
  }, []);

  /* ---- Breach label ---- */
  function breachLabel(status: number, type: number): string {
    if (status === 0) return "";
    switch (type) {
      case 1: return "Boundary breach";
      case 2: return "Maximum altitude breach";
      case 3: return "Minimum altitude breach";
      default: return "Fence breach";
    }
  }

  /* ---- Add fence point ---- */
  const handleAddPoint = useCallback(() => {
    const cmd =
      fenceType === "polygon"
        ? fenceMode === "inclusion"
          ? CMD_POLYGON_INCLUSION
          : CMD_POLYGON_EXCLUSION
        : fenceMode === "inclusion"
          ? CMD_CIRCLE_INCLUSION
          : CMD_CIRCLE_EXCLUSION;

    const newPoint: FencePoint = {
      lat: 0,
      lng: 0,
      command: cmd,
      param1: fenceType === "circle" ? 100 : 0, // default radius 100m for circles
    };
    setFencePoints((prev) => [...prev, newPoint]);
  }, [fenceType, fenceMode]);

  /* ---- Remove fence point ---- */
  const handleRemovePoint = useCallback((index: number) => {
    setFencePoints((prev) => prev.filter((_, i) => i !== index));
  }, []);

  /* ---- Update fence point ---- */
  const handleUpdatePoint = useCallback(
    (index: number, field: keyof FencePoint, value: number) => {
      setFencePoints((prev) =>
        prev.map((pt, i) => (i === index ? { ...pt, [field]: value } : pt))
      );
    },
    []
  );

  /* ---- Get command label ---- */
  function cmdLabel(cmd: number): string {
    switch (cmd) {
      case CMD_POLYGON_INCLUSION:
        return "Polygon Inclusion";
      case CMD_POLYGON_EXCLUSION:
        return "Polygon Exclusion";
      case CMD_CIRCLE_INCLUSION:
        return "Circle Inclusion";
      case CMD_CIRCLE_EXCLUSION:
        return "Circle Exclusion";
      default:
        return `Unknown (${cmd})`;
    }
  }

  /* ---- Get command icon ---- */
  function cmdIcon(cmd: number) {
    if (cmd === CMD_CIRCLE_INCLUSION || cmd === CMD_CIRCLE_EXCLUSION) {
      return <Circle size={14} />;
    }
    return <MapPin size={14} />;
  }

  return (
    <div className="fence-editor">
      <div className="fence-header">
        <Shield size={18} />
        <h3>Fences</h3>
      </div>

      {/* ---- Breach status banner ---- */}
      {(breachStatus > 0 || (breachCount > 0 && !success)) && (
        <div className="fence-message fence-error" data-testid="fence-breach">
          <AlertTriangle size={14} />
          <span>
            {breachLabel(breachStatus, breachType)}
            {breachCount > 0 ? ` — ${breachCount} triggered` : ""}
          </span>
        </div>
      )}

      {/* ---- Status messages ---- */}
      {error && (
        <div className="fence-message fence-error">
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="fence-message fence-success">
          <CheckCircle size={14} />
          <span>{success}</span>
        </div>
      )}

      {/* ---- Actions ---- */}
      <div className="fence-actions">
        <button
          className="fence-btn"
          onClick={handleDownload}
          disabled={loading}
          title="Download fence from vehicle"
        >
          <Download size={14} />
          Download
        </button>
        <button
          className="fence-btn fence-btn-primary"
          onClick={handleUpload}
          disabled={loading || fencePoints.length === 0}
          title="Upload fence to vehicle"
        >
          <Upload size={14} />
          Upload
        </button>
        <button
          className="fence-btn fence-btn-primary"
          onClick={handleVerify}
          disabled={loading || fencePoints.length === 0}
          title="Verify fence by uploading and downloading back"
        >
          <BadgeCheck size={14} />
          Verify
        </button>
        <button
          className="fence-btn fence-btn-danger"
          onClick={handleClear}
          disabled={loading}
          title="Clear all fence points"
        >
          <Trash2 size={14} />
          Clear
        </button>
        <button
          className="fence-btn"
          onClick={handleSaveFile}
          disabled={loading || fencePoints.length === 0}
          title="Save fence to file"
        >
          <Download size={14} />
          Save File
        </button>
        <button
          className="fence-btn"
          onClick={handleLoadFileClick}
          disabled={loading}
          title="Load fence from file"
        >
          <FolderOpen size={14} />
          Load File
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        {loading && <Loader size={16} className="spin-icon" />}
      </div>

      {/* ---- Fence type selector ---- */}
      <div className="fence-type-selector">
        <label>
          <span>Type:</span>
          <select
            value={fenceType}
            onChange={(e) => setFenceType(e.target.value as "polygon" | "circle")}
          >
            <option value="polygon">Polygon</option>
            <option value="circle">Circle</option>
          </select>
        </label>
        <label>
          <span>Mode:</span>
          <select
            value={fenceMode}
            onChange={(e) => setFenceMode(e.target.value as "inclusion" | "exclusion")}
          >
            <option value="inclusion">Inclusion</option>
            <option value="exclusion">Exclusion</option>
          </select>
        </label>
        <button className="fence-btn" onClick={handleAddPoint}>
          + Add Point
        </button>
      </div>

      {/* ---- Fence points list ---- */}
      <div className="fence-points">
        {fencePoints.length === 0 ? (
          <div className="fence-empty">
            No fence points. Click "Add Point" to create a fence, or "Download" to
            load from vehicle.
          </div>
        ) : (
          <table className="fence-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Type</th>
                <th>Latitude</th>
                <th>Longitude</th>
                <th>Param1</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {fencePoints.map((pt, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td className="fence-cmd">
                    {cmdIcon(pt.command)}
                    <span>{cmdLabel(pt.command)}</span>
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.000001"
                      value={pt.lat}
                      onChange={(e) =>
                        handleUpdatePoint(i, "lat", parseFloat(e.target.value) || 0)
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.000001"
                      value={pt.lng}
                      onChange={(e) =>
                        handleUpdatePoint(i, "lng", parseFloat(e.target.value) || 0)
                      }
                    />
                  </td>
                  <td>
                    {(pt.command === CMD_CIRCLE_INCLUSION ||
                      pt.command === CMD_CIRCLE_EXCLUSION) && (
                      <input
                        type="number"
                        step="1"
                        min="0"
                        value={pt.param1}
                        onChange={(e) =>
                          handleUpdatePoint(i, "param1", parseFloat(e.target.value) || 0)
                        }
                        title="Radius (meters)"
                      />
                    )}
                  </td>
                  <td>
                    <button
                      className="fence-btn-icon"
                      onClick={() => handleRemovePoint(i)}
                      title="Remove point"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ---- Point count ---- */}
      <div className="fence-footer">
        {fencePoints.length} point{fencePoints.length !== 1 ? "s" : ""}
        {breachStatus > 0 && ` · ${breachLabel(breachStatus, breachType)}`}
      </div>
    </div>
  );
}
