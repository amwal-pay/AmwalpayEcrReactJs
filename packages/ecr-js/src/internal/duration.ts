/**
 * `45s`, `2m`, `1m 30s`.
 *
 * @internal Exposed as {@link EcrTerminal.formatDuration}.
 */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
