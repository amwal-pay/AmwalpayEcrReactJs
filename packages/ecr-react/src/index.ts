/**
 * @amwalpay/ecr-react — React hooks and components for an Amwal ECR till.
 *
 * The browser never talks to a terminal and never holds a signing key: it
 * talks to your till server (built on @amwalpay/ecr-js), which runs the
 * transaction and is polled from the page.
 */
export { createEcrClient, qrUrl, ApiError, type EcrClient, type EcrClientOptions } from './client.js';
export { EcrProvider, useEcrClient, type EcrProviderProps } from './context.js';
export { FRACTION_DIGITS, keyedDigits, formatAmount, appendDigit, backspaceDigit } from './amount.js';
export { AmountInput, type AmountInputProps, type AmountInputHandle } from './AmountInput.js';
export {
  useMeta, useTerminals, useSettings, useTerminalConfig, useTransaction, useCountdown, useEcrLog, POLL_MS,
  type UseMeta, type UseTerminals, type UseSettings, type UseTerminalConfig, type UseTransaction,
  type UseTransactionOptions, type Countdown, type UseEcrLog,
} from './hooks.js';
export type * from './types.js';
