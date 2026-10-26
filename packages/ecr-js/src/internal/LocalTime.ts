/**
 * The machine's local time, as the Windows SDK reads it with `DateTime.Now`.
 *
 * Node already stamps in the operating system's time zone (unless the `TZ`
 * environment variable overrides it), so unlike the PHP SDK, which must look
 * past php.ini's `date.timezone`, nothing has to be detected here.
 *
 * @internal
 */
export class LocalTime {
  /**
   * `yyyyMMddHHmmss`, the format the Windows SDK writes `DateTime.Now` in.
   * `timezone` overrides the machine's zone when the till sets one.
   */
  static stamp(timezone: string | null = null, now: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone ?? undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '00';
    return `${get('year').padStart(4, '0')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
  }

  /** The operating system's time zone, as an IANA name (`Asia/Muscat`), or `UTC` when it cannot be read. */
  static zone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
}
