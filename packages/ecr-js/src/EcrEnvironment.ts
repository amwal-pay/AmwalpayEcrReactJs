import { NetText } from './internal/NetText.js';

/**
 * Deployment environment for Web Service ECR.
 *
 * The SDK resolves the Amwal Hub address internally; an integrator passes only
 * this value in {@link EcrConfig.environment}.
 */
export class EcrEnvironment {
  static readonly SIT = new EcrEnvironment('SIT');
  static readonly UAT = new EcrEnvironment('UAT');
  static readonly PROD = new EcrEnvironment('PROD');

  static readonly DEFAULT = EcrEnvironment.SIT;

  private constructor(readonly value: 'SIT' | 'UAT' | 'PROD') {}

  static cases(): EcrEnvironment[] {
    return [EcrEnvironment.SIT, EcrEnvironment.UAT, EcrEnvironment.PROD];
  }

  /** The environment with exactly this value, or null. */
  static tryFrom(value: string): EcrEnvironment | null {
    return EcrEnvironment.cases().find((e) => e.value === value) ?? null;
  }

  /** Reads an environment by name, ignoring case and surrounding space. Unknown names read as SIT. */
  static fromName(name: string | null | undefined): EcrEnvironment {
    return EcrEnvironment.tryFrom(NetText.trim(String(name ?? '')).toUpperCase()) ?? EcrEnvironment.DEFAULT;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}
