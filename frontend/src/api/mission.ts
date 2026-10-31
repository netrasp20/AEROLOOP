const API_URL = "/api/mission";

export async function saveMission(mission: any) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(mission),
  });

  return response.json();
}

export async function getMission() {
  const response = await fetch(API_URL);
  return response.json();
}

export async function clearMissionApi() {
  const response = await fetch(API_URL, {
    method: "DELETE",
  });

  return response.json();
}

export async function startMissionApi() {
  const response = await fetch(`${API_URL}/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  return response.json();
}
