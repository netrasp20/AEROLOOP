import AircraftSymbol from "./AircraftSymbol";
import HeadingTape from "./HeadingTape";
import RollArc from "./RollArc";
import PitchLadder from "./PitchLadder";
import SpeedTape from "./SpeedTape";
import AltitudeTape from "./AltitudeTape";
import { useTelemetry } from "../../providers/TelemetryProvider";
import { radToDeg } from "../../utils/units";

const PITCH_SCALE = 4;
const VW = 400;
const VH = 300;
const CX = 200;
const CY = 150;
const HORIZON_Y = 150;

function ArtificialHorizon() {
    const telemetry = useTelemetry();
    const rollAngle = radToDeg(telemetry.roll);
    const pitchOffset = radToDeg(telemetry.pitch) * PITCH_SCALE;

    return (
        <div className="horizon">
            <HeadingTape />
            <SpeedTape speed={telemetry.groundSpeed} />
            <AltitudeTape altitude={telemetry.relativeAltitude} />

            <svg
                className="hud-svg"
                viewBox={`0 0 ${VW} ${VH}`}
                preserveAspectRatio="xMidYMid slice"
            >
                <defs>
                    <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0a3d6b" />
                        <stop offset="100%" stopColor="#1a7fc9" />
                    </linearGradient>
                    <linearGradient id="groundGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#4e5f28" />
                        <stop offset="100%" stopColor="#2a3a15" />
                    </linearGradient>
                    <clipPath id="hudClip">
                        <rect x="0" y="0" width={VW} height={VH} />
                    </clipPath>
                </defs>

                <g clipPath="url(#hudClip)">
                    <g transform={`translate(0 ${pitchOffset}) rotate(${rollAngle} ${CX} ${CY})`}>
                        <rect x="-1200" y="-1400" width="2800" height={HORIZON_Y + 1400} fill="url(#skyGrad)" />
                        <rect x="-1200" y={HORIZON_Y} width="2800" height="1600" fill="url(#groundGrad)" />
                        <line x1="-1200" y1={HORIZON_Y} x2="1600" y2={HORIZON_Y} stroke="white" strokeWidth={1.5} />
                        <PitchLadder />
                    </g>
                </g>

                <g transform={`rotate(${rollAngle} ${CX} ${CY})`}>
                    <RollArc />
                </g>

                <polygon points="200,4 196,16 204,16" fill="#ff3b30" pointerEvents="none" />

                <AircraftSymbol />

                <text
                    x={CX}
                    y={108}
                    textAnchor="middle"
                    fill="white"
                    fontSize={16}
                    fontWeight="bold"
                    fontFamily="Segoe UI, Arial, sans-serif"
                    letterSpacing={2}
                    pointerEvents="none"
                >
                    {telemetry.armed ? 'ARMED' : 'DISARMED'}
                </text>

                <text
                    x={CX}
                    y={288}
                    textAnchor="middle"
                    fill="white"
                    fontSize={9}
                    opacity={0.7}
                    fontFamily="Segoe UI, Arial, sans-serif"
                    pointerEvents="none"
                >
                    BAT {Math.round(telemetry.batteryRemaining)}%  GPS {telemetry.satellites}  {telemetry.mode}  HDG {Math.round(telemetry.heading)}°
                </text>
            </svg>
        </div>
    );
}

export default ArtificialHorizon;
