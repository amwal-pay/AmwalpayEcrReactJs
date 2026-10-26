import { Declined, EcrWireResponse, Failed, Found, InquiryFailed, Json, NextStep, NotFound } from '@amwalpay/ecr-js';
import { TransactionRequest } from './TransactionRequest.js';
import { StateCompleted, StateFailed, StateIdle, StateInquired } from './TransactionState.js';

/**
 * Turns what the SDK returned into what the screen shows. Pure, so the
 * payment-safety rules (an unknown outcome is never a refusal, and never a
 * reason to retry) can be tested without a terminal.
 */
export class TransactionOutcomes {
  /** The Web Service layer's code for an answer that never came: not a decline. */
  static NO_RESPONSE_CODE = 'NO_RESPONSE';

  static fromResult(result, request) {
    if (result instanceof Failed) return TransactionOutcomes.#fromFailed(result, request);
    if (result instanceof Declined && result.responseCode === TransactionOutcomes.NO_RESPONSE_CODE) {
      return new StateFailed('No answer from the Web Service: ' + result.reason, inquirableReferenceOrNull(result.merchantReference));
    }
    // The terminal answered and said it does not actually know.
    if (result instanceof Declined && result.nextStep === NextStep.InquireByMerchantReference) {
      return new StateFailed(
        result.reason,
        inquirableReferenceOrNull(result.merchantReference),
        'The terminal reports that it does not know whether this completed.',
      );
    }
    return new StateCompleted(result, request.type);
  }

  static #fromFailed(failed, request) {
    // The SDK asked the terminal and it knew: no longer an unknown outcome.
    if (failed.recovered instanceof Found) {
      return new StateInquired(
        failed.recovered,
        TransactionRequest.inquiryByReference(request.terminalSerial, failed.merchantReference),
        { recoveredFromFailure: true },
      );
    }
    let note = null;
    if (failed.recovered instanceof NotFound) {
      note = 'The terminal was asked automatically what became of it and has no record yet. '
        + 'That does not prove nothing was charged — look it up again before taking payment again.';
    } else if (failed.recovered instanceof InquiryFailed) {
      note = 'The automatic check with the terminal could not be completed either.';
    }
    // Only when the request actually went out: an unreachable terminal means
    // nothing was sent, so there is nothing to ask about.
    const reference = failed.failure.outcomeUnknown() ? inquirableReferenceOrNull(failed.merchantReference) : null;
    return new StateFailed(failed.failure.message, reference, note);
  }

  static fromInquiry(inquiry, request) {
    if (inquiry instanceof InquiryFailed) {
      return new StateFailed(
        inquiry.failure.message,
        retryableReference(request),
        'An inquiry only reads and changes nothing, so it is safe to try again.',
      );
    }
    // A Web Service transport error that reads as "not found" would say "it did not happen".
    if (inquiry instanceof NotFound && TransactionOutcomes.isNoResponse(inquiry.raw)) {
      return new StateFailed(
        'No answer from the Web Service: ' + inquiry.reason,
        retryableReference(request),
        'An inquiry only reads and changes nothing, so it is safe to try again.',
      );
    }
    return new StateInquired(inquiry, request);
  }

  /** Extra text for an inquiry dialog, or null. */
  static inquiryNote(inquiry, webService) {
    if (inquiry instanceof NotFound && webService) {
      return 'The Web Service did not return this transaction. That does not prove nothing was '
        + "charged — check the terminal's receipt or the merchant portal before taking payment again.";
    }
    return null;
  }

  static isNoResponse(raw) {
    if (raw === '') return false;
    try {
      return EcrWireResponse.parse(Json.parseObject(raw)).responseCode === TransactionOutcomes.NO_RESPONSE_CODE;
    } catch {
      return false;
    }
  }

  /**
   * What to show after the operator stopped waiting. Stopping here does not stop
   * the terminal, so a money-moving operation is an unknown outcome, never "cancelled".
   */
  static cancelledState(request) {
    return request.type.movesMoney()
      ? new StateFailed(
        'You stopped waiting for the terminal. This does not cancel the transaction: '
        + 'if the request had already reached the terminal, it may still complete.',
        request.merchantReference !== '' ? request.merchantReference : null,
      )
      : new StateIdle();
  }

  /** What to tell the operator when the terminal cannot be reached, before anything is sent. */
  static unreachableMessage(endpoint, port, error) {
    let text = `${endpoint} is not reachable`;
    if (error !== null && error !== '') text += `\n(${error})`;
    return text + '\n\nCheck:\n'
      + '• POS app is in ECR mode (Wi‑Fi) and shows its IP under the card logos\n'
      + `• Registered IP matches that address (port ${port})\n`
      + '• Serial number matches the terminal you selected\n'
      + '• This PC and the terminal are on the same network, and the network profile is Private\n'
      + '• If the terminal runs on this PC (tools/fake-pos-server.mjs), try IP 127.0.0.1';
  }

  static movesMoney(type) {
    return type.movesMoney();
  }
}

/**
 * When an inquiry by reference fails the reference stays with the result: it
 * is usually one the app generated for a lost sale, in no field the operator
 * could retype it from.
 */
function retryableReference(request) {
  return request.looksUpByReference() ? request.originalReference.trim() : null;
}

function inquirableReferenceOrNull(reference) {
  return reference.trim() === '' ? null : reference;
}
