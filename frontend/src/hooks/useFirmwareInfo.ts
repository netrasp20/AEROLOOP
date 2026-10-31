import { useCallback, useEffect, useRef, useState } from "react";

import {
  getFirmwareCapability,
  getFirmwareCatalog,
  getFirmwareInfo,
  getFirmwareInstallStatus,
  getFirmwareWorkflow,
  postFirmwareCancel,
  postFirmwareConfirmation,
  postFirmwareDownload,
  postFirmwareInstall,
  postFirmwareSimulation,
  type FirmwareCapability,
  type FirmwareCatalogResult,
  type FirmwareConfirmation,
  type FirmwareDownloadResult,
  type FirmwareInfo,
  type FirmwareRelease,
  type FirmwareSession,
  type FirmwareWorkflowResult,
} from "../api/setup";

interface UseFirmwareInfoResult {
  info: FirmwareInfo | null;
  capability: FirmwareCapability | null;
  catalog: FirmwareCatalogResult | null;
  confirmation: FirmwareConfirmation | null;
  download: FirmwareDownloadResult | null;
  workflow: FirmwareWorkflowResult | null;
  releases: FirmwareRelease[];
  chosenReleaseId: string | null;
  session: FirmwareSession | null;
  installing: boolean;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
  confirm: () => void;
  prepareDownload: () => void;
  chooseRelease: (candidateId: string) => void;
  startInstall: () => void;
  startSimulation: () => void;
  cancel: () => void;
}

const unavailableCapability: FirmwareCapability = {
  firmwareIdentification: "available",
  firmwareInstallation: "not-available",
  releaseCatalog: "unavailable",
  supportedTargets: [{ flightStack: "ArduPilot", vehicle: "Copter" }],
  installationMessage: "Firmware installation is currently disabled for real hardware validation.",
  identificationMessage: "Firmware identification available.",
  catalogMessage: "Firmware catalog unavailable.",
};

/**
 * Fetch AUTOPILOT_VERSION-backed firmware info, the capability report and the
 * official ArduPilot catalogue resolved against the live vehicle.
 *
 * The catalogue is only requested once the vehicle identity has actually been
 * obtained, so the page never resolves compatibility against a guessed board.
 * Re-runs when `enabled` flips (connect -> query, disconnect -> clear).
 *
 * The backend owns the workflow state machine; this hook mirrors it and never
 * invents a state. A selection, download or install result is discarded when the
 * request id no longer matches, so a stale response can never resurrect a
 * previous vehicle's confirmation.
 */
