import { describe, expect, it } from 'vitest';
import { appendDigit, backspaceDigit, formatAmount, FRACTION_DIGITS, keyedDigits } from '../src/amount.js';

describe('amount helpers', () => {
  it('shifts keyed digits in from the right', () => {
    expect(FRACTION_DIGITS).toBe(3);
    expect(formatAmount('')).toBe('0.000');
    expect(formatAmount('1')).toBe('0.001');
    expect(formatAmount('12')).toBe('0.012');
    expect(formatAmount('1234')).toBe('1.234');
    expect(formatAmount('100000000')).toBe('100000.000');
  });

  it('keeps digits only, without leading zeros, capped', () => {
    expect(keyedDigits('00a1.2,3', 9)).toBe('123');
    expect(keyedDigits('1234567890', 9)).toBe('123456789');
    expect(keyedDigits('000', 9)).toBe('');
  });

  it('appends and backspaces', () => {
    expect(appendDigit('', '0', 9)).toBe('');
    expect(appendDigit('12', '3', 9)).toBe('123');
    expect(appendDigit('123456789', '1', 9)).toBe('123456789');
    expect(backspaceDigit('123')).toBe('12');
    expect(backspaceDigit('')).toBe('');
  });
});
