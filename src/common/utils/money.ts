/** Largest amount a single ledger line may carry, in minor units. Keeps sums far inside BIGINT range. */
export const MAX_AMOUNT_MINOR = 10n ** 15n;

/**
 * Renders an integer minor-unit amount as a decimal string, e.g. (12345n, 2) -> "123.45".
 * Pure integer/string arithmetic: money never passes through a JavaScript number.
 */
export function formatMinor(amountMinor: bigint, minorUnits: number): string {
  if (!Number.isInteger(minorUnits) || minorUnits < 0)
    throw new RangeError('minorUnits must be a non-negative integer');
  const negative = amountMinor < 0n;
  const digits = (negative ? -amountMinor : amountMinor).toString().padStart(minorUnits + 1, '0');
  const whole = digits.slice(0, digits.length - minorUnits);
  const fraction = minorUnits > 0 ? `.${digits.slice(-minorUnits)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
