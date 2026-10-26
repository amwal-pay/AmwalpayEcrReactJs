import { Amount } from './Amount.js';
import { EcrChannelTimeout, EcrIOException, type EcrChannel } from './channel/EcrChannel.js';
import { TcpEcrChannel } from './channel/TcpEcrChannel.js';
import { EcrConfig } from './EcrConfig.js';
import { EcrReachability } from './EcrReachability.js';
import { EcrTransactionType } from './EcrTransactionType.js';
import { InvalidRequestException } from './exception/InvalidRequestException.js';
import { ConnectionLost, type Failure, Malformed, Timeout, Unauthenticated, Unreachable } from './failure/Failure.js';
import { formatDuration } from './internal/duration.js';
import { EcrMessage, type EcrMessageParts } from './internal/EcrMessage.js';
import { EcrMessageCodec } from './internal/EcrMessageCodec.js';
import { LanLog } from './internal/LanLog.js';
import { MerchantReference } from './internal/MerchantReference.js';
import { SecureHash } from './internal/SecureHash.js';
import { Validate } from './internal/Validate.js';
import { WireReaders } from './internal/WireReaders.js';
import { Json, JsonObject } from './json/Json.js';
import { EcrLogger } from './log/EcrLogger.js';
import {
  CloseReceiptFailed,
  type EcrInquiry,
  type EcrReceipt,
  type EcrReceiptClosed,
  type EcrResult,
  Failed,
  InquiryFailed,
  ReceiptFailed,
} from './result/results.js';
import { FinancialGuard } from './safety/FinancialGuard.js';

/** Optional collaborators for a terminal. */
export interface EcrTerminalOptions {
  /** Where diagnostics go. Default: {@link EcrLogger.none}. */
  logger?: EcrLogger | null;
  /** The payment-safety guard. Default: file-based, from the config. */
  guard?: FinancialGuard | null;
}

/** Names the original transaction on another terminal, and this request's own reference. */
export interface OriginalOptions {
  /** The terminal the original was taken on, when not this one. */
  originalTerminalId?: string;
  /** This request's own reference, not the original's. Blank: generated. */
  merchantReference?: string;
}

/** What {@link EcrTerminal.run} takes beyond the type. */
export interface RunOptions {
  amount?: string | number | bigint | Amount | null;
  originalStan?: string;
  originalTerminalId?: string;
  originalDate?: string;
  merchantReference?: string;
}

/**
 * A POS terminal reachable over Wi-Fi/LAN.
 *
 * One instance addresses one terminal and holds no connection between calls,
 * so it is cheap to keep and safe to reuse.
 *
 * ```ts
 * const terminal = EcrSessions.lanTerminal('SN-WIFI-0001', plan);
 * const result = await terminal.sale('1.234', 'ORDER-1001-1');
 * ```
 *
 * Every request is signed when the config has a key, and every answer must
 * then be signed with the same key and echo the request's nonce, or it is
 * discarded as {@link Unauthenticated}: anything on the network that answers on
 * the terminal's port could otherwise claim "approved" for a payment that never
 * happened.
 */
export class EcrTerminal {
  private readonly channel: EcrChannel;
  private readonly logger: EcrLogger;
  private readonly financialGuard: FinancialGuard;

  /**
   * @param channel The terminal's host or IP address, or a channel that carries the bytes.
   * @param serialNumber Identifies the terminal in the message: the serial the operator registered.
   */
  constructor(
    channel: EcrChannel | string,
    private readonly serialNumber: string = '',
    private readonly ecrConfig: EcrConfig = new EcrConfig(),
    options: EcrTerminalOptions = {},
  ) {
    this.channel = typeof channel === 'string'
      ? new TcpEcrChannel(channel, ecrConfig.port, ecrConfig.connectTimeout)
      : channel;
    this.logger = options.logger ?? EcrLogger.none();
    this.financialGuard = options.guard ?? FinancialGuard.fromConfig(ecrConfig, this.logger);
  }

