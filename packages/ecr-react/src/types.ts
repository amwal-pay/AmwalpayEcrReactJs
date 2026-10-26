/**
 * The JSON shapes of the till server's API: the same contract as the PHP and
 * ASP.NET web samples (`GET /api/meta`, terminals, settings, transactions, log, QR).
 */

/** Which form fields one combination of (other terminal, look up by reference) shows. */
export interface FieldLayout {
  amount: boolean;
  merchantReference: boolean;
  referenceSwitch: boolean;
  originalReference: boolean;
  receiptNumber: boolean;
  originalDate: boolean;
  otherTerminalSwitch: boolean;
  originalTerminal: boolean;
}

/** One operation the form offers, with the SDK's flags. */
export interface OperationView {
  value: 'Sale' | 'Void' | 'Refund' | 'Inquiry' | string;
  label: string;
  requiresAmount: boolean;
  requiresOriginalStan: boolean;
  requiresOriginalDate: boolean;
  allowsOtherTerminal: boolean;
  movesMoney: boolean;
  amountHelp: string;
  startButtonText: string;
  /** Keyed `${useOtherTerminal ? 1 : 0}${lookUpByReference ? 1 : 0}`: "00", "01", "10", "11". */
  layouts: Record<string, FieldLayout>;
}

/** One ECR mode a terminal can be registered with. */
export interface ModeView {
  value: number;
  label: string;
  ipBased: boolean;
  supported: boolean;
  hint: string;
  note: string;
}

/** `GET /api/meta`. */
export interface MetaView {
  operations: OperationView[];
  modes: ModeView[];
  environments: string[];
  amount: { min: string; max: string; fractionDigits: number; maxDigits: number };
  merchantReferenceMaxLength: number;
  receiptNumberMaxLength: number;
  defaultPort: number;
  /** `yyyy-MM-dd`, the server's today. */
  today: string;
}

/** A registered terminal. Addresses only, never a key. */
export interface TerminalView {
  serialNumber: string;
  name: string;
  ecrMode: number;
  modeLabel: string;
  ipAddress: string;
  port: number;
  terminalId: string;
  merchantId: string;
  displayName: string;
  connectionSummary: string;
  supported: boolean;
}

/** `GET /api/terminals`. */
export interface TerminalListView {
  terminals: TerminalView[];
  notice: string | null;
}

/** What `POST /api/terminals` and `PUT /api/terminals/{serial}` take. */
export interface TerminalForm {
  name: string;
  serialNumber: string;
  ecrMode: number;
  ipAddress: string;
  port: string;
  terminalId: string;
  merchantId: string;
}

/** `GET /api/terminals/{serial}/config`: what the SDK plan makes of a terminal. */
export interface ConfigView {
  serialNumber: string;
  modeLabel: string;
  transportLabel: string;
  connectionSummary: string;
  keyLabel: string;
  keyConfigured: boolean;
  keyStatus: string;
  issues: string[];
  isReady: boolean;
  isSupported: boolean;
  usesWebService: boolean;
}

/** One signing key, write-only: whether it is set, never its value. */
export interface KeyView {
  label: string;
  configured: boolean;
}

export type KeyKind = 'wifi' | 'webService';

/** `GET /api/settings`. */
export interface SettingsView {
  environment: string;
  wifi: KeyView;
  webService: KeyView;
  notice: string | null;
}

/** What `POST /api/transactions` takes: the form state plus the terminal. */
export interface TransactionForm {
  terminalSerial: string;
  type: string;
  amountDigits: string;
  receiptNumber: string;
  originalTerminalId: string;
  /** `yyyy-MM-dd`. */
  originalDate: string;
  useOtherTerminal: boolean;
  lookUpByReference: boolean;
  originalReference: string;
  merchantReference: string;
}

export interface ReceiptView {
  showButton: boolean;
  fetching: boolean;
  url: string | null;
  problem: string | null;
}

/** How a transaction ended, as the result dialog shows it. */
export interface DialogView {
  headline: string;
  tone: 'approved' | 'declined';
  amount: string;
  message: string | null;
  note: string | null;
  fields: Array<{ label: string; value: string }>;
  hints: string[];
  rawPayload: string | null;
  isUnknownOutcome: boolean;
  inquirableReference: string | null;
  unknownOutcomeWarning: string | null;
  offersReceipt: boolean;
  receiptNote: string | null;
  receipt: ReceiptView;
  canCloseReceipt: boolean;
}

export type TransactionState = 'idle' | 'checking' | 'inProgress' | 'completed' | 'inquired' | 'failed';

/** One run on the server, as a poll returns it. */
export interface TransactionView {
  id: string;
  terminalSerial: string;
  operation: string;
  state: TransactionState;
  busy: boolean;
  isResult: boolean;
  statusText: string;
  /** Bumped on every change: an older version than the one shown is ignored. */
  version: number;
  dialog: DialogView | null;
  timeoutSeconds: number;
  remainingSeconds: number | null;
}

/** `POST /api/transactions/{id}/close-receipt`. */
export interface CloseReceiptView {
  message: string;
  transaction: TransactionView;
}

/** `GET /api/log`. */
export interface LogView {
  text: string;
  count: number;
  capacity: number;
}
