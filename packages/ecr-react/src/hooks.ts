import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './client.js';
import { useEcrClient } from './context.js';
import type {
  CloseReceiptView, ConfigView, KeyKind, LogView, MetaView, SettingsView, TerminalForm, TerminalView,
  TransactionForm, TransactionView,
} from './types.js';

// ── Meta ────────────────────────────────────────────────────────────

export interface UseMeta {
  meta: MetaView | null;
  /** Set when the server could not be reached. */
  error: ApiError | null;
  loading: boolean;
}

/** `GET /api/meta`, once: what the page needs to build its form. */
export function useMeta(): UseMeta {
  const client = useEcrClient();
  const [state, setState] = useState<UseMeta>({ meta: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    client.meta().then(
      (meta) => live && setState({ meta, error: null, loading: false }),
      (error) => live && setState({ meta: null, error: error instanceof ApiError ? error : new ApiError(0, null), loading: false }),
    );
    return () => {
      live = false;
    };
  }, [client]);
  return state;
}

// ── Terminals ───────────────────────────────────────────────────────

export interface UseTerminals {
  terminals: TerminalView[];
  /** The server's warning about the stored list, or a load failure. */
  notice: string | null;
  loaded: boolean;
  refresh(): Promise<TerminalView[] | null>;
  /** Throws {@link ApiError}: a 422 carries per-field messages. */
  add(form: TerminalForm): Promise<TerminalView>;
  save(originalSerial: string, form: TerminalForm): Promise<TerminalView>;
  remove(serial: string): Promise<void>;
}

/** The registered terminals. Mutations refresh the list. */
export function useTerminals(): UseTerminals {
  const client = useEcrClient();
  const [terminals, setTerminals] = useState<TerminalView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await client.terminals();
      setTerminals(data.terminals);
      setNotice(data.notice);
      setLoaded(true);
      return data.terminals;
    } catch {
      setNotice('The terminal list could not be loaded.');
      return null;
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(async (form: TerminalForm) => {
    const saved = await client.addTerminal(form);
    await refresh();
    return saved;
  }, [client, refresh]);

  const save = useCallback(async (originalSerial: string, form: TerminalForm) => {
    const saved = await client.saveTerminal(originalSerial, form);
    await refresh();
    return saved;
  }, [client, refresh]);

  const remove = useCallback(async (serial: string) => {
    try {
      await client.deleteTerminal(serial);
    } finally {
      await refresh();
    }
  }, [client, refresh]);

  return { terminals, notice, loaded, refresh, add, save, remove };
}

// ── Settings ────────────────────────────────────────────────────────

export interface UseSettings {
  settings: SettingsView | null;
  notice: string | null;
  setNotice(notice: string | null): void;
  refresh(): Promise<void>;
  /** Throws {@link ApiError}. */
  setEnvironment(environment: string): Promise<SettingsView>;
  /** Throws {@link ApiError}: a 422 has `fields.value`. The key is never sent back. */
  setKey(kind: KeyKind, value: string): Promise<SettingsView>;
  clearKey(kind: KeyKind): Promise<SettingsView>;
}

/** The environment and whether each signing key is set. Keys are write-only. */
export function useSettings(): UseSettings {
  const client = useEcrClient();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((next: SettingsView) => {
    setSettings(next);
    setNotice(next.notice);
    return next;
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await client.settings());
    } catch {
      setNotice('The settings could not be loaded.');
    }
  }, [client, apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    settings,
    notice,
    setNotice,
    refresh,
    setEnvironment: useCallback(async (e: string) => apply(await client.setEnvironment(e)), [client, apply]),
    setKey: useCallback(async (k: KeyKind, v: string) => apply(await client.setKey(k, v)), [client, apply]),
    clearKey: useCallback(async (k: KeyKind) => apply(await client.clearKey(k)), [client, apply]),
  };
}

// ── Config card ─────────────────────────────────────────────────────

export interface UseTerminalConfig {
  config: ConfigView | null;
  /** Reloads; `announce` writes the "selected" lines to the server log. */
  reload(announce?: boolean): Promise<void>;
}

