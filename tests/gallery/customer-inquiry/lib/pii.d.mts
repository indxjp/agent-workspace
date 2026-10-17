// Types for `pii.mjs`, which the CRM server (plain Node) and the chat backend share.
export interface PiiOptions {
  /** Values masked verbatim wherever they appear: the customer's own phone, address, e-mail. */
  readonly known?: readonly string[];
  /** Public values left alone, such as the company's free-dial number. */
  readonly allow?: readonly string[];
}

export interface PiiFinding {
  readonly kind: 'email' | 'postal' | 'address' | 'phone';
  readonly match: string;
}

export function maskPii(text: string, options?: PiiOptions): string;
export function maskDeep<T>(value: T, options?: PiiOptions): T;
export function findPii(text: string, options?: Pick<PiiOptions, 'allow'>): PiiFinding[];
