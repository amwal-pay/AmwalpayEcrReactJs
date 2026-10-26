import { LocalTime } from './internal/LocalTime.js';

/** Facts about this build of the SDK, for logs and support tickets. */
export class EcrSdk {
  /** The package version. Kept in step with the Git tag and CHANGELOG.md. */
  static readonly VERSION = '1.0.0-rc.1';

  /** The ECR message format this SDK writes and reads (`version` on the wire). */
  static readonly PROTOCOL_VERSION = 1;

  /** The Windows SDK release whose behaviour this one matches. */
  static readonly PARITY_WITH = 'AmwalPay.Ecr 1.0.2 (.NET)';

  /** The PHP SDK this package is a line-for-line port of. */
  static readonly PORT_OF = 'amwalpay/ecr-php 1.0.0-rc.1';

  static readonly MINIMUM_NODE = '18.18.0';

  /**
   * The operating system's time zone, which `transactionDateTime` is stamped in
   * unless {@link EcrConfig.timezone} is set (the Windows SDK's `DateTime.Now`).
   */
  static localTimeZone(): string {
    return LocalTime.zone();
  }
}