/** What the SDK plan makes of the selected terminal, before anyone pays. */
export function useTerminalConfig(serial: string | null, options: { announce?: boolean } = {}): UseTerminalConfig {
  const client = useEcrClient();
  const [config, setConfig] = useState<ConfigView | null>(null);
  const current = useRef(serial);
  current.current = serial;
  const announceOnChange = options.announce ?? false;

  const load = useCallback(async (target: string | null, announce: boolean) => {
    if (!target) {
      setConfig(null);
      return;
    }
    try {
      const next = await client.config(target, announce);
      if (target !== current.current) return; // the operator picked another meanwhile
      setConfig(next);
    } catch {
      if (target === current.current) setConfig(null);
    }
  }, [client]);

  useEffect(() => {
    void load(serial, announceOnChange);
  }, [serial, load, announceOnChange]);

  const reload = useCallback((announce = false) => load(current.current, announce), [load]);
  return { config, reload };
}

// ── Transactions ────────────────────────────────────────────────────

export const POLL_MS = 500;

export interface UseTransactionOptions {
  /** Called when the run or its state changes (to refresh a log, say). */
  onStateChange?(run: TransactionView): void;
  /** Called when a run was stopped before anything was sent (state `idle`). */
  onStopped?(run: TransactionView): void;
  /** Adopt the newest unacknowledged run on mount (a reload or second tab). Default true. */
  resume?: boolean;
  /** Ask before the page is closed while a run is busy. Default true. */
  guardUnload?: boolean;
}

export interface UseTransaction {
  run: TransactionView | null;
  /** The last poll failed; still trying. The transaction carries on regardless. */
  linkLost: boolean;
  starting: boolean;
  /**
   * Starts a run. Throws {@link ApiError}: 422 with fields/message, or 409 when
   * one is already running on the terminal (that run is then adopted).
   */
  start(form: TransactionForm): Promise<TransactionView>;
  adopt(view: TransactionView): void;
  cancel(): Promise<void>;
  /** Look an unknown outcome up by its reference, on the same run. Throws {@link ApiError}. */
  inquire(): Promise<void>;
  requestReceipt(): Promise<void>;
  closeReceipt(): Promise<CloseReceiptView>;
  /** The operator has read the result: forget it here and tell the server. */
  acknowledge(): void;
  /** Forget the run here only. */
  forget(): void;
}

/**
 * One transaction on the server, watched from the page. The page only starts
 * it and polls: closing the tab does not stop a payment.
 */
