/**
 * @amwalpay/ecr-js — drive an Amwal POS terminal from a Node.js till:
 * sale, void, refund, inquiry, e-receipt and close receipt, over Wi-Fi/LAN or
 * the Amwal ECR Web Service.
 *
 * Everything exported here is API. Modules under `internal/` that are not
 * re-exported below, and anything marked `@internal`, can change without notice.
 */

// Sessions
export { EcrSessions, type OpenOptions } from './EcrSessions.js';
export { EcrSessionPlan } from './EcrSessionPlan.js';
export { EcrOpenedSession } from './EcrOpenedSession.js';

// Configuration
export { EcrConfig, type EcrConfigOptions } from './EcrConfig.js';
export { EcrEnvironment } from './EcrEnvironment.js';
export { EcrSdk } from './EcrSdk.js';
export { Amount } from './Amount.js';

// Links
export { EcrLink, LanLink, WebServiceLink } from './link/EcrLink.js';

// Terminals
export { EcrTerminal, type EcrTerminalOptions, type OriginalOptions, type RunOptions } from './EcrTerminal.js';
export { EcrWebServiceTerminal, type EcrWebServiceTerminalOptions } from './EcrWebServiceTerminal.js';
export { EcrReachability } from './EcrReachability.js';
export { EcrTransactionType } from './EcrTransactionType.js';
export { EcrWireResponse } from './EcrWireResponse.js';

// Results
export {
  EcrResult, Approved, Declined, Failed,
  EcrInquiry, Found, NotFound, InquiryFailed,
  EcrReceipt, ReceiptReady, ReceiptUnavailable, ReceiptFailed,
  EcrReceiptClosed, ReceiptClosed, CloseReceiptRefused, CloseReceiptFailed,
} from './result/results.js';
export { EcrTransaction, type EcrTransactionFields } from './result/EcrTransaction.js';
export { NextStep } from './result/NextStep.js';

// Failures
export {
  Failure, Busy, ConnectionLost, Invalid, Malformed, Timeout, Unauthenticated, Unreachable, Unresolved,
} from './failure/Failure.js';

// Exceptions
export { InvalidArgumentException, LogicException, OverflowException, RuntimeException } from './exception/errors.js';
export { InvalidRequestException } from './exception/InvalidRequestException.js';
export { DuplicateMerchantReferenceException } from './exception/DuplicateMerchantReferenceException.js';

// Safety
export { FinancialGuard } from './safety/FinancialGuard.js';
export { JournalEntry, type JournalEntryData } from './safety/JournalEntry.js';
export type { TransactionJournal, TerminalLock } from './safety/contracts.js';
export { FileTransactionJournal } from './safety/FileTransactionJournal.js';
export { FileTerminalLock } from './safety/FileTerminalLock.js';

// Logging
export { EcrLogger, NullEcrLogger, CallableEcrLogger, LoggerAdapter, type DebugLogger } from './log/EcrLogger.js';
export { Redactor } from './log/Redactor.js';

// Channel
export { type EcrChannel, EcrIOException, EcrChannelTimeout } from './channel/EcrChannel.js';
export { TcpEcrChannel } from './channel/TcpEcrChannel.js';
export { EcrFrames } from './channel/EcrFrames.js';

// Web Service
export { WebServiceRequests } from './webservice/WebServiceRequests.js';
export { WebServiceSecureHash } from './webservice/WebServiceSecureHash.js';
export { WebServiceRoutes } from './webservice/WebServiceRoutes.js';
export { WebServiceOperation } from './webservice/WebServiceOperation.js';
export { WebServiceApi } from './webservice/WebServiceApi.js';
export { type HttpTransport, HttpResponse, HttpTransportException } from './webservice/http/HttpTransport.js';
export { NodeHttpTransport } from './webservice/http/NodeHttpTransport.js';

// Json (supporting types)
export { Json, JsonObject, JsonArray, JsonNumber, JsonException, type JsonValue } from './json/Json.js';
