const API = "/api/vehicle";

// ----------------------
// Connection Types
// ----------------------

export type ConnectionRequest =
  | {
      connectionType: "tcp";
      host: string;
      port: number;
    }
  | {
      connectionType: "udp";
      host: string;
      port: number;
    }
  | {
      connectionType: "serial";
      device: string;
      baudRate: number;
    };
    export async function getSerialPorts() {
  const res = await fetch(
    "http://localhost:5000/api/vehicle/serial-ports"
  );

  return await res.json();
}

// ----------------------
// CONNECT
// ----------------------

export async function connectVehicle(
  connection: ConnectionRequest
) {
  const res = await fetch(`${API}/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(connection),
  });

  return res.json();
}

// ----------------------
// DISCONNECT
// ----------------------

export async function disconnectVehicle() {
  const res = await fetch(`${API}/disconnect`, {
    method: "POST",
  });

  return res.json();
}

// ----------------------
// STATUS
// ----------------------

export async function getVehicleStatus() {
  const res = await fetch(`${API}/status`);
  return res.json();
}

// ----------------------
// ARM
// ----------------------

export async function armVehicle() {
  const res = await fetch(`${API}/arm`, {
    method: "POST",
  });

  return res.json();
}

// ----------------------
// DISARM
// ----------------------

export async function disarmVehicle() {
  const res = await fetch(`${API}/disarm`, {
    method: "POST",
  });

  return res.json();
}

// ----------------------
// MODE
// ----------------------

export async function changeMode(mode: string) {
  const res = await fetch(`${API}/mode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode,
    }),
  });

  return res.json();
}

// ----------------------
// SET HOME
// ----------------------

export async function setHome(opts?: { lat: number; lon: number; alt?: number }) {
  const res = await fetch(`${API}/home`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(opts ?? {}),
  });

  return res.json();
}