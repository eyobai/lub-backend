import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks a route as not requiring an access token. Everything else is protected by default. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
