const CX = 200;
const CY = 150;
const R = 130;

const degToRad = (d: number) => d * Math.PI / 180;

const tickAngle = (a: number) => {
    const rad = degToRad(a);
    return {
        x1: CX + Math.sin(rad) * R,
        y1: CY - Math.cos(rad) * R,
    };
};

const TICK_ANGLES: number[] = [];
for (let a = -70; a <= 70; a += 10) {
    TICK_ANGLES.push(a);
}

const MAJOR = new Set([-60, -30, 0, 30, 60]);

const arcStart = tickAngle(-75);
const arcEnd = tickAngle(75);

function RollArc() {
    return (
        <g>
            <path
                d={`M ${arcStart.x1.toFixed(1)} ${arcStart.y1.toFixed(1)} A ${R} ${R} 0 0 1 ${arcEnd.x1.toFixed(1)} ${arcEnd.y1.toFixed(1)}`}
                stroke="white"
                strokeWidth={1.2}
                fill="none"
            />

            {TICK_ANGLES.map((a) => {
                const isMajor = MAJOR.has(a);
                const len = isMajor ? 10 : 6;
                const inner = tickAngle(a);
                const outer = {
                    x: CX + Math.sin(degToRad(a)) * (R + len),
                    y: CY - Math.cos(degToRad(a)) * (R + len),
                };

                return (
                    <g key={a}>
                        <line
                            x1={inner.x1}
                            y1={inner.y1}
                            x2={outer.x}
                            y2={outer.y}
                            stroke="white"
                            strokeWidth={isMajor ? 1.2 : 0.8}
                        />
                        {isMajor && a !== 0 && Math.abs(a) <= 60 && (
                            <text
                                x={CX + Math.sin(degToRad(a)) * (R + 18)}
                                y={CY - Math.cos(degToRad(a)) * (R + 18)}
                                fill="white"
                                fontSize={9}
                                fontWeight={600}
                                fontFamily="Segoe UI, Arial, sans-serif"
                                textAnchor="middle"
                                dominantBaseline="middle"
                            >
                                {Math.abs(a)}
                            </text>
                        )}
                    </g>
                );
            })}
        </g>
    );
}

export default RollArc;
