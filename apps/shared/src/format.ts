// Amounts are base units everywhere in the protocol (D23) and decimal strings only at the edges: the
// keypad the user types on, and the line the user reads. Nothing in between uses a float.

/** Base units → a plain decimal string, trailing zeros trimmed but never rounded. */
export function formatAmount(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * A typed amount → base units, or null when it is not a number this protocol can carry. Rejects more
 * fraction digits than the mint has rather than rounding them away: the payer signs what they read.
 */
export function parseAmount(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') return null;
  const [whole = '', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) return null;
  const base = BigInt(`${whole === '' ? '0' : whole}${fraction.padEnd(decimals, '0')}`);
  return base > (1n << 64n) - 1n ? null : base;
}

/** Lamports → SOL, for the deposit screen. Nine decimals, and the same no-rounding rule. */
export const formatSol = (lamports: bigint): string => formatAmount(lamports, 9);

/** The short form an address is shown in. Never the only thing on screen for a new merchant (T5). */
export const shortAddress = (address: string): string => `${address.slice(0, 4)}…${address.slice(-4)}`;
