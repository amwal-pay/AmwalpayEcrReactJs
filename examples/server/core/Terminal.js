import { EcrMode } from './EcrMode.js';

/**
 * A registered POS terminal. The serial number is the unique identifier: the
 * transaction screen stores only the serial and looks connection details up
 * from here, so a terminal that moves to a new IP needs no change elsewhere.
 * Holds addresses only, never a key.
 */
export class Terminal {
  constructor({ serialNumber = '', name = '', ecrMode = 2, ipAddress = '', port = 0, terminalId = '', merchantId = '' } = {}) {
    this.serialNumber = serialNumber;
    this.name = name;
    this.ecrMode = ecrMode;
    this.ipAddress = ipAddress;
    this.port = port;
    this.terminalId = terminalId;
    this.merchantId = merchantId;
    Object.freeze(this);
  }

  mode() {
    return EcrMode.fromValue(this.ecrMode) ?? EcrMode.DEFAULT;
  }

  modeLabel() {
    return this.mode().label();
  }

  /** Label used in the terminal dropdown on the transaction screen. */
  displayName() {
    return `${this.name} (${this.serialNumber})`;
  }

  /** One-line connection summary for the terminals list. */
  connectionSummary() {
    switch (this.mode()) {
      case EcrMode.WebService: {
        const parts = [];
        if (this.merchantId !== '') parts.push('Merchant ' + this.merchantId);
        if (this.terminalId !== '') parts.push('Terminal ' + this.terminalId);
        return parts.length === 0 ? 'Web Service' : parts.join(' · ');
      }
      case EcrMode.Bluetooth:
        return 'Bluetooth';
      case EcrMode.UsbCable:
        return 'USB cable';
      default:
        if (this.ipAddress !== '' && this.port > 0) return `${this.ipAddress}:${this.port}`;
        return this.ipAddress !== '' ? this.ipAddress : this.mode().label();
    }
  }

  /** The stored shape, camelCase like the Windows samples' terminals.json. */
  toJSON() {
    return {
      serialNumber: this.serialNumber,
      name: this.name,
      ecrMode: this.ecrMode,
      ipAddress: this.ipAddress,
      port: this.port,
      terminalId: this.terminalId,
      merchantId: this.merchantId,
    };
  }

  static fromJSON(data) {
    const text = (key) => {
      const value = data[key];
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
    };
    const int = (value, fallback) => {
      const n = Number.parseInt(String(value ?? ''), 10);
      return Number.isNaN(n) ? fallback : n;
    };
    return new Terminal({
      serialNumber: text('serialNumber'),
      name: text('name'),
      ecrMode: int(data.ecrMode, EcrMode.DEFAULT.value),
      ipAddress: text('ipAddress'),
      port: int(data.port, 0),
      terminalId: text('terminalId'),
      merchantId: text('merchantId'),
    });
  }
}
