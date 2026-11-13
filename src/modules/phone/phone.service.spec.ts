import type { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/errors/app.exception';
import { PhoneService } from './phone.service';

const service = (allowedCountries: string[] = ['ET']) =>
  new PhoneService({ phone: { allowedCountries, defaultCountry: 'ET' } } as unknown as AppConfig);

describe('PhoneService', () => {
  it.each([
    ['+251911234567', '+251911234567'],
    ['251911234567', '+251911234567'],
    ['0911234567', '+251911234567'],
    ['911234567', '+251911234567'],
    [' +251 91 123 4567 ', '+251911234567'],
    ['0911-23-45-67', '+251911234567'],
    ['0712345678', '+251712345678'],
  ])('normalizes "%s" to %s', (input, expected) => {
    expect(service().normalize(input)).toBe(expected);
  });

  it.each(['', 'abc', '0911', '09112345678', '+251111234567', '+254712345678', '+14155552671'])(
    'rejects "%s"',
    (input) => {
      expect(() => service().normalize(input)).toThrow(AppException);
    },
  );

  it('accepts other countries once they are enabled by configuration', () => {
    expect(service(['ET', 'KE']).normalize('+254712345678')).toBe('+254712345678');
  });
});
