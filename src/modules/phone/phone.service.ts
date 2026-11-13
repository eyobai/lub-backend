import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { parsePhoneNumberFromString, PhoneNumber } from 'libphonenumber-js/max';
import { AppException, ErrorCode } from '../../common/errors/app.exception';
import { APP_CONFIG } from '../../config/configuration';
import type { AppConfig } from '../../config/configuration';

const MOBILE_TYPES = new Set(['MOBILE', 'FIXED_LINE_OR_MOBILE']);

@Injectable()
export class PhoneService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Normalizes user input ("0911234567", "911234567", "251911234567", "+251 91 123 4567") to E.164
   * and rejects anything that is not a valid mobile number of an allowed country.
   */
  normalize(input: string): string {
    const parsed = this.parse(input);
    if (!parsed) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_PHONE_NUMBER,
        `Enter a valid mobile phone number (supported countries: ${this.config.phone.allowedCountries.join(', ')})`,
      );
    }
    return parsed.number;
  }

  private parse(input: string): PhoneNumber | undefined {
    const raw = (input ?? '').trim();
    const candidates = [raw];
    // "251911234567" — international format typed without the leading "+".
    if (/^\d+$/.test(raw) && !raw.startsWith('0')) candidates.push(`+${raw}`);

    for (const candidate of candidates) {
      const phone = parsePhoneNumberFromString(candidate, this.config.phone.defaultCountry);
      if (
        phone?.isValid() &&
        phone.country &&
        this.config.phone.allowedCountries.includes(phone.country) &&
        MOBILE_TYPES.has(phone.getType() ?? '')
      ) {
        return phone;
      }
    }
    return undefined;
  }
}
