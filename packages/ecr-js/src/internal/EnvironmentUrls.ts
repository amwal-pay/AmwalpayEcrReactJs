import { EcrEnvironment } from '../EcrEnvironment.js';
import { rtrim } from './text.js';

/**
 * Amwal Hub base URLs per environment. SDK-internal: integrators choose SIT,
 * UAT or PROD and never type an address. Paths are appended by
 * {@link WebServiceRoutes}.
 *
 * Same hosts as AmwalPay.Ecr 1.0.2.
 *
 * @internal
 */
export class EnvironmentUrls {
  private static readonly SIT = 'https://test.amwalpg.com:25452';
  private static readonly UAT = 'https://test.amwalpg.com:25453';
  private static readonly PROD = 'https://pos.amwalpg.com';

  static hub(environment: EcrEnvironment): string {
    const url = environment === EcrEnvironment.UAT ? EnvironmentUrls.UAT
      : environment === EcrEnvironment.PROD ? EnvironmentUrls.PROD
        : EnvironmentUrls.SIT;
    return rtrim(url, '/');
  }
}
