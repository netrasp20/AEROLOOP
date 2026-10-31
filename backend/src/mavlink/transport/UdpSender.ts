import dgram from "dgram";

const udp = dgram.createSocket("udp4");

const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = 14551;

/**
 * Send a raw MAVLink packet
 * to ArduPilot via UDP.
 */
export function sendPacket(buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    udp.send(
      buffer,
      TARGET_PORT,
      TARGET_HOST,
      (err) => {
        if (err) {
          console.error(
            "❌ UDP Send Failed:",
            err
          );
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}