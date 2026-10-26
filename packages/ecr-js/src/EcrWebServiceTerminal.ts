import { Amount } from './Amount.js';
import { EcrConfig } from './EcrConfig.js';
import { EcrTransactionType } from './EcrTransactionType.js';
import { InvalidRequestException } from './exception/InvalidRequestException.js';
import { ConnectionLost, Malformed } from './failure/Failure.js';
import { EcrMessage } from './internal/EcrMessage.js';
import { MerchantReference } from './internal/MerchantReference.js';
import { trim } from './internal/text.js';
import { Validate } from './internal/Validate.js';
import { WireReaders } from './internal/WireReaders.js';
import { Json, type JsonObject } from './json/Json.js';
import { EcrLogger } from './log/EcrLogger.js';
import {
  CloseReceiptFailed,
  type EcrInquiry,
  type EcrReceiptClosed,
  type EcrResult,
  Failed,
  InquiryFailed,
} from './result/results.js';
import { FinancialGuard } from './safety/FinancialGuard.js';
import type { HttpTransport } from './webservice/http/HttpTransport.js';
import { WebServiceApi } from './webservice/WebServiceApi.js';
import { WebServiceHttpLog } from './webservice/WebServiceHttpLog.js';
import { WebServiceMessage } from './webservice/WebServiceMessage.js';
import { WebServiceOperation } from './webservice/WebServiceOperation.js';

/** Optional collaborators for a Web Service terminal. */
export interface EcrWebServiceTerminalOptions {
  logger?: EcrLogger | null;
  /** How the HTTPS post is made. Default: Node's `https`. The URL is always the SDK's. */
  http?: HttpTransport | null;
  guard?: FinancialGuard | null;
}

type Ids = [bigint, bigint];

const INVALID_IDS = 'merchantId and terminalId are required for Web Service ECR';

/**
 * ECR Web Service client: REST over HTTPS to the Amwal Hub, with signed JSON
 * bodies. Use it when the terminal is configured for Web Service mode
 * (`ecrMode: 4`).
 *
 * A lost or unreadable answer arrives as {@link Failed} with an outcome-unknown
 * failure, and is never followed by an automatic inquiry
 * (`Failed.recovered` is always null): inquire by reference yourself.
 */
export class EcrWebServiceTerminal {
  private readonly ecrConfig: EcrConfig;
  private readonly logger: EcrLogger;
  private readonly api: WebServiceApi;
  private readonly financialGuard: FinancialGuard;

  /**
   * The config is used as given: the HTTP deadline is connect + answer
   * timeout. {@link EcrSessions.plan} raises the Wi-Fi answer wait to
   * {@link EcrConfig.WEB_SERVICE_RESPONSE_TIMEOUT}; a terminal built directly
   * keeps whatever the config says, as in the Windows SDK.
   */
  constructor(
    private readonly terminalSerial: string,
    config: EcrConfig = new EcrConfig(),
    options: EcrWebServiceTerminalOptions = {},
  ) {
    this.ecrConfig = config;
    this.logger = options.logger ?? EcrLogger.none();
    this.api = new WebServiceApi(this.ecrConfig, this.logger, options.http ?? null);
    this.financialGuard = options.guard ?? FinancialGuard.fromConfig(this.ecrConfig, this.logger);
  }

  /** Identifies this terminal to the guard's lock and journal. */
  terminalKey(): string {
    return `ws|${this.ecrConfig.environment.value}|${trim(this.ecrConfig.merchantId)}|${trim(this.ecrConfig.terminalId)}`;
  }

  guard(): FinancialGuard {
    return this.financialGuard;
  }

  config(): EcrConfig {
    return this.ecrConfig;
  }

  /** @param amount Major units, e.g. "1.234". */
  async sale(amount: string | number | bigint | Amount, merchantReference = ''): Promise<EcrResult> {
    const ids = this.backendIds();
    if (ids === null) return EcrWebServiceTerminal.invalidIds();
    const minor = Amount.of(amount).toMinorUnits(this.ecrConfig.minorUnitDigits);
    return this.money(EcrTransactionType.Sale, WebServiceOperation.Sale, ids, merchantReference, minor);
  }

  async void(receiptNumber: string, merchantReference = ''): Promise<EcrResult> {
    const ids = this.backendIds();
    if (ids === null) return EcrWebServiceTerminal.invalidIds();
    return this.money(EcrTransactionType.Void, WebServiceOperation.Void, ids, merchantReference, null, receiptNumber);
  }

  /** @param transactionDate The original's day as `yyyyMMdd`. */
  async refund(amount: string | number | bigint | Amount, receiptNumber: string, transactionDate: string, merchantReference = ''): Promise<EcrResult> {
    const ids = this.backendIds();
    if (ids === null) return EcrWebServiceTerminal.invalidIds();
    const minor = Amount.of(amount).toMinorUnits(this.ecrConfig.minorUnitDigits);
    return this.money(EcrTransactionType.Refund, WebServiceOperation.Refund, ids, merchantReference, minor, receiptNumber, transactionDate);
  }

  async inquire(receiptNumber: string, transactionDate: string, merchantReference = ''): Promise<EcrInquiry> {
    const ids = this.backendIds();
    if (ids === null) return new InquiryFailed(merchantReference, new Malformed(INVALID_IDS));
    const [reference, body] = this.build(EcrTransactionType.Inquiry, ids, merchantReference, {
      stan: receiptNumber,
      originalTransactionDate: transactionDate,
    });
    return this.readInquiry(await this.api.postJson(WebServiceOperation.TransactionStatus, body), reference);
  }

