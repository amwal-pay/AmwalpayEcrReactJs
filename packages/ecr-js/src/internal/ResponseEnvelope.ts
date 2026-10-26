import { Json, JsonArray, type JsonObject } from '../json/Json.js';
import { NetText } from './NetText.js';

/**
 * Reads the unified response envelope, and the legacy shapes that nest it
 * under `ecrResponse` or flatten it into `approved` / `responseMessage`.
 *
 * @internal
 */
export class ResponseEnvelope {
  private static readonly APPROVED = '00';

  static root(json: JsonObject): JsonObject {
    if (json.has('success') || json.has('data')) return json;
    return json.obj('ecrResponse') ?? json;
  }

  static isSuccess(json: JsonObject): boolean {
    const success = ResponseEnvelope.root(json).strictBool('success');
    if (success !== null) return success;
    const approved = json.strictBool('approved');
    if (approved !== null) return approved;
    return ResponseEnvelope.responseCode(json) === ResponseEnvelope.APPROVED;
  }

  static responseCode(json: JsonObject): string {
    const code = ResponseEnvelope.root(json).str('responseCode');
    return code !== '' ? code : json.str('responseCode');
  }

  /** Top-level `message`, or legacy `responseMessage`. */
  static wireMessage(json: JsonObject): string {
    const message = ResponseEnvelope.root(json).str('message');
    return message !== '' ? message : json.str('responseMessage');
  }

  static data(json: JsonObject): JsonObject | null {
    return ResponseEnvelope.root(json).obj('data');
  }

  /** Non-blank scalar entries, trimmed. */
  static errorList(json: JsonObject): string[] {
    const fromRoot = ResponseEnvelope.root(json).get('errorList');
    const raw = fromRoot ?? json.get('errorList');
    if (!(raw instanceof JsonArray)) return [];
    const result: string[] = [];
    for (const element of raw) {
      if (!Json.isScalar(element)) continue;
      const text = NetText.trim(Json.content(element));
      if (text !== '') result.push(text);
    }
    return result;
  }
}
