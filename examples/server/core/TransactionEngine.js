import {
  CloseReceiptFailed,
  CloseReceiptRefused,
  EcrLogger,
  EcrSessions,
  EcrTransactionType,
  Found,
  InvalidArgumentException,
  LogicException,
  ReceiptClosed,
  ReceiptUnavailable,
} from '@amwalpay/ecr-js';
import { SelectedTerminalConfig } from './SelectedTerminalConfig.js';
import { TransactionOutcomes } from './TransactionOutcomes.js';
import { StateFailed, StateIdle, StateInProgress } from './TransactionState.js';

/**
 * Runs one operation against a registered terminal: resolve the config, open
 * the session through `EcrSessions.open()`, probe, execute, and classify the
 * answer. The flow and the money-safety rules of the Windows samples' Core.
 */
export class TransactionEngine {
  #repository;
  #settings;
  #log;
  #sdkStateDirectory;

  constructor(repository, settings, log, sdkStateDirectory) {
    this.#repository = repository;
    this.#settings = settings;
    this.#log = log;
    this.#sdkStateDirectory = sdkStateDirectory;
  }

  resolveConfig(terminal) {
    return SelectedTerminalConfig.resolve(
      terminal,
      this.#settings.environment(),
      this.#settings.secureHashKeyFor(terminal.mode()),
      this.#sdkStateDirectory,
    );
  }

  logSelectedConfig(config) {
    const logger = this.#loggerFor(config);
    const prefix = config.usesWebService() ? '[Web Service]' : '[Wi-Fi]';
    logger.debug(`${prefix} selected ${config.terminal.serialNumber} (${config.modeLabel()})`);
    logger.debug(`${prefix} SDK connection: ${config.connectionSummary()}`);
    for (const issue of config.issues()) logger.debug(`${prefix} config issue: ${issue}`);
  }

  /**
   * Runs `request` and returns the state to show.
   *
   * @param {(state: import('./TransactionState.js').TransactionState) => Promise<boolean> | boolean} report
   *        Called with InProgress just before the request goes out. Returns false when the operator
   *        has cancelled: nothing is sent and the run ends Idle.
   */
  async run(request, report) {
    const registered = this.#repository.findBySerial(request.terminalSerial);
    if (registered === null) return new StateFailed(`Terminal ${request.terminalSerial} is no longer registered`);
    const active = this.resolveConfig(registered);
    if (!active.isReady()) return new StateFailed(active.issues().join('\n'));
    let session;
    try {
      session = this.#open(registered, active);
    } catch (error) {
      if (error instanceof InvalidArgumentException || error instanceof LogicException) return new StateFailed(error.message);
      throw error;
    }

    const reference = request.type.movesMoney() && request.merchantReference === ''
      ? TransactionEngine.newReference()
      : request.merchantReference;

    const probe = await session.probeReachability();
    if (probe !== null && !probe.reachable) {
      this.#loggerFor(active).debug(`[${probe.endpoint}] probe failed${probe.error !== null ? ' — ' + probe.error : ''}`);
      return new StateFailed(TransactionOutcomes.unreachableMessage(probe.endpoint, probe.port, probe.error));
    }

    if (!(await report(new StateInProgress()))) {
      // Cancelled while checking: nothing has been sent, so nothing can have happened.
      return new StateIdle();
    }

    try {
      return await this.#execute(session, request, reference);
    } catch (error) {
      // Refused before anything was built or sent: a plain "not completed".
      if (error instanceof InvalidArgumentException) return new StateFailed(error.message);
      this.#loggerFor(active).debug('[App] unexpected error: ' + messageOf(error));
      return request.type.movesMoney()
        ? new StateFailed('Unexpected error: ' + messageOf(error), reference)
        : new StateFailed('Unexpected error: ' + messageOf(error));
    }
  }

