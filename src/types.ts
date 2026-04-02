export interface Product {
  id: string;
  name: string;
  brand?: string;
  price: number;
  pricePerUnit?: string;
  unit?: string;
  imageUrl?: string;
  url: string;
  available: boolean;
  quantity?: number;
  matchScore?: number;
}

export interface OrderConfirmation {
  orderId?: string;
  slot: DeliverySlot;
  total: number;
  itemCount: number;
}

export interface CartItem extends Product {
  quantity: number;
  subtotal: number;
}

export interface Cart {
  items: CartItem[];
  total: number;
  itemCount: number;
}

export interface DeliverySlot {
  id: string;
  date: string;
  timeRange: string;
  available: boolean;
  price?: number;
}

export interface Order {
  id: string;
  date: string;
  status: string;
  total: number;
  items?: OrderItem[];
}

export interface OrderItem {
  name: string;
  quantity: number;
  price: number;
}

export interface Session {
  platform: string;
  cookies: CookieData[];
  savedAt: string;
  username?: string;
}

export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface CliResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  errorCode?: ErrorCode;
  message?: string;
}

export type ErrorCode =
  | "SESSION_EXPIRED"
  | "LOGIN_REQUIRED"
  | "PRODUCT_NOT_FOUND"
  | "CART_EMPTY"
  | "SLOT_UNAVAILABLE"
  | "WAF_BLOCKED"
  | "NETWORK_ERROR"
  | "BROWSER_ERROR"
  | "MFA_REQUIRED"
  | "INVALID_INPUT"
  | "ADD_TO_CART_FAILED"
  | "ORDER_FAILED"
  | "UNKNOWN";
