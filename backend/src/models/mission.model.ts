export interface Home {
  lat: number;
  lng: number;
}

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

export interface Mission {
  home: Home | null;
  waypoints: Waypoint[];
}

export interface MavlinkMissionItem {
  seq: number;
  frame: number;
  command: number;
  current: number;
  autocontinue: number;
  param1: number;
  param2: number;
  param3: number;
  param4: number;
  x: number;
  y: number;
  z: number;
}

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

export interface UploadProgress {
  total: number;
  current: number;
  phase: "validating" | "connecting" | "uploading" | "verifying" | "done";
}
