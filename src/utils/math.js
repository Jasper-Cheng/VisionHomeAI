export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function degToRad(d) {
  return (d * Math.PI) / 180;
}
