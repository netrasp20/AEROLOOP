import type { MissionFile } from "../types/mission";

let currentHandle: FileSystemFileHandle | null = null;

async function writeFile(
  handle: FileSystemFileHandle,
  data: MissionFile
): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const writable = await handle.createWritable();
  await writable.write(json);
  await writable.close();
}

function downloadFallback(data: MissionFile): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mission.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function saveFile(
  data: MissionFile
): Promise<{ filename: string }> {
  if ("showSaveFilePicker" in window) {
    if (currentHandle) {
      await writeFile(currentHandle, data);
      return { filename: currentHandle.name };
    }

    const handle = await window.showSaveFilePicker({
      suggestedName: "mission.json",
      types: [
        {
          description: "Mission File",
          accept: { "application/json": [".json"] },
        },
      ],
    });

    await writeFile(handle, data);
    currentHandle = handle;

    return { filename: handle.name };
  }

  downloadFallback(data);
  return { filename: "mission.json" };
}

export function clearFileHandle(): void {
  currentHandle = null;
}
