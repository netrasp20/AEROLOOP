import { AlertCircle, AlertTriangle, CheckCircle2, Cpu, Download, Loader, PackageX, RefreshCw, ShieldAlert, WifiOff, XCircle } from "lucide-react";

import { useTelemetry } from "../../hooks/useTelemetry";
import { useFirmwareInfo } from "../../hooks/useFirmwareInfo";
import { useCallback, useEffect, useState } from "react";
import {
  getBootloaderValidationStatus,
  prepareBootloaderIdentityValidation,
} from "../../api/setup";
import type {
  BootloaderValidationPrepareResult,
  BootloaderValidationStatus,
  FirmwareCatalogResult,
  FirmwareCompatibilityOutcome,
  FirmwareCurrent,
  FirmwareDownloadStatus,
  FirmwareInfo,
  FirmwareIntegrity,
  FirmwareRelease,
  FirmwareResolution,
  FirmwareSession,
} from "../../api/setup";

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="setup-page setup-firmware-page" data-testid="setup-firmware">
      <div className="setup-page-header">
        <h2 className="setup-page-title">Firmware</h2>
        <p className="setup-page-subtitle">Detected vehicle firmware and installation availability</p>
      </div>
      {children}
    </div>
  );
}

function ValueRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="setup-firmware-value-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function WorkflowPanel({ children }: { children: React.ReactNode }) {
  return (
    <section className="setup-firmware-workflow" data-testid="setup-firmware-workflow">
      {children}
    </section>
  );
}

const SELECTING_OUTCOMES: FirmwareCompatibilityOutcome[] = ["EXACT_MATCH", "CONFIRMED_COMPATIBLE"];

const OUTCOME_LABELS: Record<FirmwareCompatibilityOutcome, string> = {
  EXACT_MATCH: "Exact match",
  CONFIRMED_COMPATIBLE: "Confirmed compatible",
  AMBIGUOUS: "Ambiguous",
  UNSUPPORTED: "Unsupported",
  NO_MATCH: "No match",
  IDENTITY_UNAVAILABLE: "Identity unavailable",
  NO_DEVICE: "No device",
  UNKNOWN: "Unknown",
  UNAVAILABLE: "Catalogue unavailable",
};

function CompatibilityStatus({ outcome }: { outcome: FirmwareCompatibilityOutcome }) {
  return (
    <div className="setup-firmware-compatibility-status">
      <span>Compatibility</span>
      <strong className="setup-firmware-status" data-outcome={outcome}>
        <span className="setup-firmware-status-dot" aria-hidden="true" />
        {OUTCOME_LABELS[outcome]}
      </strong>
    </div>
  );
}

/** True when a real, uniquely resolved firmware target exists. */
function isConfident(resolution: FirmwareResolution | null | undefined): boolean {
  return (
    !!resolution &&
    SELECTING_OUTCOMES.includes(resolution.outcome) &&
    resolution.selected !== null
  );
}

function CurrentSummary({ current }: { current: FirmwareCurrent }) {
  return (
    <>
      <ValueRow label="Version" value={current.version ?? "Unavailable"} />
      <ValueRow label="Release" value={current.release ?? "Unavailable"} />
      <ValueRow
        label="Board"
        value={current.boardType !== undefined ? `${current.boardType}.${current.boardRev ?? 0}` : "Unavailable"}
      />
      <ValueRow label="Connection" value={current.connectionType ?? "Unavailable"} />
    </>
  );
}

/**
 * Phase 1 status plus the Phase 3 preparation action, shown only when
 * compatibility could not be resolved.
 *
 * The action is purely informational: it records what a bootloader identity
 * validation would need and displays the next requirement. It does NOT enter
 * bootloader mode, reboot, erase or flash anything.
 */
