const PITCHES = [-30, -20, -10, 0, 10, 20, 30];
const CY = 150;
const SCALE = 4;
const LINE_X1 = 85;
const LINE_X2 = 300;
const GAP_START = 172;
const GAP_END = 228;

function PitchLadder() {
    return (
        <g>
            {PITCHES.map((pitch) => {
                const y = CY - pitch * SCALE;

                if (pitch === 0) {
                    return (
                        <g key={pitch}>
                            <line
                                x1={LINE_X1}
                                y1={y}
                                x2={GAP_START}
                                y2={y}
                                stroke="white"
                                strokeWidth={1.5}
                            />
                            <line
                                x1={GAP_END}
                                y1={y}
                                x2={LINE_X2}
                                y2={y}
                                stroke="white"
                                strokeWidth={1.5}
                            />
                        </g>
                    );
                }

                return (
                    <g key={pitch}>
                        <line
                            x1={LINE_X1}
                            y1={y}
                            x2={LINE_X2}
                            y2={y}
                            stroke="white"
                            strokeWidth={1.2}
                        />
                        <text
                            x={LINE_X2 + 12}
                            y={y + 3}
                            fill="white"
                            fontSize={11}
                            fontWeight={600}
                            fontFamily="Segoe UI, Arial, sans-serif"
                            textAnchor="start"
                            dominantBaseline="middle"
                        >
                            {pitch > 0 ? pitch : `${pitch}`}
                        </text>
                    </g>
                );
            })}
        </g>
    );
}

export default PitchLadder;
