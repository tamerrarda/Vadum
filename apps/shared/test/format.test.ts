// Amounts: base units inside, decimal strings only at the edges (D23). A payer signs what they read.

import { describe, expect, it } from 'vitest';
import { formatAmount, formatSol, parseAmount, shortAddress } from '../src/format.ts';

describe('formatAmount', () => {
  it('renders base units without rounding', () => {
    expect(formatAmount(2_500_000n, 6)).toBe('2.5');
    expect(formatAmount(1n, 6)).toBe('0.000001');
    expect(formatAmount(0n, 6)).toBe('0');
    expect(formatAmount(100_000_000n, 6)).toBe('100');
    expect(formatAmount(5n, 0)).toBe('5');
    expect(formatAmount(1_234_567_890_123_456_789n, 6)).toBe('1234567890123.456789');
  });

  it('renders lamports as SOL for the deposit screen (D39)', () => {
    expect(formatSol(3_169_920n)).toBe('0.00316992');
    expect(formatSol(1_056_640n)).toBe('0.00105664');
  });
});

describe('parseAmount', () => {
  it('accepts what a keypad produces', () => {
    expect(parseAmount('2.5', 6)).toBe(2_500_000n);
    expect(parseAmount('2.500000', 6)).toBe(2_500_000n);
    expect(parseAmount('.5', 6)).toBe(500_000n);
    expect(parseAmount('  7 ', 6)).toBe(7_000_000n);
    expect(parseAmount('0', 6)).toBe(0n);
  });

  it('rejects rather than rounds a fraction the mint cannot hold', () => {
    expect(parseAmount('2.5000001', 6)).toBeNull();
    expect(parseAmount('1.5', 0)).toBeNull();
  });

  it('rejects anything that is not a plain number', () => {
    for (const text of ['', '.', 'abc', '1,5', '-1', '1e6', '1.2.3', '0x10']) expect(parseAmount(text, 6), text).toBeNull();
  });

  it('rejects an amount no u64 can carry', () => {
    expect(parseAmount('18446744073709.551615', 6)).toBe((1n << 64n) - 1n);
    expect(parseAmount('18446744073709.551616', 6)).toBeNull();
  });

  it('round-trips with formatAmount', () => {
    for (const base of [0n, 1n, 999_999n, 2_500_000n, 100_000_000n]) expect(parseAmount(formatAmount(base, 6), 6)).toBe(base);
  });
});

describe('shortAddress', () => {
  it('keeps both ends, because the middle is what a substituted sticker hides (T5)', () => {
    expect(shortAddress('9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu')).toBe('9hSR…GWBu');
  });
});
