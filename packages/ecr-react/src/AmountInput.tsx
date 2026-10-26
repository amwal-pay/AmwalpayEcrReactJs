import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, type InputHTMLAttributes } from 'react';
import { appendDigit, backspaceDigit, formatAmount } from './amount.js';

export interface AmountInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'type'> {
  /** The keyed digits (mills for OMR): "1234" shows 1.234. */
  digits: string;
  onDigitsChange: (digits: string) => void;
  /** Digits the field accepts: enough to key the terminal's maximum and no more. */
  maxDigits: number;
}

export interface AmountInputHandle {
  /** Moves focus here without throwing the amount away (focus from another control starts a fresh amount). */
  focus(): void;
  readonly element: HTMLInputElement | null;
}

const BACKSPACE_TYPES = new Set(['deleteContentBackward', 'deleteWordBackward', 'deleteSoftLineBackward', 'deleteHardLineBackward']);

/**
 * The POS-style amount field: three decimals shown, typed digits shift in from
 * the right, Backspace shifts them out, Escape clears. All typing is handled
 * here rather than by the browser, and the caret is pinned to the end, so a
 * click in the middle of the number cannot make the next digit land there.
 */
export const AmountInput = forwardRef<AmountInputHandle, AmountInputProps>(function AmountInput(
  { digits, onDigitsChange, maxDigits, ...rest },
  ref,
) {
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ digits, onDigitsChange, maxDigits });
  latest.current = { digits, onDigitsChange, maxDigits };
  const keepOnFocus = useRef(false);

  const pin = useCallback(() => {
    const el = input.current;
    if (!el) return;
    const end = el.value.length;
    if (el.selectionStart !== end || el.selectionEnd !== end) {
      try {
        el.setSelectionRange(end, end);
      } catch {
        // Not focusable yet.
      }
    }
  }, []);

  useImperativeHandle(ref, () => ({
    focus() {
      keepOnFocus.current = true;
      try {
        input.current?.focus();
      } finally {
        keepOnFocus.current = false;
      }
    },
    get element() {
      return input.current;
    },
  }), []);

  useEffect(() => {
    const el = input.current;
    if (!el) return undefined;

    const set = (next: string) => {
      if (next !== latest.current.digits) latest.current.onDigitsChange(next);
      // React re-renders with the new value; keep the caret where it belongs.
      queueMicrotask(pin);
    };
    const key = (text: string) => {
      let next = latest.current.digits;
      for (const ch of String(text)) {
        if (ch >= '0' && ch <= '9') next = appendDigit(next, ch, latest.current.maxDigits);
      }
      set(next);
    };

    // beforeinput covers hardware keys, on-screen keyboards and paste with one code path.
    const onBeforeInput = (event: InputEvent) => {
      // Enter is not text: leave it alone so the form still submits.
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') return;
      event.preventDefault();
      if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') key(event.data ?? '');
      else if (event.inputType === 'insertFromPaste') key(event.data ?? event.dataTransfer?.getData('text/plain') ?? '');
      else if (BACKSPACE_TYPES.has(event.inputType)) set(backspaceDigit(latest.current.digits));
      // Everything else (delete forward, cut, drop, undo) would edit text this field derives.
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Delete' || event.key === ' ') event.preventDefault();
      else if (event.key === 'Escape' && latest.current.digits.length !== 0) {
        set('');
        event.preventDefault();
      }
    };
    // Focusing the field starts a fresh amount, but only on a move from another control.
    const onFocus = (event: FocusEvent) => {
      const from = event.relatedTarget;
      if (!keepOnFocus.current && from && from !== el && latest.current.digits.length !== 0) set('');
      pin();
    };
    const prevent = (event: Event) => event.preventDefault();
    const pinLater = () => setTimeout(pin, 0);

    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('focus', onFocus);
    el.addEventListener('cut', prevent);
    el.addEventListener('drop', prevent);
    el.addEventListener('mouseup', pinLater);
    const pins = ['select', 'click', 'keyup', 'touchend'];
    for (const name of pins) el.addEventListener(name, pin);
    return () => {
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('cut', prevent);
      el.removeEventListener('drop', prevent);
      el.removeEventListener('mouseup', pinLater);
      for (const name of pins) el.removeEventListener(name, pin);
    };
  }, [pin]);

  useEffect(() => {
    if (document.activeElement === input.current) pin();
  }, [digits, pin]);

  return (
    <input
      {...rest}
      ref={input}
      type="text"
      inputMode={rest.inputMode ?? 'numeric'}
      autoComplete={rest.autoComplete ?? 'off'}
      spellCheck={rest.spellCheck ?? false}
      value={formatAmount(digits)}
      // Anything that slipped past (an input method composing text) is put right by React's controlled value.
      onChange={() => {}}
    />
  );
});
