# Parameter editing (Phase 4) — developer notes

Phase 4 adds **local parameter editing, validation, modified/staged state and
undo/revert**. It does **not** write to the flight controller. Write Params
(command all staged changes to the vehicle) arrives in Phase 5.

## The two states of a parameter value

| State    | Where it lives        | Meaning                                             | Writes? |
|----------|-----------------------|-----------------------------------------------------|---------|
| **Live** | `store.entries[id]`   | The authoritative vehicle value (backend + socket)  | Never changed by us |
| **Staged**| `store.staged[id]`   | A value the user is proposing locally               | Never written yet |

- Live data comes only from `GET /api/parameters` (rehydrate/refresh) and the
  `parameter:updated` socket event. Editing never produces live data.
- Staged data comes only from user edits; it **never** mutates live state and
  is never sent anywhere.

## The staged-change record

`StagedChange` (in `stagedLogic.ts`):

```ts
{
  paramId,          // key
  originalValue,    // live value captured at the FIRST edit — stable thereafter
  liveValue,        // latest known live value (refreshed on updated/reconcile)
  stagedValue,      // the user's proposed value (2→3→4→5 keeps staged 5)
  changedAt,
  conflict,         // true when vehicle live != original while we're staged
  conflictKind,     // NONE | EXTERNAL_LIVE_CHANGE | SESSION_RECONNECT_CHANGE
}
```

- "Modified" is **derived** as `!valuesEqual(live, staged, type)`; one entry
  per parameter no matter how many times it was edited.
- Editing a value back to the current live value automatically removes the
  staged change (2→3→2 leaves nothing modified).
- `originalValue` is captured once and never changes, so a write phase can show
  exactly "vehicle value at first edit → what you proposed", even if the
  vehicle value drifted meanwhile.

Module map:

- `validation.ts` — pure, framework-free validation rules.
- `stagedLogic.ts` — pure staged-map operations (stage/revert/discard/reconcile,
  editor classification).
- `stagedPersistence.ts` — localStorage round-trip for **staged data only**;
  live values are never persisted or restored from disk.

## Editing rules

- Editors live in `ParameterDetails.tsx` and are chosen by metadata:
  - numeric (min/max/increment hints), commit on **Enter or blur**;
  - enum → `<select>`; bitmask → checkboxes; read-only → no editor.
- A keystroke never stages; only a valid committed value becomes staged.
- Invalid input fails validation and shows the reason inline (no clamped or
  silently-corrected values).

## Validation (`validation.ts`)

`validateStagedValue(entry, value)` → `{ valid } | { valid:false, code, message }`.

1. NaN / Infinity rejection.
2. Integer MAVLink types reject decimals (no silent rounding).
3. Metadata min/max (`OUT_OF_RANGE`).
4. Metadata increment measured from min, with float tolerance
   (`BAD_INCREMENT`, accepts 0.30000000000000004).
5. Enum: only defined codes (`INVALID_ENUM`). Bitmask: non-negative integer.

Values are never clamped into range; a rejected value is just rejected.

## Numeric comparison (`valuesEqual` in `parametersLogic.ts`)

Comparing "did this change?" uses type-aware equality, **not** naive `===`:

- REAL32/DOUBLE compare with `Math.fround` semantics so representation noise
  (e.g. `0.1 + 0.2`) does not create a false "Modified" state, while real
  differences (2.0 → 2.5) still count as modified.
- Integer types compare exactly (2 ≡ 2.0).

## Conflict handling

If the vehicle value changes while a staged edit exists:

- `parameter:updated` → live merged authoritatively AND the staged record gets
  `liveValue` refreshed + `conflict: true` / `EXTERNAL_LIVE_CHANGE`. The staged
  value is **never overwritten** and never auto-written.
- Full sync/reconnect → `reconcileStaged` refreshes each staged record's
  `liveValue`/conflict; parameters that vanish from the vehicle have their
  staged edits dropped. Staged values are never clobbered.
- Disconnect keeps all staged edits (marked by UI as disconnected); nothing is
  written on resume.
- Refresh while modified → `window.confirm` first; staged edits survive the
  refresh and are reconciled for conflicts.
- Browser refresh → staged edits persist via localStorage and are reconciled
  against fresh live data on reload.

## Explicitly NOT in Phase 4

No `PARAM_SET`/`POST write`, no batch/auto/on-enter/on-blur/on-select write
behavior, no Write Params button, no parameter file load/save/compare/presets/
reset-default. `api/parameters.ts` has no write endpoint.

## How Phase 5 consumes the staged model

`store.staged` is a `Record<paramId, StagedChange>` ready for a Write Params
step:

- enumerate `Object.values(staged)` for the write list;
- `originalValue` → "vehicle before", `stagedValue` → "proposed" for review and
  revert decisions;
- after a write succeeds, apply the server handle to live state and remove the
  staged entry (filter out `conflict` records until resolved);
- socket `parameter:updated` echoes will keep UI/live in sync exactly as today.