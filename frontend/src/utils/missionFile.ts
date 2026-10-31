import type { MissionFile } from "../types/mission";

function downloadJsonFile(
  data: MissionFile,
  filename: string
): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function saveJsonFile(
  data: MissionFile
): Promise<void> {
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: "mission.json",
      types: [
        {
          description: "Mission File",
          accept: { "application/json": [".json"] },
        },
      ],
    });

    const writable = await handle.createWritable();
    const json = JSON.stringify(data, null, 2);
    await writable.write(json);
    await writable.close();
  } else {
    const now = new Date();
    const ts =
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_` +
      `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    downloadJsonFile(data, `mission_${ts}.json`);
  }
}

export function readJsonFile(
  file: File
): Promise<MissionFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as MissionFile;
        resolve(data);
      } catch {
        reject(new Error("Invalid JSON file."));
      }
    };

    reader.onerror = () => {
      reject(new Error("Failed to read file."));
    };

    reader.readAsText(file);
  });
}

export function openFileDialog(
  accept = ".json"
): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;

    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        resolve(file);
      } else {
        reject(new Error("No file selected."));
      }
    };

    input.onerror = () => {
      reject(new Error("File dialog error."));
    };

    input.click();
  });
}