  async #execute(session, request, reference) {
    if (request.type === EcrTransactionType.Inquiry) {
      // By reference leaves the date blank (a reference is not day-scoped);
      // by receipt number sends the form's date. Never invent today's date
      // for Web Service: the Hub filters by that day.
      const inquiry = request.looksUpByReference()
        ? await session.inquireByReference(request.originalReference, {
          transactionDate: request.transactionDate,
          originalTerminalId: request.originalTerminalId,
          merchantReference: request.merchantReference,
        })
        : await session.inquire(request.receiptNumber, request.transactionDate, { originalTerminalId: request.originalTerminalId });
      return TransactionOutcomes.fromInquiry(inquiry, request);
    }
    let result;
    switch (request.type) {
      case EcrTransactionType.Sale:
        result = await session.sale(String(request.amount), reference);
        break;
      case EcrTransactionType.Void:
        result = await session.void(request.receiptNumber, { originalTerminalId: request.originalTerminalId, merchantReference: reference });
        break;
      case EcrTransactionType.Refund:
        result = await session.refund(String(request.amount), request.receiptNumber, request.transactionDate, {
          originalTerminalId: request.originalTerminalId,
          merchantReference: reference,
        });
        break;
      default:
        throw new LogicException(`${request.type.displayName()} is not run from here`);
    }
    return TransactionOutcomes.fromResult(result, request.withMerchantReference(reference));
  }

  /**
   * Asks the terminal to put its receipt away. Call from the Close receipt
   * action, not when the result dialog is dismissed. Never throws.
   *
   * @param originalMerchantReference Required for Web Service: the sale, void or refund reference.
   */
  async closeTerminalReceipt(terminalSerial, originalMerchantReference = '') {
    const registered = this.#repository.findBySerial(terminalSerial);
    if (registered === null) return `Terminal ${terminalSerial} is no longer registered`;
    if (!registered.mode().isSupportedInExample()) return 'Close receipt is not available for this terminal mode';
    const active = this.resolveConfig(registered);
    if (!active.isReady()) return active.issues().join('\n');
    try {
      const closed = await this.#open(registered, active).closeReceipt({ originalMerchantReference });
      if (closed instanceof ReceiptClosed) return 'Terminal is back on its idle screen';
      if (closed instanceof CloseReceiptRefused) return 'Terminal refused: ' + closed.reason;
      if (closed instanceof CloseReceiptFailed) return 'Could not reach the terminal: ' + closed.failure.message;
      return 'Could not close the receipt';
    } catch (error) {
      this.#loggerFor(active).debug('[App] close receipt failed: ' + messageOf(error));
      return 'Could not close the receipt: ' + messageOf(error);
    }
  }

  /** Fetches the e-receipt of an inquired transaction. Never throws. */
  async fetchReceipt(current) {
    const registered = this.#repository.findBySerial(current.request.terminalSerial);
    if (registered === null) return unavailable(`Terminal ${current.request.terminalSerial} is no longer registered`);
    const found = current.inquiry instanceof Found ? current.inquiry : null;
    const receiptNumber = found !== null && found.transaction.stan.trim() !== '' ? found.transaction.stan : current.request.receiptNumber;
    if (receiptNumber.trim() === '') return unavailable('This transaction has no receipt number to fetch a receipt by');
    const day = found !== null ? TransactionEngine.dayOf(found.transaction.transactionTime) : '';
    const transactionDate = day !== '' ? day : current.request.transactionDate;
    const active = this.resolveConfig(registered);
    if (!active.isReady()) return unavailable(active.issues().join('\n'));
    try {
      return await this.#open(registered, active).receipt(receiptNumber, transactionDate, { originalTerminalId: current.request.originalTerminalId });
    } catch (error) {
      // A receipt reads and nothing more, so failing to get one is never worse than not asking.
      this.#loggerFor(active).debug('[App] receipt failed: ' + messageOf(error));
      return unavailable(messageOf(error));
    }
  }

  /** The backend's `2026-08-09T16:58:16` as `yyyyMMdd`, or "". */
  static dayOf(transactionTime) {
    const digits = transactionTime.replace(/[^0-9]/g, '');
    return digits.length >= 8 ? digits.slice(0, 8) : '';
  }

  /** Same shape the SDK generates: 12 uppercase hex characters. */
  static newReference() {
    return EcrSessions.newMerchantReference();
  }

  #open(registered, active) {
    return EcrSessions.open(registered.serialNumber, active.plan, { logger: this.#loggerFor(active) });
  }

  #loggerFor(config) {
    const tag = config.usesWebService() ? 'EcrWebService' : 'Ecr';
    const log = this.#log;
    return EcrLogger.from((message) => log.append(tag, message));
  }
}

function unavailable(reason) {
  return new ReceiptUnavailable('', reason, '');
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
