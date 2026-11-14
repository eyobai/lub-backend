import { applyDecorators } from '@nestjs/common';
import { IsISO8601, IsString, Matches, ValidateIf } from 'class-validator';

/** Like @IsOptional(), but an explicit `null` is still validated (and rejected unless the field allows it). */
export const IsUndefinable = () => ValidateIf((_object: object, value: unknown) => value !== undefined);

/** Money in integer minor units, sent as a string so large values keep full precision. Max 10^15. */
export function IsMinorAmount(options: { allowZero?: boolean; each?: boolean } = {}) {
  const each = options.each ?? false;
  const subject = (property: string) => (each ? `each value in ${property}` : property);
  return applyDecorators(
    IsString({ each, message: (args) => `${subject(args.property)} must be a string of digits` }),
    Matches(options.allowZero ? /^(0|[1-9][0-9]{0,14})$/ : /^[1-9][0-9]{0,14}$/, {
      each,
      message: (args) =>
        `${subject(args.property)} must be a ${options.allowZero ? 'non-negative' : 'positive'} whole number of minor units`,
    }),
  );
}

export function IsInstant() {
  return applyDecorators(
    IsISO8601({ strict: true, strictSeparator: true }),
    Matches(/T.*(Z|[+-][0-9]{2}:[0-9]{2})$/, {
      message: (args) => `${args.property} must include a time and time zone, e.g. 2027-01-31T09:00:00+03:00`,
    }),
  );
}
