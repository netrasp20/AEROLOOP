function AircraftSymbol() {
    return (
        <g transform="translate(200, 150)" pointerEvents="none">
            <circle cx="0" cy="0" r="3" fill="#ff3b30" />
            <line x1="-55" y1="0" x2="-12" y2="0" stroke="white" strokeWidth={2} />
            <line x1="12" y1="0" x2="55" y2="0" stroke="white" strokeWidth={2} />
            <line x1="0" y1="-14" x2="0" y2="-4" stroke="white" strokeWidth={1.5} />
        </g>
    );
}

export default AircraftSymbol;
