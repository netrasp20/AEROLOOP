import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ReactNode } from "react";

import socket from "../socket/socket";

import {
  getAllParameters,
  getMetadataOverview,
  getParameterStatus,
  refreshParameters,
  resetParameters,
  writeBatch,
} from "../api/parameters";

import type {
  ConnectionState,
  MetadataStatus,
  ParamConflict,
  ResetStatusView,
  ResetSummary,
  WriteItemInput,
  WriteItemResult,
  WriteTransactionSummary,
} from "../api/parameters";

import {
  arrayToMap,
  countParams,
  mergeUpdated,
  valuesEqual,
} from "../parameters/parametersLogic";

import type { ParamMap } from "../parameters/parametersLogic";

import {
  discardAllStaged,
  modifiedCount,
  reconcileStaged,
  revertStaged,
  stageChange,
} from "../parameters/stagedLogic";

import type { StageResult, StagedMap } from "../parameters/stagedLogic";

import { loadStaged, saveStaged } from "../parameters/stagedPersistence";

import { validateStagedValue } from "../parameters/validation";

/* ------------------------------------------------------------------ */
/* Sync progress model                                                 */
/* ------------------------------------------------------------------ */

export interface SyncProgress {
  active: boolean;
  receivedCount: number;
  expectedCount: number;
  complete: boolean;
  missing: string[];
  error: string | null;
}

const IDLE_SYNC: SyncProgress = {
  active: false,
  receivedCount: 0,
  expectedCount: 0,
  complete: false,
  missing: [],
  error: null,
};

/* ------------------------------------------------------------------ */
/* Socket event payloads                                               */
/* ------------------------------------------------------------------ */

interface SessionEvent {
  connection: "connected" | "disconnected";
  sessionId: string | null;
  startedAt?: number;
  reason?: string;
}

interface SyncStartEvent {
  sessionId?: string | null;
  expectedCount?: number;
}

interface SyncProgressEvent {
  sessionId?: string | null;
  receivedCount?: number;
  expectedCount?: number;
}

interface SyncErrorEvent {
  code?: string;
  message?: string;
  missing?: string[];
}

interface UpdatedEvent {
  id: string;
  value: number;
  type?: string | null;
  sessionId?: string | null;
}

/* ------------------------------------------------------------------ */
/* Write transaction model (Phase 5)                                    */
/* ------------------------------------------------------------------ */

export type WritePhase =
  | "idle"
  | "running"
  | "success"
  | "partial_failure"
  | "interrupted"
  | "error";

export interface WriteProgress {
  completed: number;
  total: number;
  currentParamId: string | null;
}

export interface WriteErrorInfo {
  code?: string;
  message?: string;
}

interface BatchWriteStartEvent {
  transactionId?: string;
  total?: number;
  status?: string;
}

interface BatchWriteProgressEvent {
  transactionId?: string;
  completed?: number;
  total?: number;
  currentParamId?: string;
}

interface BatchWriteItemEvent {
  transactionId?: string;
  paramId?: string;
  requestedValue?: number;
  status?: string;
  verifiedValue?: number | null;
  code?: string | null;
  message?: string | null;
}

interface WriteSingleEvent {
  id: string;
  value?: number;
  code?: string;
  message?: string;
}

const IDLE_WRITE_PROGRESS: WriteProgress = {
  completed: 0,
  total: 0,
  currentParamId: null,
};

/* ------------------------------------------------------------------ */
/* Reset-to-default model (Phase 6)                                    */
/* ------------------------------------------------------------------ */

interface ResetStartEvent {
  resetId?: string;
  startedAt?: number;
}

interface ResetProgressEvent {
  resetId?: string;
  state?: string;
  message?: string;
  step?: number | null;
  totalSteps?: number | null;
  summary?: ResetSummary | null | undefined;
}

interface ResetErrorEvent {
  resetId?: string;
  code?: string;
  message?: string;
  state?: string;
}

