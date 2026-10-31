"""REST handlers for /api/setup — YantraYug SETUP / Vehicle Configuration.

QGC-style Vehicle Setup page backend support for ArduCopter. Phase 8A exposes
firmware identification (AUTOPILOT_VERSION); later sub-phases add sensor
calibration, radio, power, safety, motors, etc. under this prefix.
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

router = APIRouter()


def _ok(data: Any = None) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"success": True}
    if data is not None:
        payload.update(data)
    return payload


class ConfirmationRequest(BaseModel):
    confirmed: bool = False
    candidateId: str | None = None


class DownloadRequest(BaseModel):
    candidateId: str | None = None


class VersionListRequest(BaseModel):
    refresh: bool = False


class InstallRequest(BaseModel):
    candidateId: str | None = None
    # ``confirmed`` is intentionally NOT honoured here. Confirmation is a
    # server-side record bound to one exact candidate; the client must have
    # called POST /firmware/confirmation for that candidate first.
    allowSimulation: bool = False
    # Run on a background worker so the client can poll real progress.
    asynchronous: bool = True
    failAt: str | None = None


class SimulationRequest(BaseModel):
    """Test-adapter scenario. Never touches a vehicle."""

    vehicle: str = "Copter"
    observedVersion: str | None = None
    #: The installer state to fail at, given either exactly as the installer
    #: names it (``"VERIFYING"``) or as the lower-case alias a caller would
    #: naturally write (``"verify"``). An unrecognised value raises rather than
    #: being ignored, because a fault injection that silently does nothing is
    #: worse than one that is refused: it makes a run look clean when nothing was
    #: actually exercised.
    failAt: str | None = None
    asynchronous: bool = True
    # Optional explicit selection; otherwise the most conservative official
    # release for this vehicle is used.
    candidateId: str | None = None
    # The explicit user action for this synthetic run. It is recorded
    # server-side against the exact candidate, so it cannot be skipped.
    confirmed: bool = False


def _installer_state_name(value: str | None) -> str | None:
    """Normalise a requested fault-injection point to an installer state name.

    Accepts any case of a real installer state name, with ``-`` or spaces written
    as ``_``, and rejects anything else. There is no abbreviation or alias: only
    ``WORKFLOW_STATES`` members are valid. Silently dropping an unrecognised name
    would let a caller believe a failure was injected at a step that never
    failed, and guessing at a near-miss would report a state the installer never
    reports.
    """
    if value is None or not value.strip():
        return None
    from services import firmware_install_service as install_svc

    wanted = value.strip().upper().replace("-", "_").replace(" ", "_")
    if wanted in install_svc.WORKFLOW_STATES:
        return wanted
    raise HTTPException(
        status_code=400,
        detail=(
            f"failAt must be one of the installer states "
            f"({', '.join(install_svc.WORKFLOW_STATES)}), not {value!r}."
        ),
    )


def _firmware_response(payload):
    """Return a firmware endpoint's body with the error taxonomy attached.

    Every firmware route goes through here so ``errorKind``/``errorMessage`` are
    present on every response -- including the successful ones, where the kind is
    ``None``. A client can therefore branch on one field for every firmware
    outcome instead of parsing messages.
    """
    from services import firmware_errors

    if isinstance(payload, dict):
        firmware_errors.annotate(payload)
    return JSONResponse(payload)


@router.get("/firmware")
def firmware():
    """Request AUTOPILOT_VERSION from the connected vehicle."""
    from services.setup_service import request_firmware_info

    return _firmware_response(request_firmware_info())


@router.get("/firmware/capability")
def firmware_capability():
    """Report which firmware operations YantraYug genuinely supports.

    Identification and the official release catalogue are live; installation is
    blocked by the backend safety gate, so it is reported unavailable rather
    than faked.
    """
    from services.setup_service import firmware_capability

    return _firmware_response(firmware_capability())


@router.get("/firmware/catalog")
def firmware_catalog_route(refresh: bool = False):
    """Official ArduPilot catalogue resolved against the live vehicle.

    Read-only: retrieves the real manifest, extracts active-channel candidates
    and runs the compatibility resolver. Never selects an image on board_id
    alone, and never installs anything.
    """
    from services.setup_service import firmware_catalog

    return _firmware_response(firmware_catalog(refresh=refresh))


@router.post("/firmware/confirmation")
def firmware_confirmation_route(body: ConfirmationRequest):
    """Confirmation state for the resolved firmware target.

    The target is re-resolved and re-validated against the live catalogue
    server-side, so a client cannot nominate its own (possibly wrong-board)
    image. When confirmed, the backend records that confirmation against the
    exact candidate id; download and install refuse to proceed without a
    matching record. Confirming never starts an installation.
    """
    from services.firmware_workflow_service import confirmation

    return _firmware_response(
        confirmation(confirmed=body.confirmed, candidate_id=body.candidateId)
    )


@router.post("/firmware/download")
def firmware_download_route(body: DownloadRequest):
    """Download and transfer-verify the confirmed firmware image.

    Requires a server-recorded confirmation for the exact candidate. Fetches
    the official artifact to a staging file and checks HTTP status,
    Content-Length completeness and computes a digest. The manifest publishes
    no artifact checksum, so the digest is reported but not verified. The file
    is never executed, uploaded or installed.
    """
    from services.firmware_workflow_service import download

    return _firmware_response(download(body.candidateId))


@router.get("/firmware/workflow")
def firmware_workflow_route():
    """Full authoritative workflow state for the Firmware page.

    Detection, current firmware identity, resolution outcome and the real
    available release list, all from the live vehicle and the official manifest.
    """
    from services.firmware_workflow_service import workflow

    return _firmware_response(workflow())


@router.get("/firmware/versions")
def firmware_versions_route(refresh: bool = False):
    """Real available releases for the resolved target, straight from the manifest."""
    from services.firmware_workflow_service import version_list

    return _firmware_response(version_list(refresh=refresh))


@router.get("/firmware/status")
def firmware_status_route():
    """Current installation state machine state."""
    from services.firmware_workflow_service import status

    return _firmware_response(status())


@router.get("/firmware/pre-install-checks")
def firmware_pre_install_checks_route(candidateId: Optional[str] = None):
    """Run every pre-install check against live state, without installing.

    Read-only: it changes nothing, downloads nothing and touches no hardware. It
    exists so exactly which checks passed or failed can be inspected before an
    installation is ever authorised.
    """
    from services.firmware_workflow_service import validate_pre_install

    result = validate_pre_install(candidateId)
    return _firmware_response({**result, "state": "READY" if result["ok"] else "BLOCKED"})


@router.get("/firmware/detection")
def firmware_detection_route():
    """Authoritative read-only detection, including the reported identity."""
    from services.firmware_workflow_service import detect

    return _firmware_response(detect(include_identity=True))


@router.get("/firmware/bootloader-identity")
def firmware_bootloader_identity_route():
    """Read-only bootloader identity, with every field it could not obtain.

    Returns the bootloader protocol fields (revision, board id, flash size,
    bootloader USB product string) alongside the USB descriptor identity
    (VID/PID, serial, product), the board identity from MAVLink, and the
    transport classification that decided whether a bootloader read was
    permitted at all.

    Strictly read-only. It never opens a port, never writes to a device, never
    reboots, and never enters bootloader mode; when the board is in normal
    MAVLink mode the bootloader fields are reported as ``null`` with the reason.
    """
    from services.bootloader_identity_service import read_bootloader_identity

    report = read_bootloader_identity().to_dict()
    report["state"] = "RESOLVED" if report["canResolvePlatform"] else "BLOCKED"
    return _firmware_response(report)


@router.get("/firmware/bootloader-validation/status")
def firmware_bootloader_validation_status_route():
    """Phase 1: a clear read-only description of the identity situation.

    Reports the transport, MAVLink connectivity, whether a bootloader identity
    is available, the bootloader revision / board id / flash size / product
    string if available, the USB VID/PID and serial, and the identity resolver's
    result. Fields that could not be obtained are reported as ``null`` with the
    reason; nothing is fabricated.

    Read-only: it performs no operation on the board and contacts no downloader.
    """
    from services.bootloader_validation_service import identity_status

    return _firmware_response(identity_status())


@router.post("/firmware/bootloader-validation/prepare")
def firmware_bootloader_validation_prepare_route():
    """Phase 3: prepare an explicit, separately controlled validation.

    Verifies a device is connected, captures the connection fingerprint, the
    current firmware identity and the USB identity, marks the workflow as
    awaiting a bootloader identity, and invalidates stale identity data.

    It deliberately does **not** reboot, erase, flash, change a parameter, or
    command an actuator, and it does not move the board into bootloader mode.
    It only records what a future validation would require.
    """
    from services.bootloader_validation_service import (
        prepare_bootloader_identity_validation,
    )

    return _firmware_response(prepare_bootloader_identity_validation())


@router.post("/firmware/bootloader-validation/cancel")
def firmware_bootloader_validation_cancel_route():
    """Abandon a prepared validation and drop its captured identity data.

    Read-only with respect to the board: it only forgets what was recorded.
    """
    from services.bootloader_validation_service import SERVICE

    return _firmware_response(SERVICE.cancel())


@router.post("/firmware/install")
def firmware_install_route(body: InstallRequest):
    """Run the installation workflow against the connected vehicle.

    On a physical board this is refused truthfully and *before* any download: the
    real installer is permanently gated and no flashing command is sent. The
    endpoint exists so the refusal is a real answer rather than a 404.

    Confirmation is enforced by the backend; ``body.confirmed`` is not honoured.
    By default the workflow runs on a background worker so the client can poll
    ``GET /firmware/status`` for real progress.
    """
    from services.firmware_workflow_service import run_install, start_install

    if body.asynchronous:
        return _firmware_response(
            start_install(
                body.candidateId,
                allow_simulation=body.allowSimulation,
                fail_at=body.failAt,
            )
        )
    return _firmware_response(
        run_install(
            body.candidateId,
            allow_simulation=body.allowSimulation,
            fail_at=body.failAt,
        )
    )


@router.post("/firmware/simulate")
def firmware_simulate_route(body: SimulationRequest):
    """Run the whole pipeline through the TEST/SIMULATION installer.

    Uses a clearly synthetic vehicle identity, so the full workflow is walkable
    with no board attached. The artifact, its digest and the target version all
    come from the real official manifest; no vehicle is contacted, no port is
    opened and ``hardwareTouched`` stays ``False``.
    """
    from services.firmware_workflow_service import simulate_installation, start_simulation

    fail_at = _installer_state_name(body.failAt)
    if body.asynchronous:
        return _firmware_response(
            start_simulation(
                vehicle=body.vehicle,
                observed_version=body.observedVersion,
                fail_at=fail_at,
                candidate_id=body.candidateId,
                confirmed=body.confirmed,
            )
        )
    return _firmware_response(
        simulate_installation(
            vehicle=body.vehicle,
            observed_version=body.observedVersion,
            fail_at=fail_at,
            candidate_id=body.candidateId,
            confirmed=body.confirmed,
        )
    )


@router.post("/firmware/cancel")
def firmware_cancel_route():
    """Cancel the workflow."""
    from services.firmware_workflow_service import cancel_install

    return _firmware_response(cancel_install())



# ------------------------------------------------------------------
# Accelerometer 6-position calibration
# ------------------------------------------------------------------

class AccelCalPositionRequest(BaseModel):
    position: int


@router.post("/accel-cal/start")
def accel_cal_start():
    """Start the interactive 6-position accelerometer calibration."""
    from services.calibration_service import start_accel_calibration

    result = start_accel_calibration()
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


@router.post("/accel-cal/confirm")
def accel_cal_confirm(body: AccelCalPositionRequest):
    """Confirm the vehicle is in the requested orientation for sampling."""
    from services.calibration_service import confirm_accel_position

    result = confirm_accel_position(body.position)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


@router.post("/accel-cal/cancel")
def accel_cal_cancel():
    """Cancel the accelerometer calibration wizard (GCS side)."""
    from services.calibration_service import cancel_accel_calibration

    result = cancel_accel_calibration()
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


@router.get("/accel-cal/status")
def accel_cal_status():
    """Report the current calibration wizard state."""
    from services.calibration_service import get_calibration_status

    return JSONResponse({"success": True, **get_calibration_status()})


# ------------------------------------------------------------------
# Gyro / Barometer / Level Horizon calibration
# ------------------------------------------------------------------

@router.post("/gyro-cal")
def gyro_cal():
    """Run gyroscope calibration (MAV_CMD_PREFLIGHT_CALIBRATION param1)."""
    from services.calibration_service import gyro_calibrate

    result = gyro_calibrate()
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


@router.post("/baro-cal")
def baro_cal():
    """Run barometer (ground pressure) calibration."""
    from services.calibration_service import baro_calibrate

    result = baro_calibrate()
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


@router.post("/level-cal")
def level_cal():
    """Run Level Horizon calibration (separate from 6-position accel)."""
    from services.calibration_service import level_horizon_calibrate

    result = level_horizon_calibrate()
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


# ------------------------------------------------------------------
# Compass (magnetometer) calibration
# ------------------------------------------------------------------

class CompassCalRequest(BaseModel):
    mask: int = 0


@router.post("/compass-cal/start")
def compass_cal_start(body: CompassCalRequest):
    """Start magnetometer calibration for the given compass mask (0 = all)."""
    from services.calibration_service import start_compass_calibration

    result = start_compass_calibration(mask=body.mask)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


@router.post("/compass-cal/accept")
def compass_cal_accept(body: CompassCalRequest):
    """Accept and save the finished magnetometer calibration."""
    from services.calibration_service import accept_compass_calibration

    result = accept_compass_calibration(mask=body.mask)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


@router.post("/compass-cal/cancel")
def compass_cal_cancel(body: CompassCalRequest):
    """Cancel the running magnetometer calibration."""
    from services.calibration_service import cancel_compass_calibration

    result = cancel_compass_calibration(mask=body.mask)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


@router.get("/compass-cal/status")
def compass_cal_status():
    """Report the current compass calibration state."""
    from services.calibration_service import get_compass_calibration_status

    return JSONResponse({"success": True, **get_compass_calibration_status()})


@router.get("/compass/configuration")
def compass_configuration():
    """Enumerate every detected compass + flight controller orientation.

    Reports only devices the vehicle actually exposes (COMPASS_DEV_IDn != 0)
    plus the live AHRS_ORIENTATION value, so the UI renders genuine state.
    """
    from services.calibration_service import get_compass_configuration

    return JSONResponse({"success": True, **get_compass_configuration()})


# ------------------------------------------------------------------
# CompassMot (motor interference test)
# ------------------------------------------------------------------

class CompassMotRequest(BaseModel):
    motor: int = 0
    throttle: int = 30


@router.get("/compassmot/capability")
def compassmot_capability():
    """Capability detection: supported / enabled / running state."""
    from services.calibration_service import compassmot_capability

    return JSONResponse({"success": True, **compassmot_capability()})


@router.post("/compassmot/start")
def compassmot_start(body: CompassMotRequest):
    """Start a bounded motor-interference ramp (hardware measurement required)."""
    from services.calibration_service import conduct_compassmot_test

    result = conduct_compassmot_test(motor_instance=body.motor, throttle_pct=body.throttle)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


@router.post("/compassmot/cancel")
def compassmot_cancel():
    """Stop the CompassMot test locally (ArduPilot has no MAVLink abort)."""
    from services.calibration_service import cancel_compassmot_test

    result = cancel_compassmot_test()
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse(result)


@router.get("/compassmot/status")
def compassmot_status():
    """Live throttle / interference state from the vehicle stream."""
    from services.calibration_service import get_compassmot_status

    return JSONResponse({"success": True, **get_compassmot_status()})


# ------------------------------------------------------------------
# Sensor status (real param readback from the vehicle)
# ------------------------------------------------------------------

@router.get("/sensors/status")
def sensors_status():
    """Return the actual calibration parameter values for each sensor."""
    from services.calibration_service import get_sensor_status

    return JSONResponse({"success": True, **get_sensor_status()})


# ------------------------------------------------------------------
# Setup Summary (QGC-style configuration status matrix)
# ------------------------------------------------------------------

@router.get("/summary")
def summary():
    """Return the live Setup Summary capability matrix.

    Tones: good / warn / unsupported (sync complete + param genuinely absent)
    / unknown (waiting for parameter sync). Never fabricated — derived from
    the downloaded PARAM_VALUE cache, the live identity and the real sensor
    calibration parameters.
    """
    from services.setup_summary_service import get_setup_summary

    return JSONResponse(get_setup_summary())


# ------------------------------------------------------------------
# Radio (Channel monitor + calibration)
# ------------------------------------------------------------------

@router.get("/radio")
def radio_info():
    """Live Radio page snapshot.

    Channel monitor values are the real RC_CHANNELS telemetry on the vehicle;
    channel configuration (MIN/TRIM/MAX/REVERSED) and the main control mapping
    come from the genuine ArduPilot parameter cache. Never synthesized.
    """
    from services.radio_service import get_radio_info

    return JSONResponse(get_radio_info())


class RadioCalibrationCaptureRequest(BaseModel):
    phase: str


@router.post("/radio/calibration/start")
def radio_calibration_start():
    """Begin the radio calibration wizard (requires a live RC signal)."""
    from services.radio_calibration import start_radio_calibration

    result = start_radio_calibration()
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse({"success": True, **result})


@router.post("/radio/calibration/capture")
def radio_calibration_capture(body: RadioCalibrationCaptureRequest):
    """Run one capture phase (center / min / max) from real RC frames."""
    from services.radio_calibration import capture_radio_phase

    result = capture_radio_phase(body.phase)
    if not result["success"]:
        raise HTTPException(status_code=400, detail=result["message"])
    return JSONResponse({"success": True, **result})


@router.post("/radio/calibration/cancel")
def radio_calibration_cancel():
    """Cancel a running radio calibration across the wizard."""
    from services.radio_calibration import cancel_radio_calibration

    result = cancel_radio_calibration()
    return JSONResponse({"success": True, **result})


@router.get("/radio/calibration/status")
def radio_calibration_status():
    """Report the current radio calibration wizard state."""
    from services.radio_calibration import get_calibration_machine_status

    return JSONResponse({"success": True, **get_calibration_machine_status()})


# ------------------------------------------------------------------
# Power Setup (Phase 8F — ArduCopter / Pixhawk)
# ------------------------------------------------------------------

class VoltageMultiplierCalcRequest(BaseModel):
    currentMultiplier: float
    measuredVoltage: float
    sensorVoltage: float


class AmpsPerVoltCalcRequest(BaseModel):
    currentAmpsPerVolt: float
    measuredCurrent: float
    sensorCurrent: float


@router.get("/power")
def power_info():
    """Live Power Setup page snapshot."""
    from services.power_service import get_power_info

    return JSONResponse(get_power_info())


@router.get("/power/telemetry")
def power_telemetry():
    """Live battery telemetry snapshot for all instances."""
    from mavlink.telemetry_manager import get_battery_telemetry_snapshot

    return JSONResponse(get_battery_telemetry_snapshot())


@router.post("/power/calculate-voltage-multiplier")
def power_calculate_voltage_multiplier(body: VoltageMultiplierCalcRequest):
    """Calculate new voltage multiplier from physical multimeter reading."""
    from services.power_service import calculate_voltage_multiplier

    result = calculate_voltage_multiplier(
        body.currentMultiplier,
        body.measuredVoltage,
        body.sensorVoltage,
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("message", "Calculation failed"))
    return JSONResponse(result)


@router.post("/power/calculate-amps-per-volt")
def power_calculate_amps_per_volt(body: AmpsPerVoltCalcRequest):
    """Calculate new amps-per-volt from physical current measurement."""
    from services.power_service import calculate_amps_per_volt

    result = calculate_amps_per_volt(
        body.currentAmpsPerVolt,
        body.measuredCurrent,
        body.sensorCurrent,
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("message", "Calculation failed"))
    return JSONResponse(result)


# ------------------------------------------------------------------
# Safety (Phase 8G) — QGC-style Safety Setup for ArduCopter
# ------------------------------------------------------------------

@router.get("/safety")
def safety_info():
    """Live Safety Setup page snapshot (read-only derive from real params)."""
    from services.safety_service import get_safety_info

    return JSONResponse(get_safety_info())


# ------------------------------------------------------------------
# Motors / servo outputs / ESC (Phase 8H, strictly read-only)
# ------------------------------------------------------------------

@router.get("/motors")
def motors_info():
    from services.motor_setup_service import get_motor_setup
    return JSONResponse(get_motor_setup("motors"))


@router.get("/servo-outputs")
def servo_outputs_info():
    from services.motor_setup_service import get_motor_setup
    return JSONResponse(get_motor_setup("servo-outputs"))


@router.get("/esc")
def esc_info():
    from services.motor_setup_service import get_motor_setup
    return JSONResponse(get_motor_setup("esc"))


# ------------------------------------------------------------------
# Motors — functional motor testing (Phase 8H, ArduCopter, SITL-only)
#
# Read-only discovery above stays untouched. These routes drive the existing
# MAVLink command path and parameter manager; every actuator path is gated on a
# positive SITL identification inside motor_test_service (physical hardware is
# read-only regardless of what the UI sends).
# ------------------------------------------------------------------

class MotorTestRequest(BaseModel):
    motor: int
    throttlePct: float | None = None
    timeoutS: int | None = None


class MotorReverseRequest(BaseModel):
    motor: int
    reversed: bool


@router.get("/motors/test")
def motor_test_state():
    from services.motor_test_service import snapshot
    return JSONResponse(snapshot())


@router.post("/motors/test")
def motor_test_start(body: MotorTestRequest):
    from services.motor_test_service import start_test
    return JSONResponse(start_test(body.motor, body.throttlePct, body.timeoutS))


@router.post("/motors/test/stop")
def motor_test_stop():
    from services.motor_test_service import stop_test
    return JSONResponse(stop_test())


@router.get("/motors/reverse")
def motor_reverse_states():
    from services.motor_test_service import reverse_states
    return JSONResponse({"success": True, "outputs": reverse_states()})


@router.post("/motors/reverse")
def motor_reverse_set(body: MotorReverseRequest):
    from services.motor_test_service import set_reverse
    return JSONResponse(set_reverse(body.motor, body.reversed))


# ------------------------------------------------------------------
# Logging / Scripting (Phase 8I)
#
# Capability-driven and ArduCopter-only. Every payload is derived from the live
# vehicle (real LOG_ENTRY frames and the downloaded PARAM_VALUE cache).
# ------------------------------------------------------------------

@router.get("/logging")
def logging_info():
    from services.logging_service import get_logging_setup
    return JSONResponse(get_logging_setup())


@router.get("/scripting")
def scripting_info():
    from services.scripting_service import get_scripting_setup
    return JSONResponse(get_scripting_setup())
