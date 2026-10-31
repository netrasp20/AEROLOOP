import type { ReactNode } from "react";

type TelemetryCardProps = {
  title: string;
  value: string;
  unit: string;
  icon: ReactNode;
};

function TelemetryCard({
  title,
  value,
  unit,
  icon,
}: TelemetryCardProps) {
  return (
    <div className="telemetry-card">
      <div className="telemetry-top">
        <div className="telemetry-icon">
          {icon}
        </div>

        <div className="telemetry-title">
          {title}
        </div>
      </div>

      <div className="telemetry-value">
        <span>{value}</span>

        {unit && (
          <span className="telemetry-unit">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

export default TelemetryCard;