export function useTransaction(options: UseTransactionOptions = {}): UseTransaction {
  const client = useEcrClient();
  const [run, setRun] = useState<TransactionView | null>(null);
  const [linkLost, setLinkLost] = useState(false);
  const [starting, setStarting] = useState(false);
  const runRef = useRef<TransactionView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastState = useRef<string | null>(null);
  const opts = useRef(options);
  opts.current = options;
  const mounted = useRef(true);

  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const forget = useCallback(() => {
    clear();
    runRef.current = null;
    lastState.current = null;
    setRun(null);
  }, []);

  // poll and adopt refer to each other through refs.
  const pollRef = useRef<() => void>(() => {});

  const schedule = useCallback(() => {
    clear();
    const current = runRef.current;
    if (!mounted.current || !current || !(current.busy || current.dialog?.receipt.fetching)) return;
    timer.current = setTimeout(() => pollRef.current(), POLL_MS);
  }, []);

  /** Takes a state from the server. An older one (a slow response overtaken by a newer poll) is ignored. */
  const adopt = useCallback((view: TransactionView) => {
    const current = runRef.current;
    if (current && current.id === view.id && view.version < current.version) return;
    runRef.current = view;
    setRun(view);
    setLinkLost(false);
    const key = `${view.id}:${view.state}`;
    if (lastState.current !== key) {
      lastState.current = key;
      opts.current.onStateChange?.(view);
    }
    // Cancelled before anything was sent: nothing to acknowledge, back to the form.
    if (view.state === 'idle') {
      forget();
      client.acknowledge(view.id).catch(() => {});
      opts.current.onStopped?.(view);
      return;
    }
    schedule();
  }, [client, forget, schedule]);

  pollRef.current = async () => {
    const id = runRef.current?.id;
    if (!id) return;
    try {
      const view = await client.transaction(id);
      if (runRef.current?.id === id) adopt(view);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // Acknowledged elsewhere, or gone from the server.
        if (runRef.current?.id === id) forget();
        return;
      }
      if (!mounted.current) return;
      setLinkLost(true);
      schedule();
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clear();
    };
  }, []);

  // A reload (or a second tab) must not lose a payment that is running or a result nobody read.
  useEffect(() => {
    if (opts.current.resume === false) return;
    let live = true;
    client.pending().then(
      ({ transactions }) => {
        if (live && transactions.length !== 0 && runRef.current === null) adopt(transactions[0]!);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, adopt]);

  const busy = run?.busy === true;
  useEffect(() => {
    if (!busy || opts.current.guardUnload === false || typeof window === 'undefined') return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [busy]);

  const start = useCallback(async (form: TransactionForm) => {
    setStarting(true);
    try {
      const view = await client.start(form);
      adopt(view);
      return view;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.body?.transactionId) {
        // Already running on this terminal (another tab, or a double click): show that one.
        client.transaction(error.body.transactionId).then(adopt, () => {});
      }
      throw error;
    } finally {
      setStarting(false);
    }
  }, [client, adopt]);

  const withRun = <T,>(work: (id: string) => Promise<T>) => {
    const id = runRef.current?.id;
    if (!id) return Promise.reject(new Error('No transaction'));
    return work(id);
  };

  return {
    run,
    linkLost,
    starting,
    start,
    adopt,
    cancel: useCallback(() => withRun(async (id) => adopt(await client.cancel(id))), [client, adopt]),
    inquire: useCallback(() => withRun(async (id) => adopt(await client.inquire(id))), [client, adopt]),
    requestReceipt: useCallback(() => withRun(async (id) => adopt(await client.receipt(id))), [client, adopt]),
    closeReceipt: useCallback(() => withRun((id) => client.closeReceipt(id)), [client]),
    acknowledge: useCallback(() => {
      const id = runRef.current?.id;
      forget();
      if (id) client.acknowledge(id).catch(() => {});
    }, [client, forget]),
    forget,
  };
}

// ── Countdown ───────────────────────────────────────────────────────

export interface Countdown {
  visible: boolean;
  /** `m:ss` left. */
  text: string;
  secondsLeft: number;
  /** `remaining of 120 s timeout`. */
  caption: string;
}

/**
 * The wait left on a busy run. The server counts the budget down and reports
 * what is left with every poll; this only ticks between polls, so it needs no
 * clock that agrees with the server.
 */
export function useCountdown(run: TransactionView | null): Countdown {
  const remaining = run?.busy ? run.remainingSeconds : null;
  const [deadline, setDeadline] = useState<number | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    setDeadline(typeof remaining === 'number' ? Date.now() + remaining * 1000 : null);
    // Every poll is a new view: re-anchor even when the number is the same.
  }, [remaining, run?.version, run?.id]);

  useEffect(() => {
    if (deadline === null) return undefined;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  if (deadline === null || !run) return { visible: false, text: '', secondsLeft: 0, caption: '' };
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  return {
    visible: true,
    text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`,
    secondsLeft: left,
    caption: `remaining of ${run.timeoutSeconds} s timeout`,
  };
}

// ── Log ─────────────────────────────────────────────────────────────

export interface UseEcrLog {
  log: LogView | null;
  refresh(): Promise<void>;
  clear(): Promise<void>;
}

/** The SDK's diagnostics, last 500 lines. Polls while `open` and the page is visible. */
export function useEcrLog(options: { open: boolean; pollMs?: number }): UseEcrLog {
  const client = useEcrClient();
  const { open, pollMs = 1000 } = options;
  const [log, setLog] = useState<LogView | null>(null);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);

  const refresh = useCallback(async () => {
    try {
      setLog(await client.log());
    } catch {
      // The next tick tries again.
    }
  }, [client]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const handler = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  useEffect(() => {
    if (!open || !visible) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (live) timer = setTimeout(tick, pollMs);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, visible, pollMs, refresh]);

  const clear = useCallback(async () => {
    await client.clearLog();
    await refresh();
  }, [client, refresh]);

  return { log, refresh, clear };
}