function BootloaderIdentityEvidence() {
  const [status, setStatus] = useState<BootloaderValidationStatus | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<BootloaderValidationPrepareResult | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(() => {
    getBootloaderValidationStatus()
      .then(setStatus)
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <p className="setup-firmware-note" data-testid="setup-firmware-bootloader-identity-error">
        Bootloader identity status could not be read.
      </p>
    );
  }
  if (!status) return null;

  const unknown = "Unavailable";
  const showAction = status.bootloaderIdentityAvailable === false;

  async function prepare() {
    setPreparing(true);
    setError(false);
    try {
      const result = await prepareBootloaderIdentityValidation();
      setPrepared(result);
      load();
    } catch {
      setError(true);
    } finally {
      setPreparing(false);
    }
  }

  return (
    <div className="setup-firmware-values" data-testid="setup-firmware-bootloader-identity">
      <p className="setup-firmware-note">
        Hardware identity evidence (read-only). Nothing on the board has been
        changed.
      </p>
      <ValueRow label="State" value={status.state} />
      <ValueRow label="Transport" value={status.transport} />
      <ValueRow
        label="MAVLink"
        value={status.mavlinkConnected ? "Connected" : "Disconnected"}
      />
      <ValueRow
        label="Bootloader identity"
        value={status.bootloaderIdentityAvailable ? "Available" : "Unavailable"}
      />
      <ValueRow label="Bootloader revision" value={status.bootloaderRevision ?? unknown} />
      <ValueRow label="Bootloader board ID" value={status.boardId ?? unknown} />
      <ValueRow label="Flash size" value={status.flashSize ?? unknown} />
      <ValueRow
        label="Bootloader USB product"
        value={status.bootloaderProductString ?? unknown}
      />
      <ValueRow label="USB VID/PID" value={status.usbId ?? unknown} />
      <ValueRow label="USB serial" value={status.usbSerialNumber ?? unknown} />
      <ValueRow label="USB product" value={status.usbProductString ?? unknown} />
      <ValueRow
        label="USB product is bootloader evidence"
        value={status.usbProductIsBootloaderEvidence ? "Yes" : "No"}
      />
      <ValueRow label="Board version" value={status.boardVersion ?? unknown} />
      <ValueRow label="Resolver outcome" value={status.resolver.outcome} />
      <ValueRow
        label="Installation"
        value={status.installationBlocked ? "Blocked" : "Available"}
      />

      {showAction && (
        <div data-testid="setup-firmware-bootloader-required">
          <p className="setup-firmware-note">
            A bootloader identity is required before any firmware can be chosen.
            Preparing this does not move the board into bootloader mode and does
            not write anything.
          </p>
          <button
            type="button"
            className="setup-firmware-note"
            data-testid="setup-firmware-bootloader-prepare"
            disabled={preparing || prepared !== null}
            onClick={prepare}
          >
            {preparing ? "Preparing…" : "Bootloader identity required"}
          </button>
        </div>
      )}

      {prepared !== null && (
        <div data-testid="setup-firmware-bootloader-prepared">
          <p className="setup-firmware-note">{prepared.message}</p>
          <p className="setup-firmware-note" data-testid="setup-firmware-next-requirement">
            {prepared.nextRequirement ?? prepared.reason ?? ""}
          </p>
        </div>
      )}

      {status.refusal !== "" && (
        <p className="setup-firmware-note" data-testid="setup-firmware-bootloader-refusal">
          {status.refusal}
        </p>
      )}
      {status.warnings.length > 0 && (
        <p className="setup-firmware-note" data-testid="setup-firmware-bootloader-warnings">
          {status.warnings.join(" ")}
        </p>
      )}
    </div>
  );
}

