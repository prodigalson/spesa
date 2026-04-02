import {
  webkit,
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
  OrderConfirmation,
  CookieData,
  CliResult,
  ErrorCode,
} from "../../types.ts";

const PLATFORM = "esselunga";
const BASE_URL = "https://spesaonline.esselunga.it";
const HOME_PATH = "/commerce/nav/supermercato/store/home";
const HOME_URL = `${BASE_URL}${HOME_PATH}`;

// The login flow starts at the homepage and redirects through account.esselunga.it
const AUTH_DOMAIN = "account.esselunga.it";

// Esselunga's Angular SPA is slow to boot — needs generous timeouts
const NAV_TIMEOUT = 45000;
const SESSION_TTL_HOURS = 12;

// DOM-ready polling: instead of a fixed 8s wait, poll for SPA readiness
const SPA_READY_TIMEOUT = 15000;
const SPA_POLL_INTERVAL = 500;

// ─── Real selectors discovered via live site inspection ─────────────────────

// Homepage (spesaonline.esselunga.it)
const SEL = {
  // Search bar: ARIA combobox labelled "Cerca prodotti o marche"
  searchInput: '[role="combobox"][aria-label*="Cerca" i], input[placeholder*="Cerca prodotti" i]',
  searchButton: 'button[aria-label*="Cerca" i]',

  // Login trigger on homepage
  loginButton: 'button:has-text("Accedi")',

  // "Start shopping" — required to set delivery address before search works
  startShopping: 'button:has-text("Inizia la spesa")',

  // Login form on account.esselunga.it
  loginEmail: 'input[type="text"][aria-label*="mail" i], input[type="email"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button:has-text("ACCEDI")',
  stayLoggedIn: 'input[type="checkbox"]',

  // Product cards — on both home and search results
  productOption: '[role="option"]',
  addToCartButton: 'button[aria-label*="Aggiungi al carrello" i]',
  productDetailLink: 'a[aria-label*="dettaglio" i], a[href*="product"]',
  productQtySelect: 'select[aria-label*="Quantit" i], [role="combobox"][aria-label*="Quantit" i]',

  // Cart/trolley page
  trolleyItem: 'div.esselunga-checkout-trolley-container[ng-repeat]',
  trolleyProdDiv: 'div.esselunga-checkout-trolley-container-prod[id]',
  trolleyNameLink: 'a.esselunga-checkout-trolley-container-prod-desc-label',
  trolleyDeleteBtn: 'button[aria-label*="Elimina" i], button[ng-click*="deleteTrolleyItem"]',

  // Slot picker
  deliveryBtn: 'button[ng-click*="onDeliveryClick"]',
  slotGrid: 'div.esselunga-slots.el-show .esselunga-slots-grid',

  // Order confirmation
  confirmBtn: 'button:has-text("CONFERMA"), button:has-text("Conferma ordine"), button[ng-click*="confirm"]',
  orderSuccess: '[class*="order-confirm"], [class*="ordine-conferm"]',
} as const;

// ─── Cookie conversion ──────────────────────────────────────────────────────

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

// ─── Match scoring ──────────────────────────────────────────────────────────

