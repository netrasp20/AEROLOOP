# Frame / Airframe QGC-Style Report

## Scope

Only `SETUP -> Frame / Airframe` was redesigned. The existing ArduCopter
parameter read, staging, conflict, verified-write, disconnect, and reconnect
paths were preserved. No other Setup page or application shell was changed.

## UI Changes

- Added a QGC-style explanatory header and live connection/frame status line.
- Added a responsive, scrollable airframe card grid.
- Added original SVG-style motor/frame illustrations for each metadata-backed
  frame class.
- Widened the Frame page to use the available Setup content area, reduced the
  header to a compact live status row, and compacted the lower parameter panel.
- Added separate standard and advanced/special groups for metadata labels that
  identify scripting/custom allocation modes.
- Added distinct pending and current card indicators.
- Added selected/current highlighting and a variant selector on the selected
  card.
- Kept the existing live parameter controls in a secondary section for clear
  accessibility and direct parameter visibility.
- Renamed the primary write action to `Apply and Restart`; reboot behavior still
  follows the existing backend metadata and does not fake a restart.

## Live Data Architecture

- `frameLogic.ts::frameConfig` remains the source of `FRAME_CLASS` and
  `FRAME_TYPE` live values and metadata options.
- Current values come from `ParamEntry.live` in the shared `ParameterContext`.
- Pending values come from the shared `store.staged` map.
- Selection changes call the existing `store.stageValue` path.
- Apply calls the existing verified `store.executeWrite` path.
- Conflicts use the existing `writeConflicts` and acknowledgement flow.
- Socket/parameter updates continue through the existing ParameterContext
  lifecycle; no duplicate state or write system was introduced.

## Supported Airframe Categories

The grid is generated from the connected firmware's `FRAME_CLASS` metadata.
It therefore shows only options exposed by the running ArduCopter firmware.
When metadata is unavailable, the existing documented ArduCopter fallback map is
used. No Rover, Plane, PX4, or unrelated vehicle choices were added.

## State Behavior

- Disconnected: no live frame values or selected badge are shown; local staged
  values may still be reverted through the existing safe path.
- Synchronizing: the existing loading state remains visible until the shared
  parameter store is ready.
- Connected: cards and status values use live `FRAME_CLASS`/`FRAME_TYPE` data.
- Staged change: selected card and pending values update without writing.
- Apply: existing parameter batch write, echo verification, reboot metadata,
  and result handling remain authoritative.
- Remote parameter changes: existing parameter update events refresh the live
  selection and clear or reconcile staged state according to the shared store.

## Verification

- Frame tests: `11 passed`
- Backend full suite: `643 passed`
- Frontend full suite: `538 passed`
- TypeScript and production build: passed
- ESLint: passed with existing warnings

No physical Pixhawk parameter write was performed as part of visual validation.
