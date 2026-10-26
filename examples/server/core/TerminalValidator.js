import { EcrMode } from './EcrMode.js';
import { Terminal } from './Terminal.js';

/** Dotted quad, each octet 0-255. */
const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** The terminal edit form's rules and messages, the same as the Android and Windows samples'. */
export class TerminalValidator {
  static DEFAULT_PORT = '9100';

  /** @returns field => message; empty when valid */
  static validate({ name, serial, mode, ip, port, terminalId, merchantId }) {
    const errors = {};
    if (name.trim() === '') errors.name = 'Enter a terminal name';
    // The serial is the terminal's identity, so it is required for every mode.
    if (serial.trim() === '') errors.serial = 'Enter the terminal serial number';
    if (mode.isIpBased()) {
      if (ip.trim() === '') errors.ip = 'Enter the terminal IP address';
      else if (!IPV4.test(ip.trim())) errors.ip = 'Enter a valid IPv4 address, for example 192.168.1.50';
      // Optional: blank means the terminals' standard port, 9100.
      if (port.trim() !== '' && !(isInt(port) && Number(port) >= 1 && Number(port) <= 65535)) {
        errors.port = 'Port must be between 1 and 65535';
      }
    }
    if (mode === EcrMode.WebService) {
      if (terminalId.trim() === '') errors.terminalId = 'Enter the backend terminal ID';
      else if (!isNumeric(terminalId)) errors.terminalId = 'The terminal ID must be numeric';
      if (merchantId.trim() === '') errors.merchantId = 'Enter the merchant ID';
      else if (!isNumeric(merchantId)) errors.merchantId = 'The merchant ID must be numeric';
    }
    return errors;
  }

  static toTerminal({ name, serial, mode, ip, port, terminalId, merchantId }) {
    return new Terminal({
      serialNumber: serial.trim(),
      name: name.trim(),
      ecrMode: mode.value,
      ipAddress: ip.trim(),
      port: mode.isIpBased() ? (isInt(port) ? Number(port.trim()) : Number(TerminalValidator.DEFAULT_PORT)) : 0,
      terminalId: terminalId.trim(),
      merchantId: merchantId.trim(),
    });
  }
}

/** The SDK reads both IDs as 64-bit integers, so that is the rule here. */
function isNumeric(value) {
  const v = value.trim();
  return /^[0-9]{1,19}$/.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n;
}

function isInt(value) {
  return /^\s*-?[0-9]{1,9}\s*$/.test(value);
}