function AvailableFirmware({
  catalog,
  loading,
}: {
  catalog: FirmwareCatalogResult | null;
  loading: boolean;
}) {
  const resolution = catalog?.resolution ?? null;
  const selected = resolution?.selected ?? null;
  const confident = isConfident(resolution);

  if (!catalog) {
    return (
      <div className="setup-firmware-section" data-testid="setup-firmware-available">
        <h4>Available Firmware</h4>
        <p className="setup-firmware-unavailable" data-testid="setup-firmware-catalog-pending">
          {loading
            ? "Resolving firmware compatibility against the official catalogue..."
            : "Official firmware catalogue has not been retrieved."}
        </p>
      </div>
    );
  }

  if (catalog.catalog && catalog.catalog.available === false) {
    return (
      <div className="setup-firmware-section" data-testid="setup-firmware-available">
        <h4>Available Firmware</h4>
        <p className="setup-firmware-unavailable" data-testid="setup-firmware-catalog-unavailable">
          {catalog.catalog.message || "Firmware catalogue unavailable. No installable release can be selected."}
        </p>
      </div>
    );
  }

  if (!confident || !selected) {
    const outcome = resolution?.outcome ?? "UNKNOWN";
    return (
      <div className="setup-firmware-section" data-testid="setup-firmware-available">
        <h4>Available Firmware</h4>
        <CompatibilityStatus outcome={outcome} />
        <div className="setup-firmware-counts">
          <div className="setup-firmware-count">
            <strong>{resolution?.candidateCount ?? 0} image{resolution?.candidateCount === 1 ? "" : "s"}</strong>
            <span>Firmware candidates</span>
          </div>
          <div className="setup-firmware-count">
            <strong>{resolution?.platformCount ?? 0} distinct</strong>
            <span>Platforms</span>
          </div>
        </div>
        <p className="setup-firmware-unavailable" data-testid="setup-firmware-incompatible">
          Identity unavailable. Exact hardware compatibility cannot currently be
          proven. Installation remains blocked.
        </p>
        <p className="setup-firmware-note" data-testid="setup-firmware-incompatible-reason">
          {resolution?.reason}
        </p>
        {resolution?.crossCheck != null && !resolution.crossCheck.passed && (
          <p className="setup-firmware-note" data-testid="setup-firmware-cross-check">
            The catalogue match failed independent verification:{" "}
            {resolution.crossCheck.failedChecks.join(", ")}.
          </p>
        )}
        {resolution && resolution.platforms.length > 0 && (
          <p className="setup-firmware-note" data-testid="setup-firmware-ambiguous-platforms">
            Incompatible candidates: {resolution.platforms.join(", ")}
            {resolution.platformsTruncated ? ", ..." : ""}
          </p>
        )}
        <BootloaderIdentityEvidence />
        {catalog.catalog?.stale === true && (
          <p className="setup-firmware-note" data-testid="setup-firmware-catalog-stale">
            Catalogue served from a validated local cache (upstream unreachable).
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="setup-firmware-section" data-testid="setup-firmware-available">
      <h4>Available Firmware</h4>
      <CompatibilityStatus outcome={resolution!.outcome} />
      <div className="setup-firmware-values">
        <ValueRow label="Version" value={selected.versionStr || selected.version} />
        <ValueRow label="Release" value={selected.releaseType} />
        <ValueRow label="Platform" value={selected.platform} />
        <ValueRow label="Board ID" value={selected.boardId ?? "Unavailable"} />
        <ValueRow label="Manufacturer" value={selected.manufacturer || "Unavailable"} />
        <ValueRow label="Flash size" value={selected.imageSize ? `${selected.imageSize} bytes` : "Unavailable"} />
        {catalog.catalog?.stale === true && (
          <ValueRow label="Catalogue" value="Validated local cache (stale)" />
        )}
      </div>
    </div>
  );
}


/** Release-channel order and headings. Only channels actually present render. */
const CHANNELS: ReadonlyArray<{ type: string; label: string }> = [
  { type: "OFFICIAL", label: "Stable" },
  { type: "BETA", label: "Beta" },
  { type: "DEV", label: "Development" },
];

interface ReleaseGroup {
  type: string;
  label: string;
  releases: FirmwareRelease[];
}

/** Group the manifest's releases into their channels, keeping manifest order. */
function groupReleasesByChannel(releases: FirmwareRelease[]): ReleaseGroup[] {
  const byType = new Map<string, FirmwareRelease[]>();
  for (const release of releases) {
    const bucket = byType.get(release.releaseType);
    if (bucket) bucket.push(release);
    else byType.set(release.releaseType, [release]);
  }
  const groups: ReleaseGroup[] = [];
  for (const channel of CHANNELS) {
    const bucket = byType.get(channel.type);
    if (bucket && bucket.length > 0) {
      groups.push({ type: channel.type, label: channel.label, releases: bucket });
      byType.delete(channel.type);
    }
  }
  // Any channel the backend reports that is not one of the three known ones is
  // still shown, rather than silently dropped from a firmware list.
  for (const [type, bucket] of byType) {
    groups.push({ type, label: bucket[0]?.releaseLabel || type, releases: bucket });
  }
  return groups;
}

/** Real release rows from the official catalogue. Never invented. */
/** Wording for the four coarse download outcomes a client branches on. */
const DOWNLOAD_STATUS_LABELS: Record<FirmwareDownloadStatus, string> = {
  DOWNLOAD_VERIFIED: "Verified:",
  DOWNLOAD_VERIFICATION_FAILED: "Verification failed:",
  DOWNLOAD_FAILED: "Download failed:",
  TRANSFER_COMPLETE_ONLY: "Transfer complete, not verified:",
};

/** Colour class for the integrity line; never styles an unverified fetch as ok. */
function integrityTone(
  status: FirmwareDownloadStatus | undefined,
  integrity: FirmwareIntegrity | undefined
): string {
  if (status === "DOWNLOAD_VERIFIED") return "verified";
  if (status === "TRANSFER_COMPLETE_ONLY") return "unverified";
  if (status === "DOWNLOAD_VERIFICATION_FAILED") return "verification-failed";
  if (status === "DOWNLOAD_FAILED") return "failed";
  if (integrity === "VERIFICATION_FAILED") return "verification-failed";
  return "unverified";
}

function ReleaseList({
  releases,
  chosenId,
  onChoose,
  disabled,
}: {
  releases: FirmwareRelease[];
  chosenId: string | null;
  onChoose: (id: string) => void;
  disabled: boolean;
}) {
  if (releases.length === 0) return null;
  const groups = groupReleasesByChannel(releases);
  return (
    <div className="setup-firmware-section" data-testid="setup-firmware-releases">
      <h4>Available Versions</h4>
      {groups.map((group) => (
        <div
          key={group.type}
          className="setup-firmware-channel"
          data-testid={`setup-firmware-channel-${group.type}`}
        >
          <h5 className="setup-firmware-channel-title">{group.label}</h5>
          <div className="setup-firmware-release-list" role="radiogroup" aria-label={`${group.label} firmware versions`}>
            {group.releases.map((release) => {
              const isCurrent = release.isCurrent === true;
              const isSelected = chosenId === release.candidateId;
              return (
                <label
                  key={release.candidateId}
                  className="setup-firmware-option setup-firmware-release"
                  data-testid="setup-firmware-release"
                >
                  <input
                    type="radio"
                    name="firmware-release"
                    checked={isSelected}
                    disabled={disabled}
                    onChange={() => onChoose(release.candidateId)}
                    value={release.candidateId}
                  />
                  <span>
                    {release.versionStr || release.version} · {release.releaseLabel}
                    {release.latest ? " · latest" : ""}
                    {release.imageSize ? ` · ${release.imageSize} bytes` : ""}
                  </span>
                  <span
                    className="setup-firmware-release-target"
                    data-testid="setup-firmware-release-target"
                  >
                    {release.vehicle} · {release.platform}
                  </span>
                  {release.compatibility && (
                    <span
                      className={`setup-firmware-badge setup-firmware-badge-compat setup-firmware-badge-compat-${release.compatibility.status.toLowerCase()}`}
                      data-testid="setup-firmware-release-compatibility"
                      title={release.compatibility.reason}
                    >
                      {release.compatibility.status === "COMPATIBLE"
                        ? "Compatible"
                        : release.compatibility.status === "INCOMPATIBLE"
                          ? "Not compatible"
                          : "Compatibility unknown"}
                    </span>
                  )}
                  {isCurrent && (
                    <span
                      className="setup-firmware-badge setup-firmware-badge-current"
                      data-testid="setup-firmware-badge-current"
                    >
                      Current
                    </span>
                  )}
                  {/* Only one release can be selected, so a row that is neither
                      current nor chosen says so plainly. Labelling it
                      "Selected" in grey would claim a choice nobody made. */}
                  <span
                    className={`setup-firmware-badge setup-firmware-badge-${
                      isSelected ? "selected" : "available"
                    }`}
                    data-testid={
                      isSelected
                        ? "setup-firmware-badge-selected"
                        : "setup-firmware-badge-available"
                    }
                    aria-current={isSelected ? "true" : undefined}
                  >
                    {isSelected ? "Selected" : "Available"}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Backend-reported install state. Real progress or an indeterminate bar. */
function InstallationStatus({ session, installing }: { session: FirmwareSession | null; installing: boolean }) {
  if (!session && !installing) return null;
  const percent = session?.progress?.length
    ? session.progress[session.progress.length - 1].percent
    : null;
  const indeterminate = installing && percent === null;

  return (
    <div className="setup-firmware-section" data-testid="setup-firmware-install-status">
      <h4>Installation</h4>
      <div className="setup-firmware-values">
        <ValueRow label="State" value={session?.state ?? (installing ? "INSTALLING" : "Unknown")} />
        {session?.mode ? <ValueRow label="Mode" value={session.mode} /> : null}
        {session?.installedVersion ? (
          <ValueRow label="Reported version" value={session.installedVersion} />
        ) : null}
        {session ? (
          <ValueRow label="Verified" value={session.versionVerified ? "Yes" : "No"} />
        ) : null}
      </div>
      {indeterminate ? (
        <progress className="setup-firmware-progress" data-testid="setup-firmware-progress-indeterminate" />
      ) : (
        percent !== null && (
          <progress
            className="setup-firmware-progress"
            value={percent}
            max={100}
            data-testid="setup-firmware-progress"
          />
        )
      )}
      {session?.message ? (
        <p className="setup-firmware-note" data-testid="setup-firmware-install-message">
          {session.message}
        </p>
      ) : null}
    </div>
  );
}

export default function SetupFirmware() {
  const telemetry = useTelemetry();
  const {
    info,
    capability,
    catalog,
    confirmation,
    download,
    releases,
    chosenReleaseId,
    session,
    installing,
    loading,
    refreshing,
    refresh,
    confirm,
    prepareDownload,
    chooseRelease,
    startSimulation,
    cancel,
  } = useFirmwareInfo(telemetry.connected);

  const connecting = telemetry.connectionState === "CONNECTING";
  const lost = !telemetry.connected && telemetry.disconnectReason != null;

  if (!telemetry.connected) {
    return (
      <PageShell>
        <WorkflowPanel>
          {connecting ? <Loader size={22} className="setup-spinner" /> : lost ? <WifiOff size={22} /> : <Cpu size={22} />}
          <h3>Firmware Setup</h3>
          <p className="setup-firmware-workflow-title">
            {connecting ? (lost ? "Reconnecting to vehicle" : "Connecting to vehicle") : lost ? "Connection lost" : "No vehicle connected"}
          </p>
          <p className="setup-firmware-workflow-copy">
            {connecting
              ? "Establishing a MAVLink link. Firmware information will be re-queried automatically."
              : lost
                ? `Firmware information is unavailable until the vehicle reconnects. Reason: ${telemetry.disconnectReason}`
              : "Connect a supported MAVLink flight controller to identify its installed firmware."}
          </p>
          {!connecting ? (
            <>
              <p className="setup-firmware-warning" data-testid="setup-firmware-simulate-warning">
                With no flight controller attached there is no hardware identity to resolve
                compatibility against. The TEST/SIMULATION workflow below uses a clearly
                synthetic identity, contacts no vehicle and touches no hardware.
              </p>
              <div className="setup-firmware-actions">
                <button
                  type="button"
                  className="setup-firmware-action"
                  onClick={startSimulation}
                  disabled={installing}
                  data-testid="setup-firmware-simulate"
                >
                  Run TEST/SIMULATION workflow
                </button>
                {installing && (
                  <button
                    type="button"
                    className="setup-firmware-action"
                    onClick={cancel}
                    data-testid="setup-firmware-simulate-cancel"
                  >
                    Cancel
                  </button>
                )}
              </div>
              <InstallationStatus session={session} installing={installing} />
            </>
          ) : null}
        </WorkflowPanel>
      </PageShell>
    );
  }

  if (info === null) {
    return (
      <PageShell>
        <WorkflowPanel>
          <Loader size={22} className="setup-spinner" />
          <h3>Firmware Setup</h3>
          <p className="setup-firmware-workflow-copy" data-testid="setup-firmware-loading">
            {loading ? "Identifying the connected flight controller..." : "Detecting vehicle firmware..."}
          </p>
        </WorkflowPanel>
      </PageShell>
    );
  }

  const unsupported = info.success === true && info.supported === false;
  const failed = info.success !== true;
  const fw = info as FirmwareInfo & { success: true };
  const resolution = catalog?.resolution ?? null;
  const target = resolution?.selected ?? null;
  const canConfirm = isConfident(resolution);
  const confirmed = confirmation?.confirmed === true;
  const blocked = capability?.firmwareInstallation !== "available";

  if (failed || unsupported) {
    return (
      <PageShell>
        <WorkflowPanel>
          {unsupported ? <AlertTriangle size={22} /> : <AlertCircle size={22} />}
          <h3>Firmware Setup</h3>
          <p className="setup-firmware-workflow-title">
            {unsupported ? "Unsupported vehicle" : loading ? "Identifying firmware" : "Firmware information unavailable"}
          </p>
          <p className="setup-firmware-workflow-copy">
            {unsupported
              ? fw.unsupportedReason ?? "YantraYug Firmware Setup supports ArduCopter vehicles only."
              : loading ? "Requesting AUTOPILOT_VERSION from the connected controller..." : info.message ?? "Firmware information could not be retrieved."}
          </p>
          <button type="button" className="setup-firmware-action" onClick={refresh} disabled={loading} data-testid="setup-firmware-retry">
            <RefreshCw size={13} /> Retry
          </button>
        </WorkflowPanel>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="setup-firmware-layout">
        <WorkflowPanel>
          <h3>Firmware Setup</h3>
          <div className="setup-firmware-section setup-firmware-stack">
            <h4>Firmware Stack</h4>
            <label className="setup-firmware-option">
              <input type="radio" checked readOnly />
              <span>{fw.autopilotLabel ?? fw.autopilot ?? "Unavailable"} Flight Stack</span>
            </label>
          </div>

          <AvailableFirmware catalog={catalog} loading={loading} />

          <ReleaseList
            releases={releases}
            chosenId={chosenReleaseId}
            onChoose={chooseRelease}
            disabled={installing}
          />

          {canConfirm && target && !confirmed && (
            <section className="setup-firmware-section" data-testid="setup-firmware-confirmation">
              <h4>Confirm Firmware</h4>
              <div className="setup-firmware-values">
                <ValueRow label="Current" value={fw.version ?? "Unavailable"} />
                <ValueRow label="Target" value={target.versionStr || target.version} />
                <ValueRow label="Release" value={target.releaseType} />
                <ValueRow label="Board / platform" value={target.platform} />
              </div>
              <p className="setup-firmware-warning" data-testid="setup-firmware-confirm-warning">
                Firmware installation changes the flight-controller software.
              </p>
              <div className="setup-firmware-actions">
                <button
                  type="button"
                  className="setup-firmware-action"
                  onClick={confirm}
                  data-testid="setup-firmware-confirm"
                >
                  Confirm firmware selection
                </button>
              </div>
            </section>
          )}

          {confirmed && confirmation?.target && (
            <section className="setup-firmware-section" data-testid="setup-firmware-confirmed">
              <h4>Selection Confirmed</h4>
              <div className="setup-firmware-values">
                <ValueRow label="Current" value={confirmation.current?.version ?? "Unavailable"} />
                <ValueRow
                  label="Target"
                  value={confirmation.target.versionStr || confirmation.target.version}
                />
                <ValueRow label="Board / platform" value={confirmation.target.platform} />
              </div>
              <p className="setup-firmware-note" data-testid="setup-firmware-confirmed-note">
                {confirmation.message}
              </p>
            </section>
          )}

          {download && (
            <div data-testid="setup-firmware-download">
              <p className="setup-firmware-note">{download.message}</p>
              {download.downloadStatus && (
                <p
                  className={`setup-firmware-integrity setup-firmware-integrity-${integrityTone(download.downloadStatus, download.integrity)}`}
                  data-testid="setup-firmware-download-status"
                  data-status={download.downloadStatus}
                  data-integrity={download.integrity ?? ""}
                >
                  <strong>{DOWNLOAD_STATUS_LABELS[download.downloadStatus]}</strong>
                  {download.integrityNote ? ` ${download.integrityNote}` : ""}
                </p>
              )}
            </div>
          )}

          <InstallationStatus session={session} installing={installing} />

          {canConfirm && target && (
            <div className="setup-firmware-actions">
              <button
                type="button"
                className="setup-firmware-action"
                onClick={prepareDownload}
                data-testid="setup-firmware-download-prepare"
              >
                <Download size={13} /> Prepare download
              </button>
            </div>
          )}

          {installing && (
            <div className="setup-firmware-actions">
              <button
                type="button"
                className="setup-firmware-action"
                onClick={cancel}
                data-testid="setup-firmware-install-cancel"
              >
                Cancel
              </button>
            </div>
          )}

          <div className="setup-firmware-actions">
            <button type="button" className="setup-firmware-action" onClick={refresh} disabled={loading || refreshing} data-testid="setup-firmware-refresh">
              <RefreshCw size={13} /> Re-query
            </button>
          </div>
        </WorkflowPanel>

        <div className="setup-firmware-details">
          <section className="setup-firmware-current" data-testid="setup-firmware-card">
            <div className="setup-firmware-current-header">
              <h3>Current Firmware</h3>
            </div>
            <CurrentSummary
              current={{
                version: fw.version,
                release: fw.release,
                boardType: fw.boardType,
                boardRev: fw.boardRev,
                connectionType: fw.connectionType,
              }}
            />
          </section>

          <section className="setup-firmware-install" data-testid="setup-firmware-installation">
            {blocked ? <PackageX size={17} /> : <ShieldAlert size={17} />}
            <div>
              <strong>Firmware installation is blocked for real hardware.</strong>
              <p data-testid="setup-firmware-install-blocked">
                {capability?.installationMessage ??
                  "Firmware installation is currently disabled for real hardware validation."}
                {" The connected flight controller cannot be flashed. Any installation attempt is refused by the backend."}
              </p>
              {capability?.installation?.blockedOperations != null && (
                <p className="setup-firmware-note" data-testid="setup-firmware-blocked-operations">
                  Blocked operations: {capability.installation.blockedOperations.join(", ")}
                </p>
              )}
            </div>
            {session?.state === "COMPLETED" ? (
              <span className="setup-firmware-status" data-testid="setup-firmware-install-verified">
                <CheckCircle2 size={17} /> Verified {session.installedVersion}
              </span>
            ) : session && session.state !== "COMPLETED" && !installing ? (
              <span className="setup-firmware-status" data-testid="setup-firmware-install-refused">
                <XCircle size={17} /> {session.state}
              </span>
            ) : null}
          </section>

          <section className="setup-firmware-detected">
            <h3>Detected Pixhawk board</h3>
            <div className="setup-firmware-values">
              <ValueRow label="Status" value={loading ? "Identifying firmware" : "Ready · firmware identified"} />
              <ValueRow label="Board" value={fw.boardType !== undefined ? `${fw.boardType}.${fw.boardRev ?? 0}` : "Unavailable"} />
              <ValueRow label="Connection" value={fw.connectionType ?? "Unavailable"} />
              <ValueRow label="Vehicle" value={fw.vehicle ?? telemetry.vehicleType ?? "Unavailable"} />
              <ValueRow label="Autopilot" value={fw.autopilotLabel ?? fw.autopilot ?? "Unavailable"} />
              <ValueRow label="Firmware" value={fw.version ?? "Unavailable"} />
              <ValueRow label="Release" value={fw.release ?? "Unavailable"} />
              <ValueRow label="Custom build" value={fw.custom || "Unavailable"} />
              <ValueRow label="Vendor / product ID" value={fw.vendorId !== undefined && fw.productId !== undefined ? `${fw.vendorId} / ${fw.productId}` : "Unavailable"} />
            </div>
          </section>
        </div>
      </div>
    </PageShell>
  );
}