  /** Identifies this physical terminal to the guard's lock and journal. */
  terminalKey(): string {
    return `wifi|${this.channel.host().toLowerCase()}|${this.channel.port()}`;
  }

  guard(): FinancialGuard {
    return this.financialGuard;
  }

  config(): EcrConfig {
    return this.ecrConfig;
  }

  /** Whether the terminal is listening. Proves the port is open, not that the terminal is idle. */
  async isReachable(): Promise<boolean> {
    return (await this.probeReachability()).reachable;
  }

  /**
   * Asks the channel whether the terminal is there, before sending anything.
   * Worth calling before a sale: a wrong address becomes an immediate answer
   * rather than a failure the cardholder waits through.
   */
  async probeReachability(): Promise<EcrReachability> {
    const problem = await this.channel.probe(this.ecrConfig.probeTimeout);
    if (problem !== null) this.logger.debug(`Probe failed for ${this.channel.endpoint()} — ${problem}`);
    return new EcrReachability(problem === null, this.channel.host(), this.channel.port(), problem, this.channel.endpoint());
  }

  /**
   * Takes a payment. The cardholder presents the card at the terminal.
   *
   * @param amount Major units, e.g. "1.234".
   * @param merchantReference This attempt's own reference. Save it before calling. Blank: generated.
   * @throws InvalidRequestException nothing was sent
   */
  sale(amount: string | number | bigint | Amount, merchantReference = ''): Promise<EcrResult> {
    return this.run(EcrTransactionType.Sale, { amount, merchantReference });
  }

  /**
   * Cancels an earlier transaction for its full amount, by its receipt number.
   * `merchantReference` is the void's own reference, not the original's.
   */
  void(receiptNumber: string, options: OriginalOptions = {}): Promise<EcrResult> {
    return this.run(EcrTransactionType.Void, {
      originalStan: receiptNumber,
      originalTerminalId: options.originalTerminalId ?? '',
      merchantReference: options.merchantReference ?? '',
    });
  }

  /**
   * Returns money against an earlier transaction, in full or in part.
   *
   * @param transactionDate The original's day as `yyyyMMdd`: a receipt number is unique only within a day.
   */
  refund(amount: string | number | bigint | Amount, receiptNumber: string, transactionDate: string, options: OriginalOptions = {}): Promise<EcrResult> {
    return this.run(EcrTransactionType.Refund, {
      amount,
      originalStan: receiptNumber,
      originalTerminalId: options.originalTerminalId ?? '',
      originalDate: transactionDate,
      merchantReference: options.merchantReference ?? '',
    });
  }

  /**
   * Asks what became of an earlier transaction by its receipt number, without
   * touching it. Safe to repeat; answered even while the terminal is busy.
   * `merchantReference` is the inquiry's own reference, not a way to look a transaction up.
   */
  async inquire(receiptNumber: string, transactionDate: string, options: OriginalOptions = {}): Promise<EcrInquiry> {
    if (Validate.isBlank(receiptNumber)) throw new InvalidRequestException('An inquiry needs a receipt number');
    const message = this.build(EcrTransactionType.Inquiry, {
      stan: receiptNumber,
      originalTerminalId: options.originalTerminalId ?? '',
      originalDate: transactionDate ?? '',
      merchantReference: options.merchantReference ?? '',
    });
    const answer = await this.exchange(message);
    return answer instanceof JsonObject
      ? WireReaders.toInquiry(answer, message.merchantReference, this.ecrConfig.minorUnitDigits)
      : new InquiryFailed(message.merchantReference, answer);
  }

