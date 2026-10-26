/**
 * How an ECR reaches the POS terminal: TMS `ecrMode` values
 * 1 USB cable, 2 Wi-Fi, 3 Bluetooth, 4 Web Service.
 *
 * All four stay registrable so a terminal list matches the Android and Windows
 * samples; the JavaScript SDK opens Wi-Fi and Web Service only.
 */
export class EcrMode {
  static UsbCable = new EcrMode(1);
  static Wifi = new EcrMode(2);
  static Bluetooth = new EcrMode(3);
  static WebService = new EcrMode(4);

  static DEFAULT = EcrMode.Wifi;

  constructor(value) {
    this.value = value;
    Object.freeze(this);
  }

  static all() {
    return [EcrMode.UsbCable, EcrMode.Wifi, EcrMode.Bluetooth, EcrMode.WebService];
  }

  label() {
    switch (this) {
      case EcrMode.UsbCable: return 'USB Cable';
      case EcrMode.Wifi: return 'Wi‑Fi';
      case EcrMode.Bluetooth: return 'Bluetooth';
      default: return 'Web Service';
    }
  }

  /** Whether the terminal is reached over a socket. Wi-Fi alone: a USB cable carries no IP. */
  isIpBased() {
    return this === EcrMode.Wifi;
  }

  /** Whether this sample can run transactions over the mode. */
  isSupportedInExample() {
    return this === EcrMode.Wifi || this === EcrMode.WebService;
  }

  static fromValue(value) {
    return EcrMode.all().find((m) => m.value === value) ?? null;
  }
}
