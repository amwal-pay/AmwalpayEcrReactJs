import type { EcrEnvironment } from '../EcrEnvironment.js';
import type { EcrTransactionType } from '../EcrTransactionType.js';
import { EnvironmentUrls } from '../internal/EnvironmentUrls.js';
import { rtrim } from '../internal/text.js';
import { WebServiceOperation } from './WebServiceOperation.js';

/** Resolves the Hub URL and the fixed ECR operation paths for an environment. */
export class WebServiceRoutes {
  constructor(private readonly environment: EcrEnvironment) {}

  hub(): string {
    return EnvironmentUrls.hub(this.environment);
  }

  path(operation: WebServiceOperation): string {
    return operation.path();
  }

  url(operation: WebServiceOperation): string {
    return rtrim(this.hub(), '/') + operation.path();
  }

  /** The path for a transaction type, or null for a receipt, which has no Web Service operation. */
  pathFor(type: EcrTransactionType): string | null {
    return WebServiceOperation.forType(type)?.path() ?? null;
  }
}
