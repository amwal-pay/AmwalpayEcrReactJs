import type { Amount } from '../Amount.js';
import type { EcrConfig } from '../EcrConfig.js';
import type { EcrTransactionType } from '../EcrTransactionType.js';
import { LogicException } from '../exception/errors.js';
import { JsonObject } from '../json/Json.js';
import { MerchantReference } from './MerchantReference.js';
import { SecureHash } from './SecureHash.js';
import { LocalTime } from './LocalTime.js';
import { Validate } from './Validate.js';

/** The options {@link EcrMessage.build} takes beyond the type and config. Optional fields are sent as given when not blank. */
export interface EcrMessageParts {
  amount?: Amount | null;
  stan?: string;
  originalTerminalId?: string;
  originalDate?: string;
  originalReference?: string;
  merchantReference?: string;
}

/**
 * A Wi-Fi request as it goes on the wire.
 *
 * Fields that do not apply to the operation are left out entirely, so the
 * terminal can read a field's presence as meaning the operation uses it.
 *
 * @internal
 */
export class EcrMessage {
  /**
   * Bumped when the message format changes in a way older terminals cannot
   * read. Present from the first release so a terminal can tell.
   */
  static readonly PROTOCOL_VERSION = 1;

  private constructor(
    readonly merchantReference: string,
    readonly json: JsonObject,
  ) {}

  /**
   * The nonce this request went out with, empty when unsigned. An answer
   * carrying a different nonce is an answer to some other request.
   */
  nonce(): string {
    return this.json.str('nonce');
  }

  /**
   * Builds and, when the config has a key, signs one request. Optional fields
   * are sent as given when not blank; `stan` is padded here.
   */
  static build(type: EcrTransactionType, config: EcrConfig, terminalSerial: string, parts: EcrMessageParts = {}): EcrMessage {
    const { amount = null, stan = '', originalTerminalId = '', originalDate = '', originalReference = '', merchantReference = '' } = parts;
    const reference = MerchantReference.resolve(merchantReference);
    const body = new JsonObject()
      .set('version', EcrMessage.PROTOCOL_VERSION)
      .set('messageType', type.messageType())
      .set('merchantReference', reference)
      .set('terminalSerial', terminalSerial)
      .set('currencyCode', config.currencyCode)
      .set('transactionDateTime', EcrMessage.timestamp(config))
      .set('ecrId', config.ecrId);

    if (type.requiresAmount()) {
      if (amount === null) throw new LogicException(`${type.displayName()} needs an amount`);
      body.set('amount', amount.toWire(config.minorUnitDigits));
    }
    if (type.requiresOriginalStan() && !Validate.isBlank(stan)) body.set('stan', Validate.paddedStan(stan));
    if (type.allowsOtherTerminal() && !Validate.isBlank(originalTerminalId)) body.set('originalTerminalId', originalTerminalId);
    if (type.requiresOriginalDate() && !Validate.isBlank(originalDate)) body.set('originalTransactionDate', originalDate);
    // Names the transaction being looked up in place of its receipt number.
    // Only a read-only type may: acting on a transaction still goes by the
    // number on the printed receipt.
    if (!type.movesMoney() && !Validate.isBlank(originalReference)) {
      body.set('originalMerchantReference', MerchantReference.resolve(originalReference));
    }

    // The nonce is what makes a captured message useless a second time: the
    // terminal remembers the ones it has seen and refuses a repeat. It means
    // something only alongside a signature.
    if (config.signsMessages()) {
      body.set('nonce', SecureHash.newNonce());
      body.set(SecureHash.FIELD, SecureHash.sign(SecureHash.compose(body), config.secureHashKey));
    }

    return new EcrMessage(reference, body);
  }

  /** `yyyyMMddHHmmss` in the machine's local time (`DateTime.Now`), or in `timezone` when set. */
  static timestamp(config: Pick<EcrConfig, 'timezone'>, now: Date = new Date()): string {
    return LocalTime.stamp(config.timezone, now);
  }
}

/** `yyyyMMddHHmmss` of `date` in `timeZone` (undefined: the machine's local zone). @internal */
export function formatTimestamp(date: Date, timeZone?: string): string {
  return LocalTime.stamp(timeZone ?? null, date);
}
