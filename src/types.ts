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
  message?: string;
}
