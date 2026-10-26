import { EcrConfig, EcrSessions, LanLink, WebServiceLink } from '@amwalpay/ecr-js';
import { EcrMode } from './EcrMode.js';

/**
 * What the SDK plan makes of a registered terminal, before anyone pays.
 * Transport rules live in `EcrSessions.plan()`; this maps the stored record to
 * a link and supplies the key for its mode.
 */
export class SelectedTerminalConfig {
  #issues;

  constructor(terminal, plan, issues) {
    this.terminal = terminal;
    this.plan = plan;
    this.#issues = issues;
  }

  static resolve(terminal, environment, secureHashKey, stateDirectory = null) {
    const issues = [];
    if (!terminal.mode().isSupportedInExample()) issues.push(`${terminal.mode().label()} is not supported in this sample`);
    const trimmed = String(secureHashKey).trim();
    const config = new EcrConfig({
      secureHashKey: EcrConfig.isValidSecureHashKey(trimmed) ? trimmed : '',
      merchantId: terminal.merchantId,
      terminalId: terminal.terminalId,
      environment,
      port: portOrDefault(terminal.port),
      stateDirectory,
    });
    const link = terminal.mode() === EcrMode.WebService
      ? new WebServiceLink(terminal.merchantId, terminal.terminalId)
      : new LanLink(terminal.ipAddress, terminal.mode() === EcrMode.Wifi ? portOrDefault(terminal.port) : EcrConfig.DEFAULT_PORT);
    const plan = EcrSessions.plan(link, config, trimmed);
    return new SelectedTerminalConfig(terminal, plan, [...plan.issues(), ...issues]);
  }

  mode() {
    return this.terminal.mode();
  }

  modeLabel() {
    return this.mode().label();
  }

  ecrConfig() {
    return this.plan.config;
  }

  issues() {
    return [...this.#issues];
  }

  usesWebService() {
    return this.plan.usesWebService();
  }

  usesLan() {
    return this.plan.usesLan();
  }

  isSupported() {
    return this.mode().isSupportedInExample();
  }

  isReady() {
    return this.isSupported() && this.#issues.length === 0;
  }

  hashKeyLabel() {
    return this.plan.signingKeyLabel();
  }

  hashKeyConfigured() {
    return this.plan.signingKeyConfigured();
  }

  connectionSummary() {
    return this.plan.connectionSummary();
  }

  /** "TCP Wi-Fi" / "HTTPS Web Service...", as the config card shows it. */
  transportLabel() {
    if (!this.isSupported()) return this.mode().label();
    return this.usesWebService() ? 'HTTPS Web Service (JSON HMAC)' : 'TCP Wi-Fi (sorted key=value HMAC)';
  }
}

function portOrDefault(port) {
  return port >= 1 && port <= 65535 ? port : EcrConfig.DEFAULT_PORT;
}
