import { EcrConfig } from '../EcrConfig.js';

/**
 * How this till reaches a POS terminal: {@link LanLink} (Wi-Fi/LAN) or
 * {@link WebServiceLink} (the Amwal Hub over HTTPS).
 *
 * The app supplies addressing and backend IDs; the SDK owns protocol choice,
 * signing and transport. USB cable is not offered by the JavaScript SDK.
 */
export abstract class EcrLink {}

/**
 * Wi-Fi/LAN: TCP to the IP address and port the terminal shows on its idle
 * screen. The till and the terminal must be on the same network.
 */
export class LanLink extends EcrLink {
  constructor(
    readonly host: string,
    readonly port: number = EcrConfig.DEFAULT_PORT,
  ) {
    super();
  }
}

/**
 * ECR Web Service: HTTPS to the Amwal Hub, which relays to the terminal
 * configured for Web Service mode (`ecrMode: 4`). The Hub address comes from
 * {@link EcrConfig.environment}.
 */
export class WebServiceLink extends EcrLink {
  /**
   * @param merchantId Numeric backend merchant ID.
   * @param terminalId Numeric backend terminal ID.
   */
  constructor(
    readonly merchantId: string,
    readonly terminalId: string,
  ) {
    super();
  }
}
