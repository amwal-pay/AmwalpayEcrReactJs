import type { EcrConfig } from '../EcrConfig.js';
import { EcrWireResponse } from '../EcrWireResponse.js';
import { formatDuration } from '../internal/duration.js';
import { Json, JsonException, JsonObject } from '../json/Json.js';
import type { EcrLogger } from '../log/EcrLogger.js';
import { HttpTransportException, type HttpResponse, type HttpTransport } from './http/HttpTransport.js';
import { NodeHttpTransport } from './http/NodeHttpTransport.js';
import { WebServiceHttpLog } from './WebServiceHttpLog.js';
import type { WebServiceOperation } from './WebServiceOperation.js';
import { WebServiceRoutes } from './WebServiceRoutes.js';
import { WebServiceSecureHash } from './WebServiceSecureHash.js';

/**
 * Posts signed JSON bodies to the Web Service ECR endpoints.
 *
 * Every transport or HTTP failure (no response, an empty body, invalid JSON,
 * an HTTP error with nothing readable, an HttpTransportException) comes back as
 * a `success: false` envelope rather than an exception, so callers read every
 * outcome the same way. When the request may have reached the Hub the envelope
 * carries `nextStep` `INQUIRE_BY_MERCHANT_REFERENCE`: a till must inquire, not
 * treat it as a refusal and send the sale again.
 */
export class WebServiceApi {
  /** The wire value {@link NextStep.InquireByMerchantReference} is read from. */
  static readonly UNKNOWN_OUTCOME_STEP = 'INQUIRE_BY_MERCHANT_REFERENCE';

  private readonly http: HttpTransport;
  private readonly routesFor: WebServiceRoutes;

  constructor(
    private readonly config: EcrConfig,
    private readonly logger: EcrLogger,
    http: HttpTransport | null = null,
  ) {
    this.http = http ?? new NodeHttpTransport(config.caBundlePath);
    this.routesFor = new WebServiceRoutes(config.environment);
  }

  routes(): WebServiceRoutes {
    return this.routesFor;
  }

  /** Posts `body` and returns the answer as JSON, never throwing for a transport failure. */
  async postJson(operation: WebServiceOperation, body: JsonObject): Promise<JsonObject> {
    const started = performance.now();
    const payload = Json.write(body);
    const url = this.routesFor.url(operation);

    WebServiceHttpLog.request(this.logger, operation, url, this.config.environment, payload);
    this.logSigning(body);

    const deadline = this.config.connectTimeout + this.config.responseTimeout;
    let response: HttpResponse;
    try {
      response = await this.http.post(
        url,
        payload,
        { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
        this.config.connectTimeout,
        deadline,
      );
    } catch (error) {
      if (!(error instanceof HttpTransportException)) throw error;
      const message = error.timedOut
        ? 'Timed out after ' + formatDuration(deadline)
        : error.message !== '' ? error.message : 'Web Service request failed';
      WebServiceHttpLog.error(this.logger, operation, message, elapsed(started));
      return WebServiceApi.errorBody('NO_RESPONSE', message);
    }

    const status = response.status;
    const text = response.text();
    const took = elapsed(started);
    WebServiceHttpLog.response(this.logger, operation, status, took, text.trim() === '' ? '<empty>' : text);

    if (text.trim() === '') {
      WebServiceHttpLog.error(this.logger, operation, `Empty response (${response.reasonPhrase})`, took);
      return WebServiceApi.errorBody(String(status), `Empty response from Web Service (${response.reasonPhrase})`);
    }

    let parsed: JsonObject;
    try {
      parsed = Json.parseObject(response.body);
    } catch (error) {
      if (!(error instanceof JsonException)) throw error;
      WebServiceHttpLog.error(this.logger, operation, 'Invalid JSON: ' + error.message, took);
      return WebServiceApi.errorBody(String(status), 'Response was not valid JSON: ' + error.message);
    }

    if (status < 200 || status > 299) {
      const wire = EcrWireResponse.parse(parsed);
      if (wire.message !== '' || wire.errorList.length !== 0) {
        WebServiceHttpLog.error(this.logger, operation, `HTTP ${status} — ${wire.displayMessage()}`, took);
        return parsed;
      }
      const reason = response.reasonPhrase !== '' ? response.reasonPhrase : `HTTP ${status}`;
      WebServiceHttpLog.error(this.logger, operation, reason, took);
      return WebServiceApi.errorBody(String(status), reason, status >= 500);
    }

    return parsed;
  }

  private logSigning(body: JsonObject): void {
    if (this.config.secureHashKey === '') {
      this.logger.debug(`[Web Service] calcHash skipped — no ${WebServiceSecureHash.KEY_LABEL} configured`);
      return;
    }
    const hash = body.str(WebServiceSecureHash.FIELD);
    if (hash !== '') WebServiceHttpLog.signing(this.logger, WebServiceSecureHash.compose(body), hash);
  }

  /** The `success: false` envelope that stands in for an answer that never came. */
  private static errorBody(responseCode: string, message: string, outcomeUnknown = true): JsonObject {
    const body = new JsonObject()
      .set('success', false)
      .set('responseCode', responseCode)
      .set('message', message);
    if (outcomeUnknown) body.set('nextStep', WebServiceApi.UNKNOWN_OUTCOME_STEP);
    return body;
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
