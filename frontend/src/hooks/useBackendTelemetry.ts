import { useEffect, useState } from "react";
import { getTelemetry } from "../api/telemetry";

export default function useBackendTelemetry() {
  const [telemetry, setTelemetry] = useState<any>(null);

  useEffect(() => {
    async function loadTelemetry() {
      try {
        const data = await getTelemetry();
        setTelemetry(data);
      } catch (err) {
        console.error(err);
      }
    }

    loadTelemetry();
  }, []);

  return telemetry;
}