import {
  EcrConfig, EcrEnvironment, EcrSessions, EcrTransactionType, LanLink, ReceiptFailed, ReceiptReady, ReceiptUnavailable, WebServiceLink,
} from '@amwalpay/ecr-js';
import { AmountEntry } from '../core/AmountEntry.js';
import { EcrMode } from '../core/EcrMode.js';
import { ResultPresenter } from '../core/ResultPresenter.js';
import { isoDay, startOfToday, TransactionFormState } from '../core/TransactionFormState.js';
import { StateCompleted, StateInquired } from '../core/TransactionState.js';

const DIALOG_KEYS = [
  'headline', 'tone', 'amount', 'message', 'note', 'fields', 'hints', 'rawPayload', 'isUnknownOutcome', 'inquirableReference',
  'unknownOutcomeWarning', 'offersReceipt', 'receiptNote', 'receipt', 'canCloseReceipt',
];

/**
 * The wire contract with the page: the same JSON shapes, names and wording as
 * the web sample's Dtos.cs and the PHP sample's Views.php, so the page is the same page.
 */
export class Views {
  static terminal(t) {
    return {
      serialNumber: t.serialNumber,
      name: t.name,
      ecrMode: t.ecrMode,
      modeLabel: t.modeLabel(),
      ipAddress: t.ipAddress,
      port: t.port,
      terminalId: t.terminalId,
      merchantId: t.merchantId,
      displayName: t.displayName(),
      connectionSummary: t.connectionSummary(),
      supported: t.mode().isSupportedInExample(),
    };
  }

  /** The config card. Nothing about a stored key beyond whether one is set. */
  static config(c) {
    return {
      serialNumber: c.terminal.serialNumber,
      modeLabel: c.modeLabel(),
      transportLabel: c.transportLabel(),
      connectionSummary: c.connectionSummary(),
      keyLabel: c.hashKeyLabel(),
      keyConfigured: c.hashKeyConfigured(),
      keyStatus: c.hashKeyConfigured() ? 'configured' : 'not configured — set in Settings',
      issues: c.issues(),
      isReady: c.isReady(),
      isSupported: c.isSupported(),
      usesWebService: c.usesWebService(),
    };
  }

  /** The settings the browser may see: deliberately no key value, only whether one is stored. */
  static settings(s) {
    return {
      environment: s.environment().value,
      wifi: { label: Views.keyLabel(EcrMode.Wifi), configured: s.wifiSecureHashKey() !== '' },
      webService: { label: Views.keyLabel(EcrMode.WebService), configured: s.webServiceSecureHashKey() !== '' },
      notice: s.saveError ?? s.loadWarning,
    };
  }

  /** The label the SDK plan uses for the mode's key, so it is not typed out a second time. */
  static keyLabel(mode) {
    const link = mode === EcrMode.WebService ? new WebServiceLink('1', '1') : new LanLink('127.0.0.1');
    return EcrSessions.plan(link, new EcrConfig()).signingKeyLabel();
  }

  static transaction(run) {
    const state = run.state;
    const model = ResultPresenter.for(state, run.usesWebService);
    let dialog = null;
    if (model !== null) {
      const inquired = state instanceof StateInquired ? state : null;
      const receipt = inquired?.receipt ?? null;
      let problem = null;
      if (receipt instanceof ReceiptUnavailable) problem = receipt.reason !== '' ? receipt.reason : 'No receipt is available for this transaction';
      else if (receipt instanceof ReceiptFailed) problem = receipt.failure.message;
      const full = {
        ...model,
        unknownOutcomeWarning: model.isUnknownOutcome ? ResultPresenter.UNKNOWN_OUTCOME_WARNING : null,
        receipt: {
          showButton: model.offersReceipt && inquired !== null && inquired.receipt === null && !inquired.fetchingReceipt,
          fetching: inquired?.fetchingReceipt === true,
          url: receipt instanceof ReceiptReady ? receipt.url : null,
          problem,
        },
        canCloseReceipt: state instanceof StateCompleted,
      };
      // Same key order as the web sample's DialogView.
      dialog = Object.fromEntries(DIALOG_KEYS.map((key) => [key, full[key]]));
    }
    return {
      id: run.id,
      terminalSerial: run.terminalSerial,
      operation: run.request.type.displayName(),
      state: state.name(),
      busy: state.isBusy(),
      isResult: state.isResult(),
      statusText: state.name() === 'checking' ? 'Checking the terminal…' : 'Waiting for the POS terminal…',
      version: run.version,
      dialog,
      timeoutSeconds: run.timeoutSeconds,
      remainingSeconds: run.remainingSeconds,
    };
  }

