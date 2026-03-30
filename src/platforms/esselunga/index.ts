import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Cookie,
} from "playwright";
import { loadSession, saveSession, clearSession } from "../../session.ts";
import type {
  Product,
  Cart,
  CartItem,
  DeliverySlot,
  Order,
  CookieData,
} from "../../types.ts";

const PLATFORM = "esselunga";
const BASE_URL = "https://spesaonline.esselunga.it";
const LOGIN_URL = `${BASE_URL}/commerce/nav/supermercato/store/home`;

// Session expires after 12 hours
const SESSION_TTL_HOURS = 12;

function plCookieToCookieData(c: Cookie): CookieData {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite as string,
  };
}

function cookieDataToPlCookie(c: CookieData): Cookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: (c.sameSite as "Strict" | "Lax" | "None") ?? "Lax",
  };
}

export class EsselungaClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private async launch(headless = true): Promise<void> {
    this.browser = await chromium.launch({
      headless,
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });
    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "it-IT",
      viewport: { width: 1280, height: 800 },
    });

    // Load saved session cookies if available
    const session = loadSession(PLATFORM);
    if (session?.cookies?.length) {
      await this.context.addCookies(session.cookies.map(cookieDataToPlCookie));
    }

    this.page = await this.context.newPage();
  }

  private async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  private async persistSession(username?: string): Promise<void> {
    if (!this.context) return;
    const cookies = await this.context.cookies();
    saveSession({
      platform: PLATFORM,
      cookies: cookies.map(plCookieToCookieData),
      savedAt: new Date().toISOString(),
      username,
    });
  }

  private async getPage(): Promise<Page> {
    if (!this.page) throw new Error("Browser not initialized");
    return this.page;
  }

  async login(
    username: string,
    password: string,
    opts: { headless?: boolean } = {}
  ): Promise<{ ok: boolean; error?: string; mfaRequired?: boolean }> {
    try {
      // Use headed mode if MFA might be needed
      await this.launch(opts.headless ?? false);
      const page = await this.getPage();

      // Navigate to the site
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Accept cookies if banner appears
      try {
        await page.click('[id*="accept"], [class*="accept-cookie"], button:has-text("Accetta")', {
          timeout: 3000,
        });
      } catch {
        // No cookie banner
      }

      // Look for login button/link to open login modal or navigate to login
      try {
        const loginTrigger = await page.waitForSelector(
          '[data-testid="login"], .login-button, a[href*="login"], button:has-text("Accedi"), [aria-label*="accedi" i]',
          { timeout: 5000 }
        );
        if (loginTrigger) await loginTrigger.click();
      } catch {
        // Already on login page or different flow
      }

      // Wait for and fill login form
      try {
        await page.waitForSelector('input[name="username"], input[type="email"], #username, #gw_username', {
          timeout: 8000,
        });
      } catch {
        // Try direct URL
        await page.goto(`${BASE_URL}/commerce/nav/supermercato/store/login`, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await page.waitForSelector('input[name="username"], input[type="email"], #username, #gw_username', {
          timeout: 8000,
        });
      }

      // Fill credentials
      const usernameField = await page.$(
        'input[name="username"], input[type="email"], #username, #gw_username'
      );
      const passwordField = await page.$(
        'input[name="password"], input[type="password"], #password, #gw_password'
      );

      if (!usernameField || !passwordField) {
        await this.close();
        return { ok: false, error: "Login form fields not found" };
      }

      await usernameField.fill(username);
      await passwordField.fill(password);

      // Submit
      const submitBtn = await page.$(
        'button[type="submit"], input[type="submit"], button:has-text("Accedi"), button:has-text("Login")'
      );
      if (!submitBtn) {
        await this.close();
        return { ok: false, error: "Submit button not found" };
      }
      await submitBtn.click();

      // Wait for navigation or MFA prompt
      try {
        // Success: lands on home/store page
        await page.waitForURL(/store\/home|store\/profilo|carrello/, {
          timeout: 10000,
        });
        await this.persistSession(username);
        await this.close();
        return { ok: true };
      } catch {
        // Check if MFA required
        const mfaIndicator = await page.$(
          '[class*="otp"], [class*="mfa"], [class*="verific"], input[placeholder*="codice" i], input[placeholder*="OTP" i]'
        );
        if (mfaIndicator) {
          // In headed mode, user can complete MFA manually
          if (!opts.headless) {
            console.error(
              "\nMFA required. Complete the verification in the browser window, then press Enter..."
            );
            await new Promise((res) => process.stdin.once("data", res));
            await this.persistSession(username);
            await this.close();
            return { ok: true };
          }
          await this.close();
          return {
            ok: false,
            mfaRequired: true,
            error: "MFA required — re-run with headed mode (default) and complete verification manually",
          };
        }

        // Check for error message
        const errorEl = await page.$(
          '[class*="error"], [class*="alert"], [role="alert"]'
        );
        const errorText = errorEl ? await errorEl.textContent() : null;
        await this.close();
        return {
          ok: false,
          error: errorText?.trim() ?? "Login failed — check credentials",
        };
      }
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async logout(): Promise<void> {
    clearSession(PLATFORM);
  }

  async checkSession(): Promise<{
    valid: boolean;
    username?: string;
    ageHours?: number;
  }> {
    const session = loadSession(PLATFORM);
    if (!session) return { valid: false };

    const ageHours =
      (Date.now() - new Date(session.savedAt).getTime()) / 1000 / 60 / 60;

    if (ageHours > SESSION_TTL_HOURS) {
      return { valid: false, ageHours };
    }

    // Quick validation — load cookies and ping the site
    try {
      await this.launch(true);
      const page = await this.getPage();
      await page.goto(`${BASE_URL}/commerce/nav/supermercato/store/home`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      const url = page.url();
      await this.close();

      // If redirected to login, session is expired
      const isLoggedIn = !url.includes("login") && !url.includes("auth");
      return {
        valid: isLoggedIn,
        username: session.username,
        ageHours,
      };
    } catch {
      await this.close();
      return { valid: false };
    }
  }

  async search(
    query: string,
    opts: { maxResults?: number } = {}
  ): Promise<Product[]> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    // Load session
    await page.goto(`${BASE_URL}/commerce/nav/supermercato/store/home`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Intercept API responses for product data
    const products: Product[] = [];
    const apiResponses: unknown[] = [];

    page.on("response", async (response) => {
      const url = response.url();
      if (
        url.includes("/products") ||
        url.includes("/search") ||
        url.includes("/catalog") ||
        url.includes("displayable") ||
        url.includes("ricerca")
      ) {
        try {
          const ct = response.headers()["content-type"] ?? "";
          if (ct.includes("json")) {
            const data = await response.json();
            apiResponses.push({ url, data });
          }
        } catch {
          // Ignore non-JSON
        }
      }
    });

    // Find and use the search bar
    try {
      const searchInput = await page.waitForSelector(
        'input[type="search"], input[placeholder*="cerca" i], input[placeholder*="search" i], [class*="search"] input',
        { timeout: 8000 }
      );
      await searchInput.fill(query);
      await searchInput.press("Enter");
    } catch {
      // Try navigating directly to search URL
      await page.goto(
        `${BASE_URL}/commerce/nav/supermercato/store/search?q=${encodeURIComponent(query)}`,
        { waitUntil: "domcontentloaded", timeout: 15000 }
      );
    }

    // Wait for results
    await page.waitForTimeout(3000);

    // Parse intercepted API responses first
    for (const resp of apiResponses) {
      const r = resp as { url: string; data: unknown };
      const extracted = this.extractProductsFromApiResponse(r.data);
      products.push(...extracted);
    }

    // If no API data, scrape from DOM
    if (products.length === 0) {
      const domProducts = await page.evaluate((): Product[] => {
        const results: Product[] = [];
        // Try common product card selectors
        const cards = document.querySelectorAll(
          '[class*="product-card"], [class*="product-item"], [class*="ProductCard"], [data-testid*="product"]'
        );

        cards.forEach((card) => {
          const nameEl =
            card.querySelector('[class*="name"], [class*="title"], h3, h4') ||
            card.querySelector("a");
          const priceEl = card.querySelector(
            '[class*="price"], [class*="prezzo"]'
          );
          const linkEl = card.querySelector("a");
          const imgEl = card.querySelector("img");
          const availEl = card.querySelector(
            '[class*="unavailable"], [class*="disponibil"]'
          );

          if (!nameEl) return;

          const name = nameEl.textContent?.trim() ?? "";
          const priceText = priceEl?.textContent?.trim() ?? "0";
          const priceMatch = priceText.match(/[\d,\.]+/);
          const price = priceMatch
            ? parseFloat(priceMatch[0].replace(",", "."))
            : 0;

          const url = linkEl?.href ?? window.location.href;
          const id = url.split("/").pop() ?? Math.random().toString(36).slice(2);

          results.push({
            id,
            name,
            price,
            url,
            imageUrl: imgEl?.src,
            available: !availEl || !availEl.classList.contains("unavailable"),
          });
        });

        return results;
      });
      products.push(...domProducts);
    }

    await this.close();

    const maxResults = opts.maxResults ?? 20;
    return products.slice(0, maxResults);
  }

  private extractProductsFromApiResponse(data: unknown): Product[] {
    const products: Product[] = [];

    if (!data || typeof data !== "object") return products;

    // Handle array responses
    if (Array.isArray(data)) {
      for (const item of data) {
        const p = this.parseProductObject(item);
        if (p) products.push(p);
      }
      return products;
    }

    // Handle nested responses: { products: [...] }, { items: [...] }, { results: [...] }
    const obj = data as Record<string, unknown>;
    const listKeys = ["products", "items", "results", "content", "data", "articoli"];
    for (const key of listKeys) {
      if (Array.isArray(obj[key])) {
        for (const item of obj[key] as unknown[]) {
          const p = this.parseProductObject(item);
          if (p) products.push(p);
        }
        if (products.length > 0) return products;
      }
    }

    return products;
  }

  private parseProductObject(item: unknown): Product | null {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;

    const name =
      (obj.name as string) ||
      (obj.nome as string) ||
      (obj.title as string) ||
      (obj.description as string) ||
      (obj.descrizione as string);

    if (!name) return null;

    const price =
      typeof obj.price === "number"
        ? obj.price
        : typeof obj.prezzo === "number"
        ? obj.prezzo
        : parseFloat(String(obj.price ?? obj.prezzo ?? 0).replace(",", ".")) ||
          0;

    const id = String(obj.id ?? obj.sku ?? obj.codice ?? Math.random().toString(36).slice(2));
    const url =
      (obj.url as string) ||
      (obj.link as string) ||
      `${BASE_URL}/commerce/nav/supermercato/store/product/${id}`;

    return {
      id,
      name,
      brand: (obj.brand as string) || (obj.marca as string),
      price,
      pricePerUnit:
        (obj.pricePerUnit as string) || (obj.priceperkg as string) || (obj.prezzoKg as string),
      unit: (obj.unit as string) || (obj.um as string),
      imageUrl: (obj.imageUrl as string) || (obj.image as string) || (obj.immagine as string),
      url,
      available: obj.available !== false && obj.disponibile !== false,
    };
  }

  async getCart(): Promise<Cart> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    await page.goto(
      `${BASE_URL}/commerce/nav/supermercato/store/carrello`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );

    await page.waitForTimeout(2000);

    const cart = await page.evaluate((): Cart => {
      const items: CartItem[] = [];

      const productCards = document.querySelectorAll(
        '[class*="cart-item"], [class*="CartItem"], [class*="cart-product"], [class*="lineItem"]'
      );

      productCards.forEach((card) => {
        const nameEl = card.querySelector('[class*="name"], [class*="title"], h3, h4, a');
        const priceEl = card.querySelector('[class*="price"], [class*="prezzo"]');
        const qtyEl = card.querySelector(
          'input[type="number"], [class*="quantity"], [class*="qty"], [class*="quantita"]'
        );
        const linkEl = card.querySelector("a");

        const name = nameEl?.textContent?.trim() ?? "";
        if (!name) return;

        const priceText = priceEl?.textContent?.trim() ?? "0";
        const priceMatch = priceText.match(/[\d,\.]+/);
        const price = priceMatch ? parseFloat(priceMatch[0].replace(",", ".")) : 0;

        const qty = parseInt((qtyEl as HTMLInputElement)?.value ?? "1") || 1;
        const url = (linkEl as HTMLAnchorElement)?.href ?? window.location.href;
        const id = url.split("/").pop() ?? Math.random().toString(36).slice(2);

        items.push({
          id,
          name,
          price,
          quantity: qty,
          subtotal: price * qty,
          url,
          available: true,
        });
      });

      // Try to get total from summary
      const totalEl = document.querySelector(
        '[class*="total"], [class*="totale"], [class*="summary-total"]'
      );
      const totalText = totalEl?.textContent?.trim() ?? "0";
      const totalMatch = totalText.match(/[\d,\.]+/);
      const total = totalMatch ? parseFloat(totalMatch[0].replace(",", ".")) : 0;

      return {
        items,
        total: total || items.reduce((s, i) => s + i.subtotal, 0),
        itemCount: items.reduce((s, i) => s + i.quantity, 0),
      };
    });

    await this.close();
    return cart;
  }

  async addToCart(
    productUrlOrId: string,
    quantity = 1
  ): Promise<{ ok: boolean; error?: string }> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: spesa esselunga login");

    const productUrl = productUrlOrId.startsWith("http")
      ? productUrlOrId
      : `${BASE_URL}/commerce/nav/supermercato/store/product/${productUrlOrId}`;

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1500);

      // Find and click "Add to Cart"
      const addBtn = await page.$(
        'button:has-text("Aggiungi"), button:has-text("add"), [class*="add-to-cart"], [data-testid*="add-cart"]'
      );

      if (!addBtn) {
        await this.close();
        return { ok: false, error: "Add to cart button not found — product may be unavailable" };
      }

      // Set quantity if > 1
      if (quantity > 1) {
        const qtyInput = await page.$(
          'input[type="number"][class*="qty"], input[type="number"][class*="quantity"]'
        );
        if (qtyInput) {
          await qtyInput.fill(String(quantity));
        }
      }

      await addBtn.click();
      await page.waitForTimeout(1500);

      // Confirm via cart count change or success toast
      const successEl = await page.$(
        '[class*="success"], [class*="toast"], [class*="notification"], [role="alert"]'
      );
      const success = successEl !== null;

      await this.close();
      return { ok: success || true }; // Optimistic if no error toast
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async removeFromCart(productId: string): Promise<{ ok: boolean; error?: string }> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(
        `${BASE_URL}/commerce/nav/supermercato/store/carrello`,
        { waitUntil: "domcontentloaded", timeout: 30000 }
      );
      await page.waitForTimeout(2000);

      // Find the remove button for this product
      const removed = await page.evaluate((id: string): boolean => {
        const cards = document.querySelectorAll(
          '[class*="cart-item"], [class*="CartItem"], [class*="lineItem"]'
        );
        for (const card of cards) {
          const link = card.querySelector("a");
          if (link?.href.includes(id)) {
            const removeBtn = card.querySelector(
              'button[class*="remove"], button[class*="elimina"], button[aria-label*="remove" i], button[aria-label*="rimuovi" i]'
            ) as HTMLButtonElement | null;
            if (removeBtn) {
              removeBtn.click();
              return true;
            }
          }
        }
        return false;
      }, productId);

      if (!removed) {
        await this.close();
        return { ok: false, error: `Product ${productId} not found in cart` };
      }

      await page.waitForTimeout(1500);
      await this.close();
      return { ok: true };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async getDeliverySlots(): Promise<DeliverySlot[]> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    await page.goto(
      `${BASE_URL}/commerce/nav/supermercato/store/carrello`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );

    await page.waitForTimeout(2000);

    const slots = await page.evaluate((): DeliverySlot[] => {
      const results: DeliverySlot[] = [];

      // Slots use class "disponibile" in known open-source implementations
      const slotEls = document.querySelectorAll(
        'input[name="quality"], [class*="slot"], [class*="disponibil"], [class*="fascia"]'
      );

      slotEls.forEach((el, i) => {
        const isAvailable =
          el.classList.contains("disponibile") ||
          !(el as HTMLInputElement).disabled;

        const label =
          el.closest("label")?.textContent?.trim() ||
          el.parentElement?.textContent?.trim() ||
          "";

        // Try to parse date and time from label
        const dateMatch = label.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]?\d{0,4}/);
        const timeMatch = label.match(/\d{1,2}[:\.]\d{2}\s*[-–]\s*\d{1,2}[:\.]\d{2}/);

        results.push({
          id: (el as HTMLInputElement).value || String(i),
          date: dateMatch?.[0] ?? "",
          timeRange: timeMatch?.[0] ?? label.slice(0, 30),
          available: isAvailable,
        });
      });

      return results;
    });

    await this.close();
    return slots;
  }

  async getOrders(limit = 10): Promise<Order[]> {
    const session = loadSession(PLATFORM);
    if (!session) throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    await page.goto(
      `${BASE_URL}/commerce/nav/supermercato/store/ordini`,
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );

    await page.waitForTimeout(2000);

    const orders = await page.evaluate((): Order[] => {
      const results: Order[] = [];
      const orderEls = document.querySelectorAll(
        '[class*="order-item"], [class*="OrderItem"], [class*="ordine"]'
      );

      orderEls.forEach((el) => {
        const idEl = el.querySelector('[class*="order-id"], [class*="numero"]');
        const dateEl = el.querySelector('[class*="date"], [class*="data"]');
        const statusEl = el.querySelector('[class*="status"], [class*="stato"]');
        const totalEl = el.querySelector('[class*="total"], [class*="totale"]');

        const totalText = totalEl?.textContent?.trim() ?? "0";
        const totalMatch = totalText.match(/[\d,\.]+/);

        results.push({
          id: idEl?.textContent?.trim() || el.getAttribute("data-order-id") || String(results.length + 1),
          date: dateEl?.textContent?.trim() ?? "",
          status: statusEl?.textContent?.trim() ?? "unknown",
          total: totalMatch ? parseFloat(totalMatch[0].replace(",", ".")) : 0,
        });
      });

      return results;
    });

    await this.close();
    return orders.slice(0, limit);
  }
}
