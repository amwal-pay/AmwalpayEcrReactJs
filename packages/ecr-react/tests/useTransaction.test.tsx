import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type EcrClient } from '../src/client.js';
import { EcrProvider } from '../src/context.js';
import { POLL_MS, useCountdown, useTransaction } from '../src/hooks.js';
import type { TransactionView } from '../src/types.js';

function view(over: Partial<TransactionView> = {}): TransactionView {
  return {
    id: 'a'.repeat(32), terminalSerial: 'SN-1', operation: 'Sale', state: 'inProgress', busy: true, isResult: false,
    statusText: 'Waiting for the POS terminal…', version: 1, dialog: null, timeoutSeconds: 120, remainingSeconds: 120, ...over,
  };
}

function fakeClient(over: Partial<EcrClient> = {}): EcrClient {
  return {
    pending: vi.fn(async () => ({ transactions: [] })),
    acknowledge: vi.fn(async () => null),
    ...over,
  } as unknown as EcrClient;
}

function wrapper(client: EcrClient) {
  return ({ children }: { children: ReactNode }) => <EcrProvider client={client}>{children}</EcrProvider>;
}

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('useTransaction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls every 500 ms while busy and stops on a result', async () => {
    const polls = [view({ version: 2 }), view({ version: 3, state: 'completed', busy: false, isResult: true })];
    const transaction = vi.fn(async () => polls.shift()!);
    const client = fakeClient({ start: vi.fn(async () => view()), transaction });
    const { result } = renderHook(() => useTransaction(), { wrapper: wrapper(client) });
    await flush();

    await act(async () => {
      await result.current.start({} as never);
    });
    expect(result.current.run?.version).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.run?.version).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.run?.state).toBe('completed');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('ignores an older version of the same run', async () => {
    const { result } = renderHook(() => useTransaction(), { wrapper: wrapper(fakeClient()) });
    await flush();
    act(() => result.current.adopt(view({ version: 5, busy: false, state: 'failed', isResult: true })));
    act(() => result.current.adopt(view({ version: 4 })));
    expect(result.current.run?.version).toBe(5);
    act(() => result.current.adopt(view({ id: 'b'.repeat(32), version: 1, busy: false, state: 'failed' })));
    expect(result.current.run?.id).toBe('b'.repeat(32));
  });

  it('flags a lost link and keeps polling; forgets on 404', async () => {
    let calls = 0;
    const transaction = vi.fn(async () => {
      calls++;
      throw calls === 1 ? new ApiError(0, null) : new ApiError(404, { error: 'No such transaction' });
    });
    const { result } = renderHook(() => useTransaction(), { wrapper: wrapper(fakeClient({ transaction })) });
    await flush();
    act(() => result.current.adopt(view()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.linkLost).toBe(true);
    expect(result.current.run).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(result.current.run).toBeNull();
  });

  it('resumes the newest pending run and acknowledges an idle one', async () => {
    const client = fakeClient({ pending: vi.fn(async () => ({ transactions: [view({ state: 'idle', busy: false })] })) });
    const onStopped = vi.fn();
    const { result } = renderHook(() => useTransaction({ onStopped }), { wrapper: wrapper(client) });
    await flush();
    expect(result.current.run).toBeNull();
    expect(client.acknowledge).toHaveBeenCalledWith('a'.repeat(32));
    expect(onStopped).toHaveBeenCalledOnce();
  });

  it('adopts the running transaction on a 409', async () => {
    const running = view({ id: 'c'.repeat(32), busy: false, state: 'failed' });
    const client = fakeClient({
      start: vi.fn(async () => {
        throw new ApiError(409, { error: 'busy', transactionId: running.id });
      }),
      transaction: vi.fn(async () => running),
    });
    const { result } = renderHook(() => useTransaction(), { wrapper: wrapper(client) });
    await flush();
    await act(async () => {
      await expect(result.current.start({} as never)).rejects.toBeInstanceOf(ApiError);
    });
    await flush();
    expect(result.current.run?.id).toBe(running.id);
  });
});

describe('useCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks down from the server figure', () => {
    const { result, rerender } = renderHook(({ run }) => useCountdown(run), {
      initialProps: { run: view({ remainingSeconds: 65 }) as TransactionView | null },
    });
    expect(result.current.text).toBe('1:05');
    expect(result.current.caption).toBe('remaining of 120 s timeout');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.text).toBe('1:03');
    rerender({ run: null });
    expect(result.current.visible).toBe(false);
  });
});
