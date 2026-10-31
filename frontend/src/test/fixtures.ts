import type {
  MetadataStatus,
  ParamEntry,
  ParameterListView,
  ParameterStatusView,
  SyncState,
} from "../api/parameters";

export function makeMetadata(
  overrides: Partial<ParamEntry["metadata"] & { __danger?: never }> = {}
): NonNullable<ParamEntry["metadata"]> {
  return {
    id: "WP_RADIUS_M",
    name: "Waypoint Radius",
    description: "Distance within which a waypoint is considered reached.",
    units: "m",
    unitText: "m",
    min: 0,
    max: 100,
    increment: 0.1,
    values: null,
    bitmask: null,
    readOnly: false,
    rebootRequired: false,
    user: "Standard",
    advanced: false,
    group: "Waypoints",
    source: "ArduPilot.xml",
    ...overrides,
  } as NonNullable<ParamEntry["metadata"]>;
}

export function entry(overrides: Partial<ParamEntry> = {}): ParamEntry {
  return {
    id: "WP_RADIUS_M",
    live: { value: 2, type: "FLOAT", index: 0, count: 7, received: true },
    metadata: makeMetadata(),
    metadataMissing: false,
    ...overrides,
  };
}

export const syncComplete: SyncState = {
  connected: true,
  state: "complete",
  expectedCount: 7,
  receivedCount: 7,
  missingIds: [],
  cachedEntries: 7,
  retryCount: 0,
  needsRefresh: false,
};

export const metadataAvailable: MetadataStatus = {
  vehicle: "copter",
  status: "AVAILABLE",
  source: "ardupilot-param_parse.py",
  sourceFile: "copter.xml",
  paramCount: 5691,
  groupCount: 376,
  message: null,
};

export function sampleEntries(): ParamEntry[] {
  return [
    entry({
      id: "WP_RADIUS_M",
      metadata: makeMetadata({
        id: "WP_RADIUS_M",
        name: "Waypoint Radius",
        description: "Distance within which a waypoint is considered reached.",
        units: "m",
        unitText: "m",
        min: 0,
        max: 100,
        increment: 0.1,
        group: "Waypoints",
      }),
      live: { value: 2, type: "FLOAT", received: true },
    }),
    entry({
      id: "WPNAV_SPEED",
      metadata: makeMetadata({
        id: "WPNAV_SPEED",
        name: "Maximum speed",
        description: "Maximum speed for missions.",
        units: "cm/s",
        unitText: "cm/s",
        min: 0,
        max: 2000,
        increment: 50,
        group: "Waypoint Options",
      }),
      live: { value: 1200, type: "INT32", received: true },
    }),
    entry({
      id: "FRAME_TYPE",
      metadata: makeMetadata({
        id: "FRAME_TYPE",
        name: "Frame Type",
        description: "Frame type of the multicopter.",
        values: {
          "0": "Quad",
          "1": "Hexa",
          "2": "Octa",
          "3": "Heli",
        },
        group: "Frame Type",
      }),
      live: { value: 0, type: "INT32", received: true },
    }),
    entry({
      id: "FS_THR_ENABLE",
      metadata: makeMetadata({
        id: "FS_THR_ENABLE",
        name: "Throttle Failsafe",
        user: "Advanced",
        advanced: true,
        values: {
          "0": "Disabled",
          "1": "Enabled",
          "2": "Enabled Continuous",
        },
        group: "FailSafe",
      }),
      live: { value: 2.0, type: "UINT8", received: true },
    }),
    entry({
      id: "CRM_BALANCE",
      metadata: makeMetadata({
        id: "CRM_BALANCE",
        name: "Balance",
        user: "Advanced",
        advanced: true,
        bitmask: {
          "0": "Learn",
          "1": "Turn",
          "2": "Brake",
        },
        group: "Wheel",
      }),
      live: { value: 5, type: "UINT16", received: true },
    }),
    entry({
      id: "SCR_USER1",
      metadata: null,
      metadataMissing: true,
      live: { value: 0, type: "INT32", received: true },
    }),
    entry({
      id: "FENCE_ENABLE",
      metadata: makeMetadata({
        id: "FENCE_ENABLE",
        name: "Fence Enable",
        description: "A geofence is a virtual boundary.",
        values: {
          "0": "Disabled",
          "1": "Enabled",
        },
        group: "GeoFence",
      }),
      live: { value: 1, type: "UINT8", received: true },
    }),
  ];
}

export function listView(overrides: Partial<ParameterListView> = {}): ParameterListView {
  return {
    success: true,
    connection: "READY",
    sync: syncComplete,
    metadata: metadataAvailable,
    metadataMissing: false,
    vehicle: { vehicleType: "QUADROTOR" },
    count: sampleEntries().length,
    parameters: sampleEntries(),
    ...overrides,
  };
}

export function statusView(
  overrides: Partial<ParameterStatusView> = {}
): ParameterStatusView {
  return {
    success: true,
    connection: "READY",
    sync: syncComplete,
    sessionId: "abc123",
    metadata: metadataAvailable,
    vehicle: { vehicleType: "QUADROTOR" },
    ...overrides,
  };
}