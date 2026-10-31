interface AltitudeTapeProps {
    altitude: number;
}

function AltitudeTape({ altitude }: AltitudeTapeProps) {
    const step = 10;
    const itemHeight = 20;
    const numItems = 11;

    const centerValue = Math.round(altitude / step) * step;
    const remainder = altitude - centerValue;
    const scrollOffset = (remainder / step) * itemHeight;

    const values: number[] = [];
    for (let i = -Math.floor(numItems / 2); i <= Math.floor(numItems / 2); i++) {
        values.push(centerValue + i * step);
    }

    return (
        <div className="altitude-tape">
            <div className="tape-container">
                <div
                    className="tape-scroll"
                    style={{ transform: `translateY(${scrollOffset}px)` }}
                >
                    {values.map((v, i) => (
                        <div key={i} className="tape-value">{v}</div>
                    ))}
                </div>
            </div>
            <div className="tape-pointer-box altitude">
                <span className="tape-pointer-value">{Math.round(altitude)}</span>
            </div>
        </div>
    );
}

export default AltitudeTape;