const IDLE_RESET: ResetStatusView = {
  success: true,
  active: false,
  resetId: null,
  state: "idle",
  message: "",
  error: null,
  summary: null,
  startedAt: null,
  completedAt: null,
};

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

function useParameterStore() {
  const [entries, setEntries] = useState<ParamMap>({});
  const [connection, setConnection] = useState<ConnectionState>("DISCONNECTED");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncProgress>(IDLE_SYNC);
  const [metadataStatus, setMetadataStatus] = useState<MetadataStatus | null>(
    null
  );
  const [groups, setGroups] = useState<string[]>([]);
  const [vehicleType, setVehicleType] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [staged, setStaged] = useState<StagedMap>({});

  /* ---- write transaction state (Phase 5) ---- */
  const [writePhase, setWritePhase] = useState<WritePhase>("idle");
  const [writeProgress, setWriteProgress] =
    useState<WriteProgress>(IDLE_WRITE_PROGRESS);
  const [writeConflicts, setWriteConflicts] = useState<ParamConflict[] | null>(
    null
  );
  const [writeError, setWriteError] = useState<WriteErrorInfo | null>(null);
  const [writeSummary, setWriteSummary] =
    useState<WriteTransactionSummary | null>(null);
  const [writeActiveTxnId, setWriteActiveTxnId] = useState<string | null>(null);
  const [resetState, setResetState] = useState<ResetStatusView>(IDLE_RESET);

  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const writeActiveTxnIdRef = useRef(writeActiveTxnId);
  writeActiveTxnIdRef.current = writeActiveTxnId;

  /* Restore persisted staged edits from a previous browser session.
     Reconciliation against fresh live values happens during rehydrate. */
  useEffect(() => {
    const restored = loadStaged();
    setStaged((prev) => ({ ...restored, ...prev }));
  }, []);

  /* ---------------- rehydrate (browser refresh / data sync) -------- */

  const rehydrate = useCallback(async () => {
    try {
      const status = await getParameterStatus();
      setConnection(status.connection);
      setSessionId(status.sessionId);
      setMetadataStatus(status.metadata);
      setVehicleType(status.vehicle?.vehicleType ?? null);
      setSync((prev) => ({
        ...prev,
        receivedCount: status.sync?.receivedCount ?? prev.receivedCount,
        expectedCount: status.sync?.expectedCount ?? prev.expectedCount,
      }));
      setLoadError(null);

      if (status.connection === "READY" || status.connection === "SYNCING") {
        const view = await getAllParameters();
        const map = arrayToMap(view.parameters);
        setEntries(map);
        setStaged((prev) => reconcileStaged(prev, map));
        setConnection(view.connection);
        setMetadataStatus(view.metadata);
        setVehicleType(view.vehicle?.vehicleType ?? null);
        setLastUpdated(Date.now());
        setLoadError(null);
        if (status.sessionId) {
          hydratedSessionRef.current = status.sessionId;
        }
      } else {
        setEntries({});
        setLastUpdated(null);
      }

      const overview = await getMetadataOverview();
      setMetadataStatus(overview.metadataStatus);
      setGroups(overview.groups);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load parameters."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  /* Self-heal: when a NEW vehicle session replaces the one we already had
     (an auto-reconnect after a disconnect), re-pull the authoritative REST
     snapshot. The backend resume-download sync:complete can stall (sync:start
     with expectedCount 0), so this guarantees the parameter set — and every
     page built on it — recovers without a browser reload. Debounced and
     guarded to the reconnect case only. */
  const rehydrateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hydratedSessionRef = useRef<string | null>(null);

  const scheduleRehydrate = useCallback(() => {
    if (rehydrateTimerRef.current) clearTimeout(rehydrateTimerRef.current);
    rehydrateTimerRef.current = setTimeout(() => {
      rehydrateTimerRef.current = null;
      void rehydrate();
    }, 800);
  }, [rehydrate]);

  /* ---------------- refresh (full vehicle download) ---------------- */

  const refresh = useCallback(async () => {
    if (refreshing) return; // block duplicate downloads
    setRefreshing(true);
    setSync({ ...IDLE_SYNC, active: true });
    try {
      await refreshParameters();
    } catch (err) {
      setRefreshing(false);
      setSync({ ...IDLE_SYNC, error: err instanceof Error ? err.message : "Refresh failed." });
      setLoadError(err instanceof Error ? err.message : "Refresh failed.");
    }
  }, [refreshing]);

  /* Poll fallback: when the socket is unavailable the start/complete
     events never arrive, so reconcile from /status until finished. */
  useEffect(() => {
    if (!refreshing) return;
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      if (cancelled) return;
      try {
        const status = await getParameterStatus();
        if (cancelled) return;
        setConnection(status.connection);
        if (status.sync.state === "complete") {
          setSync((prev) => ({
            ...prev,
            active: false,
            complete: true,
            missing: status.sync.missingIds ?? [],
            receivedCount: status.sync.receivedCount ?? prev.receivedCount,
            expectedCount: status.sync.expectedCount ?? prev.expectedCount,
          }));
          setRefreshing(false);
        } else if (status.sync.state === "failed") {
          setSync((prev) => ({ ...prev, active: false, error: "Parameter download failed." }));
          setRefreshing(false);
        } else if (++attempts >= 30) {
          setRefreshing(false);
        } else {
          window.setTimeout(poll, 500);
        }
      } catch {
        setRefreshing(false);
      }
    };
    window.setTimeout(poll, 750);
    return () => {
      cancelled = true;
    };
  }, [refreshing]);

  /* ---------------- socket wiring --------------------------------- */
  useEffect(() => {
    const onSession = (payload: SessionEvent) => {
      if (payload.connection === "disconnected") {
        setConnection("DISCONNECTED");
        setSessionId(null);
        setEntries({});
        setSync(IDLE_SYNC);
        setMetadataStatus(null);
        setGroups([]);
        setVehicleType(null);
        setLastUpdated(null);
        return;
      }
      setConnection("CONNECTING");
      setSessionId(payload.sessionId ?? null);
      if (payload.sessionId &&
          payload.sessionId !== sessionRef.current &&
          hydratedSessionRef.current !== payload.sessionId) {
        setEntries({});
        setSync({ ...IDLE_SYNC, active: true });
        // Any session we haven't hydrated yet (reconnect, and the server's
        // own resume-download sync:complete can stall) is re-pulled from the
        // authoritative REST snapshot — no browser reload required.
        scheduleRehydrate();
      }
    };

    const onSyncStart = (payload: SyncStartEvent) => {
      setConnection("SYNCING");
      setSync((prev) => ({
        ...IDLE_SYNC,
        active: true,
        expectedCount: payload.expectedCount ?? prev.expectedCount,
      }));
    };

    const onSyncProgress = (payload: SyncProgressEvent) => {
      setSync((prev) => ({
        ...prev,
        active: true,
        receivedCount: payload.receivedCount ?? prev.receivedCount,
        expectedCount: payload.expectedCount ?? prev.expectedCount,
      }));
    };

    const onSyncComplete = () => {
      setRefreshing(false);
      setSync((prev) => ({
        ...prev,
        active: false,
        complete: true,
      }));
      void rehydrate(); // authoritative merged snapshot post-download
    };

    const onSyncError = (payload: SyncErrorEvent) => {
      setConnection("ERROR");
      setRefreshing(false);
      setSync((prev) => ({
        ...prev,
        active: false,
        complete: false,
        error: payload.message ?? "Parameter synchronization failed.",
        missing: payload.missing ?? [],
      }));
      void rehydrate(); // partial data is still worth showing
    };

    const onUpdated = (payload: UpdatedEvent) => {
      setEntries((prev) =>
        mergeUpdated(prev, payload.id, payload.value, payload.type)
      );
      // Reconcile any staged edit for this parameter against the new live
      // value — always KEEP the staged value, only refresh live/conflict.
      setStaged((prev) => {
        const change = prev[payload.id];
        if (!change) return prev;
        const type = payload.type ?? null;
        const conflict = !valuesEqual(change.originalValue, payload.value, type);
        return {
          ...prev,
          [payload.id]: {
            ...change,
            liveValue: payload.value,
            conflict,
            conflictKind: conflict ? "EXTERNAL_LIVE_CHANGE" : "NONE",
          },
        };
      });
      setLastUpdated(Date.now());
    };

    const onMetadataStatus = (payload: MetadataStatus) => {
      if (payload && payload.status) setMetadataStatus(payload);
    };

    const onBatchWriteStart = (payload: BatchWriteStartEvent) => {
      setWritePhase("running");
      setWriteActiveTxnId(payload.transactionId ?? null);
      setWriteError(null);
      setWriteConflicts(null);
      setWriteProgress({
        completed: 0,
        total: payload.total ?? 0,
        currentParamId: null,
      });
    };

    const onBatchWriteProgress = (payload: BatchWriteProgressEvent) => {
      setWritePhase("running");
      setWriteProgress((prev) => ({
        completed: payload.completed ?? prev.completed,
        total: payload.total ?? prev.total,
        currentParamId: payload.currentParamId ?? prev.currentParamId,
      }));
    };

    const onBatchWriteItem = (payload: BatchWriteItemEvent) => {
      const paramId = payload.paramId;
      const verifiedValue = payload.verifiedValue;
      if (
        paramId &&
        payload.status === "success" &&
        typeof verifiedValue === "number"
      ) {
        setEntries((prev) => mergeUpdated(prev, paramId, verifiedValue));
      }
    };

    const onBatchWriteComplete = (payload: WriteTransactionSummary) => {
      if (!payload || !payload.transactionId) return;
      // The transaction is finished, so its id must not survive into the next
      // write request: a completed transactionId is not resumable and the
      // backend rejects it as a stale request. Only a still-active
      // transaction (WRITE_IN_PROGRESS) keeps its id for resumption.
      setWriteActiveTxnId(null);
      setWriteProgress({
        completed: payload.total - payload.notAttempted,
        total: payload.total,
        currentParamId: null,
      });
      setWriteSummary(payload);
      const phase: WritePhase =
        payload.status === "success"
          ? "success"
          : payload.status === "partial_failure"
            ? "partial_failure"
            : payload.status === "interrupted"
              ? "interrupted"
              : "error";
      setWritePhase(phase);
      if (phase === "error") {
        setWriteError({
          code: payload.interruptedReason ?? "WRITE_FAILED",
          message: "Parameter write did not complete.",
        });
      }
      clearSucceeded(payload.results);
      setEntries((prev) => {
        let next = prev;
        for (const r of payload.results) {
          if (r.status === "success" && typeof r.verifiedValue === "number") {
            next = mergeUpdated(next, r.paramId, r.verifiedValue);
          }
        }
        return next;
      });
    };

    const onWriteSuccess = (payload: WriteSingleEvent) => {
      const id = payload.id;
      const value = payload.value;
      if (id && typeof value === "number") {
        setEntries((prev) => mergeUpdated(prev, id, value));
      }
    };

    const onSessionChange = (payload: SessionEvent) => {
      // A write transaction started under a previous session must be
      // invalidated immediately (no cross-session writes).
      if (writeActiveTxnIdRef.current && payload.sessionId) {
        setWritePhase("interrupted");
        setWriteError({
          code: "SESSION_CHANGED",
          message: "The vehicle session changed. The write was interrupted.",
        });
        setWriteActiveTxnId(null);
        setWriteProgress(IDLE_WRITE_PROGRESS);
      }
    };

    const onResetStart = (payload: ResetStartEvent) => {
      setResetState((prev) => ({
        ...prev,
        active: true,
        state: prev.state === "idle" ? "backup" : prev.state,
        resetId: payload.resetId ?? prev.resetId,
        startedAt: payload.startedAt ?? prev.startedAt,
        error: null,
        summary: null,
        completedAt: null,
      }));
    };

    const onResetProgress = (payload: ResetProgressEvent) => {
      const summary = payload.summary ?? null;
      setResetState((prev) => {
        const terminal = payload.state === "complete" || payload.state === "failed";
        return {
          success: true,
          active: !terminal,
          resetId: payload.resetId ?? prev.resetId,
          state: (payload.state ?? prev.state) as ResetStatusView["state"],
          message: payload.message ?? prev.message,
          error: prev.error,
          summary: summary ?? prev.summary,
          startedAt: prev.startedAt,
          completedAt: terminal ? Date.now() / 1000 : prev.completedAt,
        };
      });
    };

    const onResetComplete = (summary: ResetSummary) => {
      setResetState((prev) => ({
        ...prev,
        active: false,
        state: "complete",
        message: "Reset complete. Parameters restored to factory defaults.",
        summary,
        completedAt: Date.now() / 1000,
      }));
    };

    const onResetError = (payload: ResetErrorEvent) => {
      setResetState((prev) => ({
        ...prev,
        success: false,
        active: false,
        state: payload.state === "failed" ? "failed" : prev.state,
        message: payload.message ?? prev.message,
        error: {
          code: payload.code ?? "RESET_FAILED",
          message: payload.message ?? "Parameter reset failed.",
        },
        completedAt: Date.now() / 1000,
      }));
    };

    socket.on("parameter:session", onSession);
    socket.on("parameter:sync:start", onSyncStart);
    socket.on("parameter:sync:progress", onSyncProgress);
    socket.on("parameter:sync:complete", onSyncComplete);
    socket.on("parameter:sync:error", onSyncError);
    socket.on("parameter:updated", onUpdated);
    socket.on("parameter:metadata:status", onMetadataStatus);
    socket.on("parameter:batch-write:start", onBatchWriteStart);
    socket.on("parameter:batch-write:progress", onBatchWriteProgress);
    socket.on("parameter:batch-write:item", onBatchWriteItem);
    socket.on("parameter:batch-write:complete", onBatchWriteComplete);
    socket.on("parameter:write:success", onWriteSuccess);
    socket.on("parameter:session", onSessionChange);
    socket.on("parameter:reset:start", onResetStart);
    socket.on("parameter:reset:progress", onResetProgress);
    socket.on("parameter:reset:complete", onResetComplete);
    socket.on("parameter:reset:error", onResetError);

    void rehydrate();

    return () => {
      socket.off("parameter:session", onSession);
      socket.off("parameter:sync:start", onSyncStart);
      socket.off("parameter:sync:progress", onSyncProgress);
      socket.off("parameter:sync:complete", onSyncComplete);
      socket.off("parameter:sync:error", onSyncError);
      socket.off("parameter:updated", onUpdated);
      socket.off("parameter:metadata:status", onMetadataStatus);
      socket.off("parameter:batch-write:start", onBatchWriteStart);
      socket.off("parameter:batch-write:progress", onBatchWriteProgress);
      socket.off("parameter:batch-write:item", onBatchWriteItem);
      socket.off("parameter:batch-write:complete", onBatchWriteComplete);
      socket.off("parameter:write:success", onWriteSuccess);
      socket.off("parameter:session", onSessionChange);
      socket.off("parameter:reset:start", onResetStart);
      socket.off("parameter:reset:progress", onResetProgress);
      socket.off("parameter:reset:complete", onResetComplete);
      socket.off("parameter:reset:error", onResetError);
      if (rehydrateTimerRef.current) clearTimeout(rehydrateTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshedAt = lastUpdated;

  /* ---------------- staged-change actions (Phase 4) ---------------- */

  const stageValue = useCallback(
    (paramId: string, value: number): StageResult => {
      const entry = entries[paramId];
      if (!entry) {
        return { ok: false, error: "Parameter is not loaded.", changed: false };
      }
      const validation = validateStagedValue(entry, value);
      if (!validation.valid) {
        return { ok: false, error: validation.message, changed: false };
      }
      // Uses the functional updater so a batch of stage requests (e.g. an
      // applied parameter file) accumulates against the LATEST staged map,
      // not the closure snapshot from this render.
      let result: StageResult = { ok: true, changed: false };
      setStaged((prev) => {
        const { next, result: r } = stageChange(prev, entry, value);
        result = r;
        if (r.changed) saveStaged(next);
        return next;
      });
      return result;
    },
    [entries]
  );

  const revert = useCallback((paramId: string) => {
    setStaged((prev) => {
      const { next, changed } = revertStaged(prev, paramId);
      if (changed) saveStaged(next);
      return next;
    });
  }, []);

  const discardAll = useCallback(() => {
    setStaged((prev) => {
      const { next, changed } = discardAllStaged(prev);
      if (changed) saveStaged(next);
      return next;
    });
  }, []);

  /* ---------------- write transaction (Phase 5) -------------------- */

  const resetWrite = useCallback(() => {
    setWritePhase("idle");
    setWriteProgress(IDLE_WRITE_PROGRESS);
    setWriteConflicts(null);
    setWriteError(null);
    setWriteSummary(null);
    setWriteActiveTxnId(null);
  }, []);

  /** Build the item snapshot from staged changes — the ONLY place React
      constructs a write request. No MAVLink code lives here; the backend
      is the single write authority. */
  const buildWriteItems = useCallback((): WriteItemInput[] => {
    return Object.values(staged).map((change) => ({
      paramId: change.paramId,
      value: change.stagedValue,
      originalValue: change.originalValue,
    }));
  }, [staged]);

  /** Clear exactly the parameters that were verified by the vehicle echo.
      Failed / not-attempted stays staged. Returns the ids that were cleared. */
  const clearSucceeded = useCallback(
    (results: WriteItemResult[]): string[] => {
      const cleared: string[] = [];
      setStaged((prev) => {
        let next = prev;
        for (const r of results) {
          if (r.status === "success") {
            const { next: after, changed } = revertStaged(next, r.paramId);
            if (changed) {
              next = after;
              cleared.push(r.paramId);
            }
          }
        }
        saveStaged(next);
        return next;
      });
      return cleared;
    },
    []
  );

  /** Executes the sequential verified write transaction.
      Returns the backend response so the UI can decide about conflicts. */
  const executeWrite = useCallback(
    async (
      acknowledged: string[] = []
    ): Promise<{
      ok: boolean;
      conflicts?: ParamConflict[];
    }> => {
      setWriteError(null);
      setWriteConflicts(null);
      const items = buildWriteItems();
      if (items.length === 0) {
        setWritePhase("error");
        setWriteError({ code: "BAD_REQUEST", message: "No staged parameters to write." });
        return { ok: false };
      }
      setWritePhase("running");
      setWriteProgress({ completed: 0, total: items.length, currentParamId: items[0]?.paramId ?? null });
      try {
        const view = await writeBatch(items, acknowledged, writeActiveTxnId ?? undefined);
        if ("conflicts" in view && view.conflicts) {
          setWritePhase("idle");
          setWriteConflicts(view.conflicts);
          return { ok: false, conflicts: view.conflicts };
        }
        if (!view.success) {
          const code = (view as { error?: WriteErrorInfo }).error?.code;
          const message = (view as { error?: WriteErrorInfo }).error?.message ?? "Parameter write failed.";
          if (code === "WRITE_IN_PROGRESS") {
            setWriteActiveTxnId(
              (view as { activeTransactionId?: string }).activeTransactionId ?? null
            );
          }
          setWritePhase("error");
          setWriteError({ code: code ?? "WRITE_FAILED", message });
          setWriteProgress(IDLE_WRITE_PROGRESS);
          return { ok: false };
        }
        const txn = view.transaction;
        // This transaction has finished, so it is no longer resumable. Keeping
        // the id would make the NEXT write send a completed transactionId,
        // which the backend correctly rejects as a stale write request. The id
        // is only needed to resume a transaction that is still active (the
        // WRITE_IN_PROGRESS branch above), so it is cleared here.
        setWriteActiveTxnId(null);
        setWriteProgress({
          completed: txn.total - txn.notAttempted,
          total: txn.total,
          currentParamId: null,
        });
        setWriteSummary(txn);
        const phase: WritePhase =
          txn.status === "success"
            ? "success"
            : txn.status === "partial_failure"
              ? "partial_failure"
              : txn.status === "interrupted"
                ? "interrupted"
                : "error";
        setWritePhase(phase);
        if (phase === "error") {
          setWriteError({
            code: txn.interruptedReason ?? "WRITE_FAILED",
            message: "Parameter write did not complete.",
          });
        }
        // Success items are verified by the vehicle echo -> clear staging.
        clearSucceeded(txn.results);
        // Update live values from the verified echoes.
        setEntries((prev) => {
          let next = prev;
          for (const r of txn.results) {
            if (r.status === "success" && typeof r.verifiedValue === "number") {
              next = mergeUpdated(next, r.paramId, r.verifiedValue);
            }
          }
          return next;
        });
        return { ok: phase === "success" };
      } catch (err) {
        setWritePhase("error");
        setWriteError({
          code: "NETWORK_ERROR",
          message: err instanceof Error ? err.message : "Write request failed.",
        });
        return { ok: false };
      }
    },
    [buildWriteItems, writeActiveTxnId, clearSucceeded]
  );

  /** Re-run the write after the user acknowledged the conflicts. */
  const acknowledgeAndWrite = useCallback(async () => {
    if (!writeConflicts) return;
    const ids = writeConflicts.map((c) => c.paramId);
    setWriteConflicts(null);
    await executeWrite(ids);
  }, [writeConflicts, executeWrite]);

  /** Begin the factory-default reset flow (backup -> reset -> reboot ->
      reconnect -> resync -> verify). Progress surfaces via socket events. */
  const startReset = useCallback(async () => {
    if (resetState.active) {
      return { ok: false as const, error: "A reset is already in progress." };
    }
    try {
      const view = await resetParameters(true);
      setResetState((prev) => ({
        ...prev,
        active: true,
        resetId: view.resetId,
        state: "backup",
        message: "Backing up current parameters.",
        error: null,
        summary: null,
        completedAt: null,
      }));
      return { ok: true as const };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The reset could not be started.";
      return { ok: false as const, error: message };
    }
  }, [resetState.active]);

  const value = useMemo(
    () => ({
      entries,
      count: countParams(entries),
      connection,
      sessionId,
      sync,
      metadataStatus,
      groups,
      vehicleType,
      lastUpdated: refreshedAt,
      refreshing,
      loading,
      loadError,
      staged,
      stagedCount: modifiedCount(staged),
      stageValue,
      revert,
      discardAll,
      writePhase,
      writeProgress,
      writeConflicts,
      writeError,
      writeSummary,
      writeActiveTxnId,
      executeWrite,
      acknowledgeAndWrite,
      resetWrite,
      resetState,
      startReset,
      rehydrate,
      refresh,
    }),
    [
      entries,
      connection,
      sessionId,
      sync,
      metadataStatus,
      groups,
      vehicleType,
      refreshedAt,
      refreshing,
      loading,
      loadError,
      staged,
      stageValue,
      revert,
      discardAll,
      writePhase,
      writeProgress,
      writeConflicts,
      writeError,
      writeSummary,
      writeActiveTxnId,
      executeWrite,
      acknowledgeAndWrite,
      resetWrite,
      resetState,
      startReset,
      rehydrate,
      refresh,
    ]
  );

  return value;
}

export type ParameterStore = ReturnType<typeof useParameterStore>;

const ParameterContext = createContext<ParameterStore | null>(null);

export function ParameterProvider({ children }: { children: ReactNode }) {
  return (
    <ParameterContext.Provider value={useParameterStore()}>
      {children}
    </ParameterContext.Provider>
  );
}

export function useParameters() {
  const context = useContext(ParameterContext);
  if (context === null) {
    throw new Error(
      "useParameters must be used inside ParameterProvider"
    );
  }
  return context as ParameterStore;
}