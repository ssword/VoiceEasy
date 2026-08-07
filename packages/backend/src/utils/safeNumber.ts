export function clampFiniteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback = 0
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}
