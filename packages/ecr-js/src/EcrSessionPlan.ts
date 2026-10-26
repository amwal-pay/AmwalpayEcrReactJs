import type { EcrConfig } from './EcrConfig.js';
import { LogicException } from './exception/errors.js';
import { SecureHash } from './internal/SecureHash.js';
import { type EcrLink, LanLink, WebServiceLink } from './link/EcrLink.js';
import { WebServiceSecureHash } from './webservice/WebServiceSecureHash.js';

/**
 * A validated configuration for one terminal link, built by
 * {@link EcrSessions.plan} so the app does not repeat transport rules.
 * `issues()` lists what is wrong; an empty list means it can be opened.
 */
export class EcrSessionPlan {
  constructor(
    readonly link: EcrLink,
    readonly config: EcrConfig,
    private readonly planIssues: readonly string[] = [],
  ) {}

  /** What is wrong with this plan; empty when it can be opened. */
  issues(): string[] {
    return [...this.planIssues];
  }

  isReady(): boolean {
    return this.planIssues.length === 0;
  }

  usesLan(): boolean {
    return this.link instanceof LanLink;
  }

  usesWebService(): boolean {
    return this.link instanceof WebServiceLink;
  }

  /** Which of the two secrets this plan expects: Wi-Fi and Web Service keys are issued separately. */
  signingKeyLabel(): string {
    return EcrSessionPlan.keyLabelFor(this.link);
  }

  signingKeyConfigured(): boolean {
    return this.config.secureHashKey !== '';
  }

  /** Operator-facing summary, never a secret: `192.168.1.50:9100` or `UAT · merchant 10001 · terminal 20002`. */
  connectionSummary(): string {
    if (this.link instanceof LanLink) return `${this.link.host}:${this.config.port}`;
    if (this.link instanceof WebServiceLink) {
      let summary: string = this.config.environment.value;
      if (this.link.merchantId !== '') summary += ' · merchant ' + this.link.merchantId;
      if (this.link.terminalId !== '') summary += ' · terminal ' + this.link.terminalId;
      return summary;
    }
    throw new LogicException('Unsupported ECR link: ' + this.link.constructor.name);
  }

  /** @internal */
  static keyLabelFor(link: EcrLink): string {
    if (link instanceof LanLink) return SecureHash.KEY_LABEL;
    if (link instanceof WebServiceLink) return WebServiceSecureHash.KEY_LABEL;
    throw new LogicException('Unsupported ECR link: ' + link.constructor.name);
  }
}