export function useFirmwareInfo(enabled: boolean): UseFirmwareInfoResult {
  const [info, setInfo] = useState<FirmwareInfo | null>(null);
  const [capability, setCapability] = useState<FirmwareCapability | null>(null);
  const [catalog, setCatalog] = useState<FirmwareCatalogResult | null>(null);
  const [confirmation, setConfirmation] = useState<FirmwareConfirmation | null>(null);
  const [download, setDownload] = useState<FirmwareDownloadResult | null>(null);
  const [workflow, setWorkflow] = useState<FirmwareWorkflowResult | null>(null);
  const [releases, setReleases] = useState<FirmwareRelease[]>([]);
  const [chosenReleaseId, setChosenReleaseId] = useState<string | null>(null);
  const [session, setSession] = useState<FirmwareSession | null>(null);
  const [installing, setInstalling] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);
  // Identity-dependent work (info, catalogue, confirmation, real install) is
  // gated on a connected vehicle. The synthetic simulation workflow is not:
  // it is the only firmware path the backend permits with nothing attached.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const connectedRef = useRef(enabled);
  connectedRef.current = enabled;
  const identified = useRef(false);
  identified.current = info?.success === true;

  const clearAll = useCallback(() => {
    setInfo(null);
    setCapability(null);
    setCatalog(null);
    setConfirmation(null);
    setDownload(null);
    setWorkflow(null);
    setReleases([]);
    setChosenReleaseId(null);
    setSession(null);
    setInstalling(false);
    setLoading(false);
    setRefreshing(false);
  }, []);

  const load = useCallback(
    async (forceCatalogRefresh = false) => {
      const currentRequest = ++requestId.current;
      if (!enabled) {
        clearAll();
        return;
      }
      // A previous selection belongs to the previous identity/catalog result.
      setConfirmation(null);
      setDownload(null);
      setInstalling(false);
      if (forceCatalogRefresh) setRefreshing(true);
      else setLoading(true);
      try {
        const [firmwareResult, capabilityResult] = await Promise.allSettled([
          getFirmwareInfo(),
          getFirmwareCapability(),
        ]);
        if (currentRequest !== requestId.current) return;

        const firmwareInfo =
          firmwareResult.status === "fulfilled"
            ? firmwareResult.value
            : ({ success: false, message: "Firmware info request failed." } as FirmwareInfo);
        setInfo(firmwareInfo);
        // Capability is always honest: if it cannot be reached the page falls
        // back to the "unavailable" report rather than pretending support.
        setCapability(
          capabilityResult.status === "fulfilled"
            ? capabilityResult.value
            : unavailableCapability
        );

        // Only resolve compatibility once a real identity is in hand.
        if (firmwareInfo.success === true) {
          try {
            const [catalogResult, workflowResult] = await Promise.all([
              getFirmwareCatalog(forceCatalogRefresh),
              getFirmwareWorkflow(),
            ]);
            if (currentRequest !== requestId.current) return;
            setCatalog(catalogResult);
            setWorkflow(workflowResult);
            // The authoritative session travels with the workflow, so a page
            // loaded or refreshed mid-installation shows the real state instead
            // of an empty panel. A session the backend omits clears the panel
            // rather than leaving a stale one from a previous request.
            setSession(workflowResult.session ?? null);
            const realReleases = workflowResult.releases ?? [];
            setReleases(realReleases);
            // Conservative default: the backend's own safe choice, never a dev build.
            setChosenReleaseId(workflowResult.defaultCandidateId ?? realReleases[0]?.candidateId ?? null);
          } catch {
            if (currentRequest === requestId.current) {
              setCatalog(null);
              setWorkflow(null);
              setReleases([]);
            }
          }
        } else {
          setCatalog(null);
          setWorkflow(null);
          setReleases([]);
        }
      } finally {
        if (currentRequest === requestId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [clearAll, enabled]
  );

  useEffect(() => {
    if (!enabled) {
      clearAll();
      identified.current = false;
      requestId.current += 1;
      return;
    }

    void load();
    // AUTOPILOT_VERSION may not arrive on the first request after a link is
    // established. Retry failed identification while connected; successful
    // identification is refreshed only by the user's explicit Re-query.
    const timer = window.setInterval(() => {
      if (!identified.current) void load();
    }, 6000);
    return () => window.clearInterval(timer);
  }, [enabled, load, clearAll]);

  const confirm = useCallback(() => {
    const currentRequest = requestId.current;
    void (async () => {
      try {
        // Confirm the exact candidate that is currently chosen. The backend
        // binds its record to that id and re-validates it, so a confirmation
        // can never be reused for a different image.
        const result = await postFirmwareConfirmation(true, chosenReleaseId ?? undefined);
        if (connectedRef.current && currentRequest === requestId.current) setConfirmation(result);
      } catch {
        if (connectedRef.current && currentRequest === requestId.current) setConfirmation(null);
      }
    })();
  }, [chosenReleaseId]);

  const prepareDownload = useCallback(() => {
    const currentRequest = requestId.current;
    void (async () => {
      try {
        const result = await postFirmwareDownload(chosenReleaseId ?? undefined);
        if (connectedRef.current && currentRequest === requestId.current) setDownload(result);
      } catch {
        if (connectedRef.current && currentRequest === requestId.current) setDownload(null);
      }
    })();
  }, [chosenReleaseId]);

  const chooseRelease = useCallback((candidateId: string) => {
    setChosenReleaseId(candidateId);
    // A new target invalidates the previous confirmation and download.
    setConfirmation(null);
    setDownload(null);
  }, []);

  /**
   * Poll the authoritative backend session while an installation or simulation
   * is in flight. Progress is never invented locally: every entry comes from the
   * server's own state machine.
   */
  useEffect(() => {
    if (!installing) return;
    const poll = async () => {
      try {
        const status = await getFirmwareInstallStatus();
        setSession(status);
        if (status.terminal === true) setInstalling(false);
      } catch {
        // Keep polling; a transient status failure must not fake a terminal state.
      }
    };
    const timer = window.setInterval(() => void poll(), 1200);
    return () => window.clearInterval(timer);
  }, [installing]);

  const startInstall = useCallback(() => {
    const currentRequest = requestId.current;
    setInstalling(true);
    void (async () => {
      try {
        // With a board attached this reaches the permanently gated real
        // installer; it never flashes, it reports the refusal.
        const result = await postFirmwareInstall(chosenReleaseId ?? undefined, false, true);
        if (!connectedRef.current || currentRequest !== requestId.current) return;
        setSession(result);
        // A refusal that is already terminal needs no polling.
        if (result.terminal === true) setInstalling(false);
      } catch {
        if (connectedRef.current && currentRequest === requestId.current) {
          setSession({
            success: false,
            state: "FAILED",
            mode: "TEST / SIMULATION",
            isSimulation: true,
            hardwareTouched: false,
            versionVerified: false,
            message: "The installation request could not be completed.",
            error: "request-failed",
            progress: [],
            history: [],
            terminal: true,
            realInstallationAllowed: false,
            realInstallationRefusal:
              "Firmware installation is currently disabled for real hardware validation.",
            blockedOperations: [],
          });
          setInstalling(false);
        }
      }
    })();
  }, [chosenReleaseId]);

  const startSimulation = useCallback(() => {
    setInstalling(true);
    void (async () => {
      try {
        // Deliberately not gated on a connected vehicle: this is the one path
        // the backend allows with nothing attached. ``confirmed`` is the
        // explicit user action for this synthetic run, recorded server-side
        // against the exact candidate.
        const vehicle = info?.vehicle ?? "Copter";
        const result = await postFirmwareSimulation({
          vehicle,
          confirmed: true,
          asynchronous: true,
        });
        setSession(result);
        if (result.terminal === true) setInstalling(false);
      } catch {
        setInstalling(false);
      }
    })();
  }, [info]);

  const cancel = useCallback(() => {
    void (async () => {
      try {
        setSession(await postFirmwareCancel());
      } catch {
        // Cancellation is best-effort; never fake a cancelled state.
      }
    })();
  }, []);

  return {
    info,
    capability,
    catalog,
    confirmation,
    download,
    workflow,
    releases,
    chosenReleaseId,
    session,
    installing,
    loading,
    refreshing,
    refresh: () => void load(true),
    confirm,
    prepareDownload,
    chooseRelease,
    startInstall,
    startSimulation,
    cancel,
  };
}
