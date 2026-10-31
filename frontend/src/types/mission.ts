export interface Waypoint {
  id: number;
  lat: number;
  lng: number;
  altitude: number;
  hoverTime: number;
  command: string;
  frame: string;
  sequence: number;
}

export interface HomePosition {
  lat: number;
  lng: number;
}

export interface Mission {
  home: HomePosition | null;
  waypoints: Waypoint[];
}

export interface MissionFile {
  version: number;
  timestamp: string;
  home: HomePosition | null;
  waypoints: Array<{
    id: number;
    lat: number;
    lng: number;
    altitude: number;
    hoverTime: number;
    command: string;
    frame: string;
    sequence: number;
  }>;
}

export type MissionRepeat = "once" | "daily" | "weekly" | "custom";
export type MissionScheduleStatus =
  | "scheduled"
  | "waiting"
  | "uploading"
  | "completed"
  | "cancelled"
  | "failed";

export interface ScheduledMission {
  id: string;
  name: string;
  /** Snapshot of the ACTUAL mission (waypoints + home) at schedule time. */
  mission: MissionFile;
  /** LOCAL naive ISO (YYYY-MM-DDTHH:MM) of the start date/time chosen by the user. */
  startDateTime: string;
  repeat: MissionRepeat;
  /** 0=Sunday … 6=Saturday — only for repeat "weekly". */
  weeklyDays?: number[];
  /** YYYY-MM-DD list — only for repeat "custom". */
  customDates?: string[];
  /** LOCAL naive ISO end date/time — for daily/weekly. */
  endDateTime?: string | null;
  status: MissionScheduleStatus;
  createdAt: string;
  /** Next occurrence to run (LOCAL naive ISO). Backend-computed. */
  nextRun?: string | null;
  /** Reason from the last failed upload. */
  lastError?: string | null;
  /** Whether the schedule is active. */
  enabled?: boolean;
  /** The occurrence currently executed / last attempted. */
  occurrence?: string | null;
  /** ISO timestamp of the last successful upload. */
  lastExecutedAt?: string | null;
}

export type ValidationErrorCode =
  | "VEHICLE_NOT_CONNECTED"
  | "NO_MISSION_FOUND"
  | "NO_WAYPOINTS"
  | "HOME_MISSING"
  | "INVALID_COORDINATES"
  | "INVALID_ALTITUDE"
  | "DUPLICATE_SEQUENCE"
  | "INVALID_ORDER"
  | "UPLOAD_FAILED"
  | "VERIFICATION_FAILED";

export interface UploadError {
  code: ValidationErrorCode;
  title: string;
  message: string;
}

export interface UploadProgress {
  total: number;
  current: number;
  phase: "validating" | "connecting" | "uploading" | "verifying" | "done";
}

export type UploadStatus =
  | "idle"
  | "uploading"
  | "success"
  | "error";

export interface VerificationMismatch {
  waypoint: number;
  field: string;
  uploaded: any;
  downloaded: any;
}

export interface VerificationResult {
  success: boolean;
  uploadedCount: number;
  downloadedCount: number;
  mismatches: VerificationMismatch[];
}

export interface UploadResult {
  success: boolean;
  message: string;
  errors?: string[];
  errorInfo?: UploadError | null;
}

export interface MissionInfo {
  id: string;
  filename: string;
  timestamp: string;
  waypointCount: number;
  hasHome: boolean;
}

export interface MissionSaveResponse {
  success: boolean;
  mission: MissionInfo;
}

export interface MissionListResponse {
  success: boolean;
  missions: MissionInfo[];
}

export interface MissionLoadResponse {
  success: boolean;
  mission: MissionFile;
}

/* ================================================================
   Mission Execution State (Start Mission)
   Sequential workflow matching Mission Planner / QGC:
     MISSION_CREATED → MISSION_UPLOADED → VEHICLE_ARMED → AUTO_MODE → MISSION_RUNNING → MISSION_COMPLETED
   ================================================================ */

export type MissionExecutionState =
  | "MISSION_CREATED"
  | "MISSION_UPLOADED"
  | "VEHICLE_ARMED"
  | "AUTO_MODE"
  | "MISSION_RUNNING"
  | "MISSION_COMPLETED"
  | "FAILED";

export interface MissionStartResult {
  success: boolean;
  message: string;
  ackCode?: number;
  ackLabel?: string;
}
