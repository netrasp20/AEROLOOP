export function formatCountdown(isoStart: string): string {
  const target = new Date(isoStart).getTime();
  if (isNaN(target)) return "--";
  const diff = target - Date.now();
  if (diff <= 0) return "Due now";

  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

export function isScheduleDueSoon(isoStart: string, withinSeconds = 120): boolean {
  const target = new Date(isoStart).getTime();
  if (isNaN(target)) return false;
  const diff = target - Date.now();
  return diff >= -1500 && diff <= withinSeconds * 1000;
}