  /**
   * Asks what became of the transaction this till sent as `originalReference`.
   *
   * This is the answer to an outcome you never received: after a timeout or a
   * lost connection there is no receipt number to quote, but the reference
   * you sent the request with is still yours. Never retry instead.
   *
   * `transactionDate` is optional: a reference is not scoped to a day. Do not invent "today".
   *
   * @throws InvalidRequestException `originalReference` is blank or malformed
   */
  async inquireByReference(
    originalReference: string,
    options: OriginalOptions & { transactionDate?: string } = {},
  ): Promise<EcrInquiry> {
    if (Validate.isBlank(originalReference)) {
      throw new InvalidRequestException("An inquiry by reference needs the original's reference");
    }
    const original = MerchantReference.resolve(originalReference);
    const message = this.build(EcrTransactionType.Inquiry, {
      originalTerminalId: options.originalTerminalId ?? '',
      originalDate: options.transactionDate ?? '',
      originalReference: original,
      merchantReference: options.merchantReference ?? '',
    });
    const answer = await this.exchange(message);
    const inquiry = answer instanceof JsonObject
      ? WireReaders.toInquiry(answer, message.merchantReference, this.ecrConfig.minorUnitDigits)
      : new InquiryFailed(message.merchantReference, answer);
    await this.financialGuard.observeInquiry(this.terminalKey(), original, inquiry);
    return inquiry;
  }

  /** Fetches an earlier transaction's e-receipt URL, for a QR code. Non-financial and repeatable. */
  async receipt(receiptNumber: string, transactionDate: string, options: OriginalOptions = {}): Promise<EcrReceipt> {
    if (Validate.isBlank(receiptNumber)) throw new InvalidRequestException('A receipt needs a receipt number');
    const message = this.build(EcrTransactionType.Receipt, {
      stan: receiptNumber,
      originalTerminalId: options.originalTerminalId ?? '',
      originalDate: transactionDate ?? '',
      merchantReference: options.merchantReference ?? '',
    });
    const answer = await this.exchange(message);
    return answer instanceof JsonObject
      ? WireReaders.toReceipt(answer, message.merchantReference)
      : new ReceiptFailed(message.merchantReference, answer);
  }

  /**
   * Asks the terminal to put its receipt away and return to its idle screen.
   * Call it from the till's Close receipt action when the cashier is finished,
   * not as a side effect of dismissing a dialog. Firmware too old to know it
   * answers {@link CloseReceiptRefused}.
   */
  async closeReceipt(merchantReference = ''): Promise<EcrReceiptClosed> {
    const message = this.build(EcrTransactionType.CloseReceipt, { merchantReference });
    const answer = await this.exchange(message);
    return answer instanceof JsonObject
      ? WireReaders.toReceiptClosed(answer, message.merchantReference)
      : new CloseReceiptFailed(message.merchantReference, answer);
  }

  /**
   * Runs any operation that moves money. The typed methods above are the usual
   * way in; this is for a till driving the type from its own form.
   *
   * @throws InvalidRequestException nothing was sent
   */
  async run(type: EcrTransactionType, options: RunOptions = {}): Promise<EcrResult> {
    const { amount = null, originalStan = '', originalTerminalId = '', originalDate = '', merchantReference = '' } = options;
    if (!type.movesMoney()) {
      throw new InvalidRequestException(`${type.displayName()} is run with inquire()`);
    }
    if (type.requiresAmount() && amount === null) throw new InvalidRequestException(`${type.displayName()} needs an amount`);
    if (type.requiresOriginalStan() && Validate.isBlank(originalStan)) {
      throw new InvalidRequestException(`${type.displayName()} needs the original's receipt number`);
    }
    const money = amount === null ? null : Amount.of(amount);

    // Built, signed and serialised before the guard records anything, so a
    // request that cannot be built never leaves a "pending" entry behind.
    const message = this.build(type, {
      amount: money,
      stan: originalStan,
      originalTerminalId,
      originalDate,
      merchantReference: MerchantReference.resolve(merchantReference),
    });

    return this.financialGuard.run(
      this.terminalKey(),
      type,
      message.merchantReference,
      money === null ? '' : money.minorUnitsText(this.ecrConfig.minorUnitDigits),
      this.ecrConfig.currencyCode,
      async () => {
        const answer = await this.exchange(message);
        return answer instanceof JsonObject
          ? WireReaders.toResult(answer, message.merchantReference, this.ecrConfig.minorUnitDigits)
          : this.lost(message.merchantReference, answer);
      },
    );
  }

