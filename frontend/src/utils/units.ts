export const RAD2DEG = 180 / Math.PI;

export function radToDeg(radians: number): number {
  return radians * RAD2DEG;
}

export function radToHeadingDeg(radians: number): number {
  const deg = (radians * RAD2DEG) % 360;
  return deg < 0 ? deg + 360 : deg;
}
