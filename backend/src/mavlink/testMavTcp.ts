import { MavTCP } from "node-mavlink";

async function main() {
  const port = new MavTCP();

  const info = await port.start("127.0.0.1", 5760);

  console.log("Connected:", info);

  process.exit(0);
}

main().catch(console.error);