function computeMatchScore(query: string, product: { name: string; brand?: string }): number {
  const q = query.toLowerCase().trim();
  const name = product.name.toLowerCase();
  const brand = (product.brand ?? "").toLowerCase();
  const full = `${name} ${brand}`;

  // Exact match
  if (name === q) return 1.0;

  // Full query appears as substring
  if (full.includes(q)) return 0.9;

  // All query words present
  const words = q.split(/\s+/).filter(Boolean);
  const allPresent = words.every((w) => full.includes(w));
  if (allPresent) return 0.7 + (0.1 * words.length / Math.max(words.length, full.split(/\s+/).length));

  // Partial word matches
  const matched = words.filter((w) => full.includes(w));
  if (matched.length > 0) return 0.3 + (0.3 * matched.length / words.length);

  return 0.1;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class EsselungaClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private async launch(headless = true): Promise<void> {
    try {
      this.browser = await webkit.launch({
        headless,
      });
    } catch (e: unknown) {
      const msg = String(e);
      if (
        msg.includes("Executable doesn't exist") ||
        msg.includes("browserType.launch")
      ) {
        throw new Error(
          "Playwright WebKit is not installed. Run: bunx playwright install webkit"
        );
      }
      if (
        msg.includes("libmanette") ||
        msg.includes("libenchant") ||
        msg.includes("libhyphen") ||
        msg.includes("libsecret") ||
        msg.includes("libwoff") ||
        msg.includes("shared libraries") ||
        msg.includes(".so")
      ) {
        throw new Error(
          "Missing system libraries for Playwright WebKit. Run: sudo npx playwright install-deps webkit\n" +
          "Do NOT attempt to install individual packages manually."
        );
      }
      throw e;
    }
    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
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

  /**
   * Wait for the Esselunga AngularJS SPA to boot instead of a fixed delay.
   * Polls for AngularJS readiness or key DOM elements.
   */
  private async waitForSpaReady(page: Page, opts?: { selector?: string }): Promise<void> {
    const startTime = Date.now();
    const targetSelector = opts?.selector;

    while (Date.now() - startTime < SPA_READY_TIMEOUT) {
      const ready = await page.evaluate((sel) => {
        // Check if AngularJS has bootstrapped
        const ngReady = !!(window as any).angular?.element?.(document.body)?.injector?.();
        // Check if a specific target element exists
        const targetReady = sel ? !!document.querySelector(sel) : true;
        // When a specific selector is requested, require it — Angular bootstraps
        // before search results load, so ngReady alone is not sufficient.
        if (sel) return targetReady;
        // No specific selector: fall back to Angular readiness + no loader overlay
        const noLoader = !document.querySelector('.loading-overlay, .spinner, .el-pre-loader-bg.el-show');
        return ngReady && noLoader;
      }, targetSelector);

      if (ready) return;
      await page.waitForTimeout(SPA_POLL_INTERVAL);
    }
    // Timeout reached — proceed anyway (some pages may not have angular)
  }

  /** Check if Esselunga is reachable before launching a full browser session */
  static async checkConnectivity(): Promise<{ reachable: boolean; error?: string }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch("https://spesaonline.esselunga.it", {
        method: "HEAD",
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      return { reachable: res.ok || res.status < 500 };
    } catch {
      return {
        reachable: false,
        error:
          "Cannot reach spesaonline.esselunga.it. Your IP may be temporarily blocked.\n" +
          "Try: restart your router to get a new IP, or wait 30-60 minutes.",
      };
    }
  }

  // ─── Auth ───────────────────────────────────────────────────────────────────

  async login(
    username: string,
    password: string,
    opts: { headless?: boolean } = {}
  ): Promise<{ ok: boolean; error?: string; mfaRequired?: boolean }> {
    try {
      const conn = await EsselungaClient.checkConnectivity();
      if (!conn.reachable) {
        return { ok: false, error: conn.error ?? "Cannot reach Esselunga" };
      }

      await this.launch(opts.headless ?? false);
      const page = await this.getPage();

      const loginUrl =
        `https://${AUTH_DOMAIN}/area-utenti/applicationCheck` +
        `?appName=spesaOnLine` +
        `&daru=${encodeURIComponent(BASE_URL + ":443/commerce/login/spesaonline/store/home?")}` +
        `&loginType=light`;

      await page.goto(loginUrl, { waitUntil: "commit", timeout: 30000 });

      const emailField = await page.waitForSelector(SEL.loginEmail, { timeout: 30000 });
      const passField = await page.waitForSelector(SEL.loginPassword, { timeout: 5000 });

      await emailField.fill(username);
      await passField.fill(password);

      // Tick "Resta connesso" for longer sessions
      try {
        const stayCheck = await page.$(SEL.stayLoggedIn);
        if (stayCheck) {
          const checked = await stayCheck.isChecked();
          if (!checked) await stayCheck.check();
        }
      } catch {
        // Not critical
      }

      const submitBtn = await page.waitForSelector(SEL.loginSubmit, { timeout: 3000 });
      await submitBtn.click();

      try {
        await page.waitForURL(/spesaonline\.esselunga\.it/, { timeout: 60000 });
        await page.waitForTimeout(3000);
        await this.persistSession(username);
        await this.close();
        return { ok: true };
      } catch {
        const currentUrl = page.url();

        if (currentUrl.includes(AUTH_DOMAIN)) {
          const pageText = await page.textContent("body");
          const hasMFA =
            pageText?.includes("codice") ||
            pageText?.includes("OTP") ||
            pageText?.includes("verifica") ||
            pageText?.includes("conferma");

          if (hasMFA && !opts.headless) {
            console.error(
              "\n🔐 MFA required. Complete the verification in the browser window..."
            );
            console.error("   Press Enter here once you've completed MFA.\n");
            await new Promise((res) => process.stdin.once("data", res));

            try {
              await page.waitForURL(/spesaonline\.esselunga\.it/, { timeout: 30000 });
            } catch {
              // user might still be on auth page — save anyway
            }
            await this.persistSession(username);
            await this.close();
            return { ok: true };
          }

          if (hasMFA) {
            await this.close();
            return {
              ok: false,
              mfaRequired: true,
              error:
                "MFA required. Run login without --headless (default) and complete verification in the browser.",
            };
          }

          const errorEl = await page.$('[role="alert"], [class*="error"], [class*="errore"]');
          const errorText = errorEl ? await errorEl.textContent() : null;
          await this.close();
          return {
            ok: false,
            error: errorText?.trim() || "Login failed. Check your credentials.",
          };
        }

        await this.close();
        return { ok: false, error: `Unexpected state after login. URL: ${currentUrl}` };
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

    try {
      const conn = await EsselungaClient.checkConnectivity();
      if (!conn.reachable) {
        return { valid: false };
      }

      await this.launch(true);
      const page = await this.getPage();
      await page.goto(HOME_URL, {
        waitUntil: "commit",
        timeout: NAV_TIMEOUT,
      });
      await this.waitForSpaReady(page);
      const url = page.url();
      await this.close();

      const isLoggedIn =
        !url.includes("login") &&
        !url.includes("auth") &&
        !url.includes(AUTH_DOMAIN);

      return { valid: isLoggedIn, username: session.username, ageHours };
    } catch {
      await this.close();
      return { valid: false };
    }
  }

  // ─── Search ─────────────────────────────────────────────────────────────────

  async search(
    query: string,
    opts: { maxResults?: number } = {}
  ): Promise<Product[]> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      // Intercept XHR/fetch responses that might contain product JSON
      const apiResponses: { url: string; data: unknown }[] = [];
      page.on("response", async (response) => {
        const url = response.url();
        if (
          url.includes("/products") ||
          url.includes("/search") ||
          url.includes("/catalog") ||
          url.includes("displayable") ||
          url.includes("ricerca") ||
          url.includes("/ecommerce/resources")
        ) {
          try {
            const ct = response.headers()["content-type"] ?? "";
            if (ct.includes("json")) {
              const data = await response.json();
              apiResponses.push({ url, data });
            }
          } catch {
            // Not JSON
          }
        }
      });

      const searchUrl = `${BASE_URL}/commerce/nav/supermercato/store/ricerca/${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: "commit", timeout: 30000 });
      await this.waitForSpaReady(page, { selector: "div.product[id]" });

      const products: Product[] = [];

      // 1. Try intercepted API responses first (most reliable)
      for (const resp of apiResponses) {
        const extracted = this.extractProductsFromApiResponse(resp.data);
        products.push(...extracted);
      }

      // 2. Scrape from the real DOM structure
      if (products.length === 0) {
        const domProducts = await page.evaluate((): Product[] => {
          const results: Product[] = [];
          const cards = document.querySelectorAll("div.product[id]");

          cards.forEach((card) => {
            const link = card.querySelector("a[aria-label]");
            const img = card.querySelector("img[alt]");
            const name = link?.getAttribute("aria-label") || img?.getAttribute("alt") || "";
            if (!name) return;

            const href = link?.getAttribute("href") ?? "";
            const fullUrl = href.startsWith("http") ? href : `https://spesaonline.esselunga.it${href}`;

            const skuMatch = href.match(/\/prodotto\/(\d+)\//);
            const sku = skuMatch?.[1] ?? card.id;

            const cardText = card.textContent ?? "";
            const currentPriceMatch = cardText.match(/Prezzo attuale\s*([\d,]+)\s*€/);
            const fallbackPriceMatch = cardText.match(/([\d,]+)\s*€/);
            const priceStr = currentPriceMatch?.[1] ?? fallbackPriceMatch?.[1] ?? "0";
            const price = parseFloat(priceStr.replace(",", ".")) || 0;

            const perUnitMatch = cardText.match(/([\d,]+)\s*€\s*\/\s*(\w+)/);
            const pricePerUnit = perUnitMatch ? `${perUnitMatch[1]} €/${perUnitMatch[2]}` : undefined;

            const imageUrl = img?.getAttribute("src") ?? undefined;

            results.push({
              id: sku,
              name,
              price,
              pricePerUnit,
              url: fullUrl,
              imageUrl,
              available: true,
            });
          });

          return results;
        });
        products.push(...domProducts);
      }

      // 3. If still no results, check if the page says "Risultati della ricerca (0)"
      if (products.length === 0) {
        const pageText = await page.textContent("body");
        if (pageText?.includes("(0)") || pageText?.includes("nessun risultato")) {
          const needsAddress = pageText?.includes("Verifica indirizzo") || pageText?.includes("Inizia la spesa");
          if (needsAddress) {
            await this.close();
            throw new Error(
              "No results. You need to set a delivery address first.\n" +
                'Run: spesa esselunga login (the browser will let you set your address after logging in)'
            );
          }
        }
      }

      // Add match scores
      for (const p of products) {
        p.matchScore = computeMatchScore(query, p);
      }

      // Sort by match score (highest first)
      products.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));

      await this.close();
      const maxResults = opts.maxResults ?? 20;
      return products.slice(0, maxResults);
    } catch (e: unknown) {
      await this.close();
      throw e;
    }
  }

  private extractProductsFromApiResponse(data: unknown): Product[] {
    const products: Product[] = [];
    if (!data || typeof data !== "object") return products;

    if (Array.isArray(data)) {
      for (const item of data) {
        const p = this.parseProductObject(item);
        if (p) products.push(p);
      }
      return products;
    }

    const obj = data as Record<string, unknown>;
    const listKeys = [
      "products", "items", "results", "content", "data",
      "articoli", "prodotti", "elenco",
    ];
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
          : parseFloat(String(obj.price ?? obj.prezzo ?? 0).replace(",", ".")) || 0;

    const id = String(obj.id ?? obj.sku ?? obj.codice ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32));
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

  // ─── Cart ───────────────────────────────────────────────────────────────────

  async addToCart(
    productUrlOrId: string,
    quantity = 1
  ): Promise<{ ok: boolean; error?: string }> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    try {
      await this.launch(true);
      const page = await this.getPage();

      if (productUrlOrId.startsWith("http")) {
        await page.goto(productUrlOrId, { waitUntil: "commit", timeout: 30000 });
      } else {
        const searchUrl = `${BASE_URL}/commerce/nav/supermercato/store/ricerca/${encodeURIComponent(productUrlOrId)}`;
        await page.goto(searchUrl, { waitUntil: "commit", timeout: 30000 });
      }

      await this.waitForSpaReady(page, { selector: SEL.addToCartButton });

      // Set quantity using the combobox/select if > 1
      if (quantity > 1) {
        const qtySelect = await page.$(SEL.productQtySelect);
        if (qtySelect) {
          try {
            await qtySelect.selectOption(String(quantity));
          } catch {
            await this.close();
            return { ok: false, error: `Failed to set quantity to ${quantity}. The product may only support qty=1.` };
          }
        } else {
          await this.close();
          return { ok: false, error: `Quantity selector not found. Cannot set quantity to ${quantity}.` };
        }
      }

      // Click "Aggiungi al carrello"
      const addBtn = await page.$(SEL.addToCartButton);
      if (!addBtn) {
        await this.close();
        return { ok: false, error: "Add to cart button not found. Product may be unavailable or page didn't load." };
      }

      await addBtn.click();
      await page.waitForTimeout(2000);

      await this.persistSession();
      await this.close();
      return { ok: true };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async addManyToCart(
    items: { query: string; qty?: number; pick?: string }[]
  ): Promise<{ query: string; qty: number; ok: boolean; error?: string; product?: Product }[]> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    const results: { query: string; qty: number; ok: boolean; error?: string; product?: Product }[] = [];

    // Use a single browser session for all items
    await this.launch(true);
    const page = await this.getPage();

    try {
      for (const item of items) {
        const qty = item.qty ?? 1;
        const pick = item.pick ?? "first";

        try {
          // Search
          const searchUrl = `${BASE_URL}/commerce/nav/supermercato/store/ricerca/${encodeURIComponent(item.query)}`;
          await page.goto(searchUrl, { waitUntil: "commit", timeout: 30000 });
          await this.waitForSpaReady(page, { selector: "div.product[id]" });

          // Find add-to-cart button (first product result)
          const addBtn = await page.$(SEL.addToCartButton);
          if (!addBtn) {
            results.push({ query: item.query, qty, ok: false, error: "No products found or add button not found" });
            continue;
          }

          // Set quantity if > 1
          if (qty > 1) {
            const qtySelect = await page.$(SEL.productQtySelect);
            if (qtySelect) {
              try {
                await qtySelect.selectOption(String(qty));
              } catch {
                // Continue with qty=1
              }
            }
          }

          await addBtn.click();
          await page.waitForTimeout(2000);
          results.push({ query: item.query, qty, ok: true });
        } catch (e: unknown) {
          results.push({ query: item.query, qty, ok: false, error: String(e) });
        }
      }

      await this.persistSession();
      await this.close();
      return results;
    } catch (e: unknown) {
      await this.close();
      throw e;
    }
  }

  async getCart(): Promise<Cart> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/commerce/nav/supermercato/checkout/trolley`, {
        waitUntil: "networkidle",
        timeout: NAV_TIMEOUT,
      });
      await this.waitForSpaReady(page, { selector: SEL.trolleyItem });

      const cart = await page.evaluate((): Cart => {
        const items: CartItem[] = [];

        const cards = document.querySelectorAll("div.esselunga-checkout-trolley-container[ng-repeat]");

        cards.forEach((card) => {
          const nameLink = card.querySelector("a.esselunga-checkout-trolley-container-prod-desc-label");
          const name = nameLink?.textContent?.trim() ?? "";
          if (!name) return;

          const prodDiv = card.querySelector("div.esselunga-checkout-trolley-container-prod[id]");
          const trolleyId = prodDiv?.id ?? "";
          const idParts = trolleyId.split("_");
          const sku = idParts.length >= 2 ? idParts[1] : trolleyId;

          const unitPriceDiv = card.querySelector(".esselunga-checkout-trolley-container-prod-unitprice");
          const unitText = unitPriceDiv?.textContent ?? "";
          const currentPriceMatch = unitText.match(/Prezzo Attuale\s*([\d,]+)\s*€/i);
          const fallbackPriceMatch = unitText.match(/([\d,]+)\s*€/);
          const priceStr = currentPriceMatch?.[1] ?? fallbackPriceMatch?.[1] ?? "0";
          const price = parseFloat(priceStr.replace(",", ".")) || 0;

          const totalPriceDiv = card.querySelector(".esselunga-checkout-trolley-container-totalprice");
          const totalText = totalPriceDiv?.textContent ?? "";
          const totalPriceMatch = totalText.match(/Prezzo Attuale\s*([\d,]+)\s*€/i);
          const totalFallback = totalText.match(/([\d,]+)\s*€/);
          const subtotal = parseFloat((totalPriceMatch?.[1] ?? totalFallback?.[1] ?? "0").replace(",", ".")) || 0;

          const qtySelect = card.querySelector('select');
          const qty = qtySelect
            ? (parseInt((qtySelect as HTMLSelectElement).value) || 1)
            : (price > 0 ? Math.round(subtotal / price) : 1);

          const descDiv = card.querySelector(".esselunga-checkout-trolley-container-prod-desc");
          const descText = descDiv?.textContent ?? "";
          const perUnitMatch = descText.match(/([\d,]+)\s*€\s*\/\s*(\w+)/);
          const pricePerUnit = perUnitMatch ? `${perUnitMatch[1]} €/${perUnitMatch[2]}` : undefined;

          const img = card.querySelector("img");
          const imageUrl = img?.getAttribute("src") ?? undefined;

          items.push({
            id: sku,
            name,
            price,
            quantity: qty,
            subtotal: subtotal || price * qty,
            url: `https://spesaonline.esselunga.it/commerce/nav/supermercato/store/prodotto/${sku}/`,
            imageUrl,
            pricePerUnit,
            available: true,
          });
        });

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
    } catch (e: unknown) {
      await this.close();
      throw e;
    }
  }

  async removeFromCart(productId: string): Promise<{ ok: boolean; error?: string }> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/commerce/nav/supermercato/checkout/trolley`, {
        waitUntil: "networkidle",
        timeout: NAV_TIMEOUT,
      });
      await this.waitForSpaReady(page, { selector: SEL.trolleyItem });

      const removed = await page.evaluate((id: string): boolean => {
        const cards = document.querySelectorAll("div.esselunga-checkout-trolley-container[ng-repeat]");

        for (const card of cards) {
          const prodDiv = card.querySelector("div.esselunga-checkout-trolley-container-prod[id]");
          const trolleyId = prodDiv?.id ?? "";
          const idParts = trolleyId.split("_");
          const sku = idParts.length >= 2 ? idParts[1] : "";
          const name = card.querySelector("a.esselunga-checkout-trolley-container-prod-desc-label")?.textContent?.trim() ?? "";

          if (sku === id || trolleyId.includes(id) || name.toLowerCase().includes(id.toLowerCase())) {
            const removeBtn = card.querySelector(
              'button[aria-label*="Elimina" i], button[ng-click*="deleteTrolleyItem"]'
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
        return { ok: false, error: `Product "${productId}" not found in cart` };
      }

      await page.waitForTimeout(2000);
      await this.persistSession();
      await this.close();
      return { ok: true };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async updateCartItem(productId: string, quantity: number): Promise<{ ok: boolean; error?: string }> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/commerce/nav/supermercato/checkout/trolley`, {
        waitUntil: "networkidle",
        timeout: NAV_TIMEOUT,
      });
      await this.waitForSpaReady(page, { selector: SEL.trolleyItem });

      const updated = await page.evaluate(({ id, qty }) => {
        const cards = document.querySelectorAll("div.esselunga-checkout-trolley-container[ng-repeat]");

        for (const card of cards) {
          const prodDiv = card.querySelector("div.esselunga-checkout-trolley-container-prod[id]");
          const trolleyId = prodDiv?.id ?? "";
          const idParts = trolleyId.split("_");
          const sku = idParts.length >= 2 ? idParts[1] : "";
          const name = card.querySelector("a.esselunga-checkout-trolley-container-prod-desc-label")?.textContent?.trim() ?? "";

          if (sku === id || trolleyId.includes(id) || name.toLowerCase().includes(id.toLowerCase())) {
            const qtySelect = card.querySelector("select") as HTMLSelectElement | null;
            if (qtySelect) {
              qtySelect.value = String(qty);
              qtySelect.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
            return false;
          }
        }
        return false;
      }, { id: productId, qty: quantity });

      if (!updated) {
        await this.close();
        return { ok: false, error: `Product "${productId}" not found in cart or quantity selector not available` };
      }

      await page.waitForTimeout(2000);
      await this.persistSession();
      await this.close();
      return { ok: true };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async clearCart(): Promise<{ ok: boolean; error?: string; removedCount?: number }> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/commerce/nav/supermercato/checkout/trolley`, {
        waitUntil: "networkidle",
        timeout: NAV_TIMEOUT,
      });
      await this.waitForSpaReady(page, { selector: SEL.trolleyItem });

      // Count items and click all delete buttons
      const removedCount = await page.evaluate((): number => {
        const deleteBtns = document.querySelectorAll(
          'button[aria-label*="Elimina" i], button[ng-click*="deleteTrolleyItem"]'
        );
        let count = 0;
        deleteBtns.forEach((btn) => {
          (btn as HTMLButtonElement).click();
          count++;
        });
        return count;
      });

      if (removedCount === 0) {
        await this.close();
        return { ok: true, removedCount: 0 };
      }

      // Wait for removals to process
      await page.waitForTimeout(3000);
      await this.persistSession();
      await this.close();
      return { ok: true, removedCount };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  // ─── Delivery Slots ─────────────────────────────────────────────────────────

  async getDeliverySlots(): Promise<DeliverySlot[]> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/commerce/nav/supermercato/checkout/trolley`, {
        waitUntil: "networkidle",
        timeout: NAV_TIMEOUT,
      });
      await this.waitForSpaReady(page, { selector: SEL.trolleyItem });

      // Check if cart is empty
      const hasItems = await page.$(SEL.trolleyItem);
      if (!hasItems) {
        await this.close();
        throw new Error(
          "Cart is empty. Add items before checking delivery slots.\n" +
          "Run: spesa esselunga cart add <product-url-or-query>"
        );
      }

      // Click the "Data e ora" / "PRENOTA" button to open the slot picker
      try {
        const deliveryBtn = await page.$(SEL.deliveryBtn);
        if (deliveryBtn) {
          await deliveryBtn.click();
          // Wait for the slot picker dialog/panel to load
          await this.waitForSpaReady(page, { selector: SEL.slotGrid });
        }
      } catch {
        // Button might not exist or might fail
      }

      const slots = await page.evaluate((): DeliverySlot[] => {
        const results: DeliverySlot[] = [];

        const grid = document.querySelector("div.esselunga-slots.el-show .esselunga-slots-grid");
        if (!grid) return results;

        const dayHeaders = [...grid.querySelectorAll(".esselunga-slots-grid-time-slot[ng-repeat]")]
          .map(el => el.textContent?.trim() ?? "");

        const rows = grid.querySelectorAll(".esselunga-slots-grid-slots[ng-repeat]");

        rows.forEach((row) => {
          const timeEl = row.querySelector(".esselunga-slots-grid-slots-item-date");
          const timeText = timeEl?.textContent?.trim() ?? "";
          const timeParts = timeText.match(/(\d{1,2}:\d{2})/g);
          const timeRange = timeParts && timeParts.length >= 2 ? `${timeParts[0]}-${timeParts[1]}` : timeText;

          const buttons = row.querySelectorAll("button.slot-button");
          buttons.forEach((btn, dayIdx) => {
            const ariaLabel = btn.getAttribute("aria-label") ?? "";

            const dayMatch = ariaLabel.match(/(lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica)\s+(\d{1,2})/i);
            const date = dayMatch
              ? `${dayMatch[1]} ${dayMatch[2]}`
              : (dayHeaders[dayIdx] ?? "");

            const isAvailable = btn.classList.contains("disponibile");
            const isUnavailable =
              btn.classList.contains("esaurita") ||
              ariaLabel.toLowerCase().includes("non più disponibile") ||
              ariaLabel.toLowerCase().includes("non disponibile");

            results.push({
              id: `${dayIdx}-${timeRange}`,
              date,
              timeRange,
              available: isAvailable && !isUnavailable,
            });
          });
        });

        return results;
      });

      await this.close();
      return slots;
    } catch (e: unknown) {
      await this.close();
      throw e;
    }
  }

  // ─── Place Order ───────────────────────────────────────────────────────────

  async placeOrder(slotId: string): Promise<CliResult<OrderConfirmation>> {
    const session = loadSession(PLATFORM);
    if (!session)
      return { ok: false, error: "Not logged in. Run: spesa esselunga login", errorCode: "LOGIN_REQUIRED" };

    await this.launch(true);
    const page = await this.getPage();

    try {
      // Navigate to trolley
      await page.goto(`${BASE_URL}/commerce/nav/supermercato/checkout/trolley`, {
        waitUntil: "networkidle",
        timeout: NAV_TIMEOUT,
      });
      await this.waitForSpaReady(page, { selector: SEL.trolleyItem });

      // Check cart is not empty
      const hasItems = await page.$(SEL.trolleyItem);
      if (!hasItems) {
        await this.close();
        return { ok: false, error: "Cart is empty. Add items first.", errorCode: "CART_EMPTY" };
      }

      // Get cart info for the confirmation response
      const cartInfo = await page.evaluate((): { total: number; itemCount: number } => {
        const items = document.querySelectorAll("div.esselunga-checkout-trolley-container[ng-repeat]");
        let total = 0;
        let itemCount = 0;
        items.forEach((card) => {
          const totalPriceDiv = card.querySelector(".esselunga-checkout-trolley-container-totalprice");
          const totalText = totalPriceDiv?.textContent ?? "";
          const match = totalText.match(/([\d,]+)\s*€/);
          total += match ? parseFloat(match[1].replace(",", ".")) : 0;
          const qtySelect = card.querySelector("select") as HTMLSelectElement | null;
          itemCount += qtySelect ? (parseInt(qtySelect.value) || 1) : 1;
        });
        return { total, itemCount };
      });

      // Open slot picker
      const deliveryBtn = await page.$(SEL.deliveryBtn);
      if (deliveryBtn) {
        await deliveryBtn.click();
        await this.waitForSpaReady(page, { selector: SEL.slotGrid });
      }

      // Parse slot ID: "dayIdx-startTime-endTime" e.g. "0-07:00-08:00"
      const [dayIdxStr, ...timeRangeParts] = slotId.split("-");
      const dayIdx = parseInt(dayIdxStr, 10);
      const timeRange = timeRangeParts.join("-");

      // Click the matching slot button
      const slotClicked = await page.evaluate(({ dayIdx, timeRange }) => {
        const grid = document.querySelector("div.esselunga-slots.el-show .esselunga-slots-grid");
        if (!grid) return { clicked: false, error: "Slot grid not found" };

        const rows = grid.querySelectorAll(".esselunga-slots-grid-slots[ng-repeat]");
        for (const row of rows) {
          const timeEl = row.querySelector(".esselunga-slots-grid-slots-item-date");
          const timeText = timeEl?.textContent?.trim() ?? "";
          const timeParts = timeText.match(/(\d{1,2}:\d{2})/g);
          const rowTimeRange = timeParts && timeParts.length >= 2 ? `${timeParts[0]}-${timeParts[1]}` : "";

          if (rowTimeRange === timeRange) {
            const buttons = row.querySelectorAll("button.slot-button");
            const btn = buttons[dayIdx] as HTMLButtonElement | undefined;
            if (btn) {
              if (btn.classList.contains("disponibile")) {
                btn.click();
                return { clicked: true };
              }
              return { clicked: false, error: "Slot is not available" };
            }
          }
        }
        return { clicked: false, error: "Slot not found" };
      }, { dayIdx, timeRange });

      if (!slotClicked.clicked) {
        await this.close();
        return { ok: false, error: slotClicked.error ?? "Failed to select slot", errorCode: "SLOT_UNAVAILABLE" };
      }

      await page.waitForTimeout(3000);

      // Click confirm/proceed button
      const confirmBtn = await page.$(SEL.confirmBtn);
      if (confirmBtn) {
        await confirmBtn.click();
        await page.waitForTimeout(5000);
      }

      // Check for success indicators
      const pageText = await page.textContent("body");
      const isSuccess = pageText?.includes("confermato") ||
                        pageText?.includes("completato") ||
                        pageText?.includes("ricevuto");

      // Try to extract order ID from the page
      const orderIdMatch = pageText?.match(/(?:ordine|order)\s*[#:\s]*(\d{6,})/i);

      await this.persistSession();
      await this.close();

      // Get slot info for the response
      const dayHeaders = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
      const slotInfo: DeliverySlot = {
        id: slotId,
        date: dayHeaders[dayIdx] ?? `Day ${dayIdx}`,
        timeRange,
        available: true,
      };

      return {
        ok: true,
        data: {
          orderId: orderIdMatch?.[1],
          slot: slotInfo,
          total: cartInfo.total,
          itemCount: cartInfo.itemCount,
        },
      };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e), errorCode: "ORDER_FAILED" };
    }
  }

  // ─── Reorder ───────────────────────────────────────────────────────────────

  async reorder(orderId?: string): Promise<CliResult<{
    sourceOrderId: string;
    results: { name: string; ok: boolean; error?: string }[];
    added: number;
    total: number;
  }>> {
    const session = loadSession(PLATFORM);
    if (!session)
      return { ok: false, error: "Not logged in. Run: spesa esselunga login", errorCode: "LOGIN_REQUIRED" };

    await this.launch(true);
    const page = await this.getPage();

    try {
      // Navigate to past orders
      await page.goto(`${BASE_URL}/commerce/nav/supermercato/ordini/precedenti`, {
        waitUntil: "commit",
        timeout: NAV_TIMEOUT,
      });
      await this.waitForSpaReady(page);

      // Check if Esselunga has a native "Riordina" (reorder) button
      // Many grocery sites have this feature built in
      const reorderBtn = await page.$('button:has-text("Riordina"), button:has-text("Ordina di nuovo"), a:has-text("Riordina")');

      if (reorderBtn) {
        // Use native reorder if available
        await reorderBtn.click();
        await page.waitForTimeout(5000);
        await this.persistSession();
        await this.close();

        return {
          ok: true,
          data: {
            sourceOrderId: orderId ?? "last",
            results: [{ name: "All items (native reorder)", ok: true }],
            added: 1,
            total: 1,
          },
        };
      }

      // Fall back: scrape order items and add them one by one
      const orderItems = await page.evaluate((targetId?: string) => {
        const bodyText = document.body.textContent ?? "";
        if (bodyText.includes("Non è presente nessun ordine")) return [];

        const orderEls = document.querySelectorAll(
          '[ng-repeat*="order"], [ng-repeat*="ordin"], [ng-repeat*="spesa"], ' +
          '[class*="order-item"], [class*="ordine-item"]'
        );

        const items: { name: string; id: string }[] = [];
        for (const el of orderEls) {
          const text = el.textContent?.trim() ?? "";
          const nameLink = el.querySelector("a[aria-label], a[href*='prodotto']");
          const name = nameLink?.textContent?.trim() ?? text.slice(0, 60);
          const href = nameLink?.getAttribute("href") ?? "";
          if (name && href) {
            items.push({ name, id: href });
          }
        }
        return items;
      }, orderId);

      if (orderItems.length === 0) {
        await this.close();
        return { ok: false, error: "No order items found to reorder", errorCode: "PRODUCT_NOT_FOUND" };
      }

      // Add each item to cart
      const results: { name: string; ok: boolean; error?: string }[] = [];
      for (const item of orderItems) {
        try {
          const url = item.id.startsWith("http") ? item.id : `${BASE_URL}${item.id}`;
          await page.goto(url, { waitUntil: "commit", timeout: 30000 });
          await this.waitForSpaReady(page, { selector: SEL.addToCartButton });

          const addBtn = await page.$(SEL.addToCartButton);
          if (addBtn) {
            await addBtn.click();
            await page.waitForTimeout(2000);
            results.push({ name: item.name, ok: true });
          } else {
            results.push({ name: item.name, ok: false, error: "Add button not found" });
          }
        } catch (e: unknown) {
          results.push({ name: item.name, ok: false, error: String(e) });
        }
      }

      await this.persistSession();
      await this.close();

      const added = results.filter((r) => r.ok).length;
      return {
        ok: true,
        data: {
          sourceOrderId: orderId ?? "last",
          results,
          added,
          total: results.length,
        },
      };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e), errorCode: "UNKNOWN" };
    }
  }

  // ─── Orders ─────────────────────────────────────────────────────────────────

  async getOrders(limit = 10): Promise<Order[]> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/commerce/nav/supermercato/ordini/precedenti`, {
        waitUntil: "commit",
        timeout: NAV_TIMEOUT,
      });
      await this.waitForSpaReady(page);

      const orders = await page.evaluate((): Order[] => {
        const results: Order[] = [];

        const bodyText = document.body.textContent ?? "";
        if (bodyText.includes("Non è presente nessun ordine") || bodyText.includes("nessun ordine")) {
          return results;
        }

        const orderEls = document.querySelectorAll(
          '[ng-repeat*="order"], [ng-repeat*="ordin"], [ng-repeat*="spesa"], ' +
          '[class*="order-item"], [class*="ordine-item"], [class*="ordine-riga"], ' +
          'tr[class*="ordine"], div[class*="ordine"]'
        );

        orderEls.forEach((el) => {
          const text = el.textContent?.trim() ?? "";
          if (!text || text.length > 500) return;

          const idMatch = text.match(/(?:ordine|order|#)\s*[:\s]*(\d{6,})/i) ||
                           text.match(/(\d{8,})/);

          const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);

          const totalMatch = text.match(/(?:totale|total)\s*[:\s]*([\d,\.]+)\s*€/i) ||
                             text.match(/([\d,\.]+)\s*€/);

          const statusKeywords = ["consegnato", "in preparazione", "in consegna", "annullato", "confermato", "completato"];
          const status = statusKeywords.find(s => text.toLowerCase().includes(s)) ?? "unknown";

          if (idMatch || dateMatch) {
            results.push({
              id: idMatch?.[1] ?? String(results.length + 1),
              date: dateMatch?.[1] ?? "",
              status,
              total: totalMatch ? parseFloat(totalMatch[1].replace(",", ".")) : 0,
            });
          }
        });

        return results;
      });

      await this.close();
      return orders.slice(0, limit);
    } catch (e: unknown) {
      await this.close();
      throw e;
    }
  }
}
