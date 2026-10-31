import { useTelemetry } from "../../providers/TelemetryProvider";
import { radToHeadingDeg } from "../../utils/units";

function HeadingTape() {
  const telemetry = useTelemetry();

  const heading = radToHeadingDeg(telemetry.yaw);
  const step = 15;
  const itemWidth = 48;

  const centerValue = Math.round(heading / step) * step;
  const remainder = heading - centerValue;
  const scrollOffset = (remainder / step) * itemWidth;

  const values: { display: string }[] = [];
  const tickMarks: number[] = [];

  for (let i = -5; i <= 5; i++) {
    let value = centerValue + i * step;
    if (value < 0) value += 360;
    if (value >= 360) value -= 360;

    let display: string;
    if (value === 0) display = "N";
    else if (value === 45) display = "NE";
    else if (value === 90) display = "E";
    else if (value === 135) display = "SE";
    else if (value === 180) display = "S";
    else if (value === 225) display = "SW";
    else if (value === 270) display = "W";
    else if (value === 315) display = "NW";
    else display = value.toString();

    values.push({ display });

    for (let t = 1; t <= 2; t++) {
      tickMarks.push(i * step + t * 5);
    }
  }

  const centerIndex = 5;
  const centerOffset = -(centerIndex + 0.5) * itemWidth;

  return (
    <div className="heading-overlay">
      <div className="heading-top-line" />
      <div className="heading-tape">
        <div
          className="heading-scroll"
          style={{ transform: `translateX(${centerOffset + scrollOffset}px)` }}
        >
          {values.map((v, i) => (
            <div
              key={i}
              className={`heading-item${i === centerIndex ? ' center' : ''}`}
            >
              {v.display}
            </div>
          ))}
        </div>
      </div>
      <div className="heading-pointer" />
    </div>
  );
}

export default HeadingTape;
