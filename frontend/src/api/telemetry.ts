import api from "./api";

export async function getTelemetry() {
  const response = await api.get("/telemetry");
  return response.data;
}