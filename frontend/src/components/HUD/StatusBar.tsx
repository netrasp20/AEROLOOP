interface StatusBarProps {
    groundSpeed: number;
    altitude: number;
    heading: number;
    battery: number;
    satellites: number;
    mode: string;
}

function StatusBar({ battery, satellites, mode }: StatusBarProps) {
    return (
        <div className="hud-status">
            <span className="hud-status-item">BAT {Math.round(battery)}%</span>
            <span className="hud-status-item">GPS {satellites}</span>
            <span className="hud-status-item">{mode}</span>
        </div>
    );
}

export default StatusBar;