  /** `45s`, `2m`, `1m 30s`. */
  static formatDuration(seconds: number): string {
    return formatDuration(seconds);
  }

  /**
   * Turns a lost exchange into a result, asking the terminal once, on a fresh
   * connection, what became of the transaction. An inquiry reads and nothing
   * more, so this cannot itself move money however it goes. The finding is
   * attached, not substituted: the exchange still failed.
   */
  private async lost(reference: string, failure: Failure): Promise<Failed> {
    const plain = new Failed(reference, failure);
    if (!this.ecrConfig.autoInquireOnFailure || !failure.outcomeUnknown() || reference === '') return plain;
    this.logger.debug(`Lost the answer for ${reference} — asking what became of it`);
    let found: EcrInquiry | null;
    try {
      found = await this.inquireByReference(reference);
    } catch {
      found = null;
    }
    return plain.withRecovered(found);
  }

  private build(type: EcrTransactionType, parts: EcrMessageParts): EcrMessage {
    const message = EcrMessage.build(type, this.ecrConfig, this.serialNumber, parts);
    const wire = Json.write(message.json); // refuses text that is not UTF-8, before anything is sent
    this.logger.debug(`Sending ${type.messageType()} ${message.merchantReference} to ${this.channel.endpoint()}`);
    this.logger.debug(wire);
    if (this.ecrConfig.signsMessages()) {
      const hash = message.json.str(SecureHash.FIELD);
      if (hash !== '') {
        LanLog.signing(this.logger, SecureHash.KEY_LABEL, true, SecureHash.compose(message.json), hash, message.nonce());
      }
    }
    return message;
  }

  /** One request, one answer, or why there was none. */
  private async exchange(message: EcrMessage): Promise<JsonObject | Failure> {
    try {
      const reply = await this.channel.exchange(Json.write(message.json), this.ecrConfig.responseTimeout);
      const answer = EcrMessageCodec.parse(reply);
      this.logger.debug('Received ' + answer.toJson());

      const rejection = this.untrustworthy(answer, message);
      if (rejection !== null) {
        this.logger.debug('Rejected the answer: ' + rejection.message);
        return rejection;
      }
      return answer;
    } catch (error) {
      if (error instanceof EcrChannelTimeout) {
        // Not a refusal: the terminal may have completed the payment and been unable to say so.
        return new Timeout(
          `The terminal did not answer within ${formatDuration(this.ecrConfig.responseTimeout)}. `
          + 'The transaction may still have completed — inquire before retrying.',
        );
      }
      if (error instanceof EcrIOException) return EcrTerminal.toFailure(error, this.channel.endpoint());
      throw error;
    }
  }

  /**
   * Why this answer must not be believed, or null when it can be. A rejected
   * answer says nothing about what the terminal did, so it is an unknown
   * outcome, never a decline.
   */
  private untrustworthy(answer: JsonObject, sent: EcrMessage): Failure | null {
    if (!this.ecrConfig.signsMessages()) return null;
    const presented = answer.str(SecureHash.FIELD);
    const verified = SecureHash.verify(answer, this.ecrConfig.secureHashKey);
    if (presented !== '') {
      LanLog.verifyResponse(this.logger, SecureHash.KEY_LABEL, true, SecureHash.compose(answer), presented, verified);
    }
    if (!verified) return new Unauthenticated("The answer was not signed with this terminal's key.");
    // Binds the answer to this request: a correctly signed answer to an
    // earlier transaction, replayed onto this connection, fails here.
    if (!SecureHash.equals(sent.nonce(), answer.str('nonce'))) {
      return new Unauthenticated(
        'The answer belongs to a different request. The transaction may still have completed — inquire before retrying.',
      );
    }
    return null;
  }

  private static toFailure(error: EcrIOException, endpoint: string): Failure {
    const reason = error.message !== '' ? error.message : error.name;
    if (reason.includes('not valid JSON') || reason.includes('empty message')) return new Malformed(reason);
    if (reason.includes('closed the connection')) return new ConnectionLost(reason);
    return new Unreachable(`${reason} (${endpoint})`);
  }
}
