import { SerialPort } from "serialport";

export async function getAvailableSerialPorts() {
  const ports = await SerialPort.list();

  // Keep only USB serial devices
  const usbPorts = ports.filter(
    (port) =>
      port.path.startsWith("/dev/ttyACM") ||
      port.path.startsWith("/dev/ttyUSB")
  );

  return usbPorts.map((port) => ({
    path: port.path,
    manufacturer: port.manufacturer ?? "Unknown",
    serialNumber: port.serialNumber ?? "",
    vendorId: port.vendorId ?? "",
    productId: port.productId ?? "",
  }));
}