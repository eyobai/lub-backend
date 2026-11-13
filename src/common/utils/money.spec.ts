import { formatMinor } from './money';

describe('formatMinor', () => {
  it.each([
    [0n, 2, '0.00'],
    [5n, 2, '0.05'],
    [100n, 2, '1.00'],
    [12345n, 2, '123.45'],
    [-250n, 2, '-2.50'],
    [-5n, 2, '-0.05'],
    [1500n, 0, '1500'],
    [1234n, 3, '1.234'],
    [9007199254740993n, 2, '90071992547409.93'], // beyond Number.MAX_SAFE_INTEGER
  ])('formats %s with %s minor units as %s', (amount, minorUnits, expected) => {
    expect(formatMinor(amount, minorUnits)).toBe(expected);
  });

  it('rejects invalid minor units', () => {
    expect(() => formatMinor(1n, -1)).toThrow(RangeError);
    expect(() => formatMinor(1n, 1.5)).toThrow(RangeError);
  });
});
