import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { EcrConfig, type EcrConfigOptions } from '../../src/EcrConfig.js';
import { EcrEnvironment } from '../../src/EcrEnvironment.js';

/**
 * Synthetic placeholder secrets that happen to be valid hex, the same ones the
 * Windows SDK's tests use, so the known answers carry across. Never real keys.
 */
export const TestKeys = {
  WIFI: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  WIFI_OTHER: 'cccccccccccccccccccccccccccccccc',
  WEB_SERVICE: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',

  lan(stateDirectory: string, changes: EcrConfigOptions = {}): EcrConfig {
    return new EcrConfig({ secureHashKey: TestKeys.WIFI, stateDirectory, guardFinancialOperations: true }).with(changes);
  },

  unsigned(stateDirectory: string, changes: EcrConfigOptions = {}): EcrConfig {
    return new EcrConfig({ stateDirectory, autoInquireOnFailure: false, guardFinancialOperations: true }).with(changes);
  },

  webService(stateDirectory: string, changes: EcrConfigOptions = {}): EcrConfig {
    return new EcrConfig({
      secureHashKey: TestKeys.WEB_SERVICE,
      merchantId: '10001',
      terminalId: '20001',
      environment: EcrEnvironment.UAT,
      stateDirectory,
      guardFinancialOperations: true,
    }).with(changes);
  },
};

/** A private state folder per test, removed afterwards. Call once at module level. */
export function useTempState(): () => string {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  return () => {
    dir ??= mkdtempSync(join(tmpdir(), 'amwalpay-ecr-test-'));
    return dir;
  };
}