  /**
   * Looks up the transaction sent as `originalReference`. The answer to an
   * outcome you never received.
   *
   * @param transactionDate Optional. Do not invent "today": the Hub filters by that day.
   */
  async inquireByReference(originalReference: string, transactionDate = '', merchantReference = ''): Promise<EcrInquiry> {
    if (Validate.isBlank(originalReference)) {
      throw new InvalidRequestException("An inquiry by reference needs the original's reference");
    }
    const original = MerchantReference.resolve(originalReference);
    const ids = this.backendIds();
    if (ids === null) return new InquiryFailed(merchantReference, new Malformed(INVALID_IDS));
    const [reference, body] = this.build(EcrTransactionType.Inquiry, ids, merchantReference, {
      originalTransactionDate: transactionDate,
      originalMerchantReference: original,
    });
    const inquiry = this.readInquiry(await this.api.postJson(WebServiceOperation.TransactionStatus, body), reference);
    await this.financialGuard.observeInquiry(this.terminalKey(), original, inquiry);
    return inquiry;
  }

  /**
   * Posts `/Ecr/closeReceipt` for the sale, void or refund sent as
   * `originalMerchantReference`. Call it from the Close receipt action; it is
   * never sent automatically.
   *
   * @param merchantReference This close request's own id. Blank: generated.
   */
  async closeReceipt(originalMerchantReference: string, merchantReference = ''): Promise<EcrReceiptClosed> {
    if (Validate.isBlank(originalMerchantReference)) {
      return new CloseReceiptFailed(merchantReference, new Malformed('Close receipt needs the original merchant reference'));
    }
    const ids = this.backendIds();
    if (ids === null) return new CloseReceiptFailed(merchantReference, new Malformed(INVALID_IDS));
    const [reference, body] = WebServiceMessage.buildCloseReceipt({
      merchantId: ids[0],
      terminalId: ids[1],
      terminalSerial: this.terminalSerial,
      secureHashKey: this.ecrConfig.secureHashKey,
      ecrId: this.ecrConfig.ecrId,
      merchantReference,
      originalMerchantReference,
      transactionDateTime: EcrMessage.timestamp(this.ecrConfig),
    });
    Json.write(body);
    WebServiceHttpLog.operation(this.logger, EcrTransactionType.CloseReceipt.messageType(), reference, this.terminalSerial, ids[0], ids[1]);
    return WireReaders.toReceiptClosed(await this.api.postJson(WebServiceOperation.CloseReceipt, body), reference);
  }

  /**
   * The ID as a 64-bit integer, or null: `long.TryParse` with
   * `NumberStyles.Integer`, so surrounding white space and a leading sign are
   * accepted.
   */
  static id(text: string): bigint | null {
    const m = /^([+-]?)([0-9]+)$/.exec(trim(String(text ?? ''), ' \t\n\v\f\r'));
    if (m === null) return null;
    const value = BigInt(m[1] === '-' ? '-' + m[2] : m[2]!);
    return value < -(2n ** 63n) || value > 2n ** 63n - 1n ? null : value;
  }

  private async money(
    type: EcrTransactionType,
    operation: WebServiceOperation,
    ids: Ids,
    merchantReference: string,
    minor: bigint | null = null,
    stan = '',
    date = '',
  ): Promise<EcrResult> {
    const [reference, body] = this.build(type, ids, MerchantReference.resolve(merchantReference), {
      amountMinorUnits: minor,
      stan,
      originalTransactionDate: date,
    });
    return this.financialGuard.run(
      this.terminalKey(),
      type,
      reference,
      minor === null ? '' : String(minor),
      this.ecrConfig.currencyCode,
      async () => WireReaders.toResult(await this.api.postJson(operation, body), reference, this.ecrConfig.minorUnitDigits),
    );
  }

  private readInquiry(response: JsonObject, reference: string): EcrInquiry {
    // A transport failure is synthesised as an answer with no data, which
    // would read as "not found", and a till told nothing was taken may
    // charge again. It is a failed lookup, not a finding.
    if (response.str('nextStep') === WebServiceApi.UNKNOWN_OUTCOME_STEP && response.get('data') === null) {
      const reason = response.str('message');
      return new InquiryFailed(reference, new ConnectionLost(reason !== '' ? reason : 'The Web Service did not answer'));
    }
    return WireReaders.toInquiry(response, reference, this.ecrConfig.minorUnitDigits);
  }

  private build(
    type: EcrTransactionType,
    ids: Ids,
    merchantReference: string,
    parts: { amountMinorUnits?: bigint | null; stan?: string; originalTransactionDate?: string; originalMerchantReference?: string },
  ): [string, JsonObject] {
    const [reference, body] = WebServiceMessage.build(type, {
      merchantId: ids[0],
      terminalId: ids[1],
      terminalSerial: this.terminalSerial,
      secureHashKey: this.ecrConfig.secureHashKey,
      currencyCode: this.ecrConfig.currencyCode,
      ecrId: this.ecrConfig.ecrId,
      merchantReference,
      transactionDateTime: EcrMessage.timestamp(this.ecrConfig),
      ...parts,
    });
    Json.write(body); // refuses text that is not UTF-8, before anything is sent
    WebServiceHttpLog.operation(this.logger, type.messageType(), reference, this.terminalSerial, ids[0], ids[1]);
    return [reference, body];
  }

  private backendIds(): Ids | null {
    const merchant = EcrWebServiceTerminal.id(this.ecrConfig.merchantId);
    const terminal = EcrWebServiceTerminal.id(this.ecrConfig.terminalId);
    return merchant === null || terminal === null ? null : [merchant, terminal];
  }

  private static invalidIds(): Failed {
    return new Failed('', new Malformed('merchantId and terminalId must be set on EcrConfig for Web Service ECR'));
  }
}