  /** `GET /api/meta`: what the page needs to build its form, from the SDK's flags and the form state. */
  static meta() {
    const operations = EcrTransactionType.menuOptions().map((type) => {
      const layouts = {};
      for (const other of [false, true]) {
        for (const byReference of [false, true]) {
          // Asked of the same form state the server validates with, so
          // "shown" and "required" cannot drift apart.
          const form = new TransactionFormState({ type, useOtherTerminal: other, lookUpByReference: byReference });
          layouts[`${other ? 1 : 0}${byReference ? 1 : 0}`] = {
            amount: type.requiresAmount(),
            merchantReference: form.showMerchantReference(),
            referenceSwitch: form.showReferenceSwitch(),
            originalReference: form.looksUpByReference(),
            receiptNumber: form.showReceiptNumber(),
            originalDate: form.showOriginalDate(),
            otherTerminalSwitch: form.showOtherTerminalSwitch(),
            originalTerminal: form.showOriginalTerminal(),
          };
        }
      }
      return {
        value: type.value,
        label: type.displayName(),
        requiresAmount: type.requiresAmount(),
        requiresOriginalStan: type.requiresOriginalStan(),
        requiresOriginalDate: type.requiresOriginalDate(),
        allowsOtherTerminal: type.allowsOtherTerminal(),
        movesMoney: type.movesMoney(),
        amountHelp: type.requiresAmount() ? '' : type === EcrTransactionType.Inquiry ? 'An inquiry only reads; nothing is charged' : "Uses the original transaction's amount",
        startButtonText: type === EcrTransactionType.Inquiry ? 'Look up transaction' : 'Start transaction',
        layouts,
      };
    });
    return {
      operations,
      modes: EcrMode.all().map((m) => ({
        value: m.value,
        label: m.label(),
        ipBased: m.isIpBased(),
        supported: m.isSupportedInExample(),
        hint: m.isSupportedInExample() ? '' : `Not available in this sample — the JavaScript SDK has no ${m === EcrMode.UsbCable ? 'USB' : 'Bluetooth'} channel.`,
        note: m === EcrMode.UsbCable
          ? 'USB cable ECR cannot be exercised from the JavaScript sample: the JavaScript SDK opens Wi-Fi and Web Service only.'
          : m === EcrMode.Bluetooth ? 'Bluetooth ECR cannot be exercised from this sample.' : '',
      })),
      environments: EcrEnvironment.cases().map((e) => e.value),
      amount: {
        min: AmountEntry.formatMills(AmountEntry.MIN_MILLS),
        max: AmountEntry.formatMills(AmountEntry.MAX_MILLS),
        fractionDigits: AmountEntry.FRACTION_DIGITS,
        maxDigits: AmountEntry.maxDigits(),
      },
      merchantReferenceMaxLength: TransactionFormState.MERCHANT_REFERENCE_MAX_LENGTH,
      receiptNumberMaxLength: TransactionFormState.RECEIPT_NUMBER_MAX_LENGTH,
      defaultPort: EcrConfig.DEFAULT_PORT,
      today: isoDay(startOfToday()),
    };
  }
}
