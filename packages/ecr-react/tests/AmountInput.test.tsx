import { act, render } from '@testing-library/react';
import { createRef, useState, type Ref } from 'react';
import { describe, expect, it } from 'vitest';
import { AmountInput, type AmountInputHandle } from '../src/AmountInput.js';

function Harness({ handle, initial = '' }: { handle?: Ref<AmountInputHandle>; initial?: string }) {
  const [digits, setDigits] = useState(initial);
  return (
    <>
      <button type="button">other</button>
      <AmountInput ref={handle} id="amount" digits={digits} onDigitsChange={setDigits} maxDigits={9} />
    </>
  );
}

function type(input: HTMLInputElement, inputType: string, data: string | null = null) {
  const event = new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true });
  act(() => {
    input.dispatchEvent(event);
  });
  return event;
}

describe('AmountInput', () => {
  it('shifts typed digits in and backspace out', () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('input')!;
    expect(input.value).toBe('0.000');
    expect(type(input, 'insertText', '1').defaultPrevented).toBe(true);
    type(input, 'insertText', '2');
    type(input, 'insertText', '3');
    type(input, 'insertText', '4');
    expect(input.value).toBe('1.234');
    type(input, 'deleteContentBackward');
    expect(input.value).toBe('0.123');
    type(input, 'insertFromPaste', 'a5,6');
    expect(input.value).toBe('12.356');
  });

  it('ignores non-digits and leaves Enter alone', () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('input')!;
    type(input, 'insertText', 'x.');
    expect(input.value).toBe('0.000');
    expect(type(input, 'insertLineBreak').defaultPrevented).toBe(false);
  });

  it('clears on Escape', () => {
    const { container } = render(<Harness initial="25" />);
    const input = container.querySelector('input')!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(input.value).toBe('0.000');
  });

  it('starts fresh when focus moves in from another control, but not when focused programmatically', () => {
    const handle = createRef<AmountInputHandle>();
    const { container } = render(<Harness handle={handle} initial="25" />);
    const input = container.querySelector('input')!;
    const other = container.querySelector('button')!;
    act(() => other.focus());
    act(() => handle.current!.focus());
    expect(input.value).toBe('0.025');
    act(() => other.focus());
    act(() => input.focus());
    expect(input.value).toBe('0.000');
  });
});
