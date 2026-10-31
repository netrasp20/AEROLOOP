interface SpeedTapeProps {
    speed: number;
}

function SpeedTape({ speed }: SpeedTapeProps) {
    const step = 5;
    const itemHeight = 20;
    const numItems = 11;

    const centerValue = Math.round(speed / step) * step;
    const remainder = speed - centerValue;
    const scrollOffset = (remainder / step) * itemHeight;

    const values: number[] = [];
    for (let i = -Math.floor(numItems / 2); i <= Math.floor(numItems / 2); i++) {
        values.push(centerValue + i * step);
    }

    return (
        <div className="speed-tape">
            <div className="tape-container">
                <div
                    className="tape-scroll"
                    style={{ transform: `translateY(${scrollOffset}px)` }}
                >
                    {values.map((v, i) => (
                        <div key={i} className="tape-value">{v >= 0 ? v : ""}</div>
                    ))}
                </div>
            </div>
            <div className="tape-pointer-box speed">
                <span className="tape-pointer-value">{Math.round(speed)}</span>
            </div>
        </div>
    );
}

export default SpeedTape;
