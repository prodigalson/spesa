import type { ErrorCode } from "./types.ts";

// Structured exit codes inspired by zonasul
// 0 = success, 1-10 = specific error categories
export const EXIT_CODES: Record<string, number> = {
  SUCCESS: 0,
  LOGIN_REQUIRED: 1,
  SESSION_EXPIRED: 2,
  MFA_REQUIRED: 3,
  INVALID_INPUT: 4,
  PRODUCT_NOT_FOUND: 5,
  ADD_TO_CART_FAILED: 6,
  CART_EMPTY: 7,
  SLOT_UNAVAILABLE: 8,
  ORDER_FAILED: 9,
  WAF_BLOCKED: 10,
  NETWORK_ERROR: 11,
  BROWSER_ERROR: 12,
  UNKNOWN: 13,
};

export function exitCodeFor(errorCode?: ErrorCode): number {
  if (!errorCode) return EXIT_CODES.UNKNOWN;
  return EXIT_CODES[errorCode] ?? EXIT_CODES.UNKNOWN;
}
