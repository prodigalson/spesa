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
  CookieData,
} from "../../types.ts";

const PLATFORM = "esselunga";
const BASE_URL = "https://spesaonline.esselunga.it";
const HOME_PATH = "/commerce/nav/supermercato/store/home";
const HOME_URL = `${BASE_URL}${HOME_PATH}`;

// The login flow starts at the homepage and redirects through account.esselunga.it
const AUTH_DOMAIN = "account.esselunga.it";

// Esselunga's Angular SPA is slow to boot — needs generous timeouts
const NAV_TIMEOUT = 45000;
const SPA_BOOT_WAIT = 8000;
const SESSION_TTL_HOURS = 12;

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
  // Products appear as [option] elements in [listbox] carousels with "Aggiungi al carrello" buttons
  productOption: '[role="option"]',
  addToCartButton: 'button[aria-label*="Aggiungi al carrello" i]',
  productDetailLink: 'a[aria-label*="dettaglio" i], a[href*="product"]',
  productQtySelect: 'select[aria-label*="Quantit" i], [role="combobox"][aria-label*="Quantit" i]',

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

// ─── Client ─────────────────────────────────────────────────────────────────

export class EsselungaClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  private async launch(headless = true): Promise<void> {
    // Use WebKit (Safari engine) instead of Chromium.
    // Esselunga's WAF aggressively blocks automated browsers and rate-limits IPs.
    // WebKit with a real Safari user-agent is the least detectable option.
    this.browser = await webkit.launch({
      headless,
    });
    this.context = await this.browser.newContext({
      // Real Safari UA — matches what macOS Safari actually sends
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
      // Check connectivity before launching a browser
      const conn = await EsselungaClient.checkConnectivity();
      if (!conn.reachable) {
        return { ok: false, error: conn.error ?? "Cannot reach Esselunga" };
      }

      // Headed mode by default so user can handle MFA
      await this.launch(opts.headless ?? false);
      const page = await this.getPage();

      // Go directly to the login page on account.esselunga.it
      // This skips the slow Angular SPA homepage entirely.
      // The daru param tells Esselunga where to redirect after login.
      const loginUrl =
        `https://${AUTH_DOMAIN}/area-utenti/applicationCheck` +
        `?appName=spesaOnLine` +
        `&daru=${encodeURIComponent(BASE_URL + ":443/commerce/login/spesaonline/store/home?")}` +
        `&loginType=light`;

      // Don't wait for full page load — just start navigating, then wait for
      // the form fields to appear. Esselunga's pages hang on domcontentloaded.
      await page.goto(loginUrl, { waitUntil: "commit", timeout: 30000 });

      // Fill the login form
      //    Real form has: textbox "E-mail", textbox "password", button "ACCEDI"
      //    Wait generously for the form to render (up to 30s)
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

      // 5. Click ACCEDI
      const submitBtn = await page.waitForSelector(SEL.loginSubmit, { timeout: 3000 });
      await submitBtn.click();

      // 6. Wait for redirect back to spesaonline.esselunga.it or MFA
      //    The store SPA is slow, so give it up to 60s for the redirect
      try {
        await page.waitForURL(/spesaonline\.esselunga\.it/, { timeout: 60000 });
        // Success — back on the store. Don't wait for SPA to fully boot.
        await page.waitForTimeout(3000);
        await this.persistSession(username);
        await this.close();
        return { ok: true };
      } catch {
        // Check if we're on an MFA/OTP page
        const currentUrl = page.url();

        if (currentUrl.includes(AUTH_DOMAIN)) {
          // Still on account.esselunga.it — likely MFA or error
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

            // Check if we're now on the store
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

          // Check for error message
          const errorEl = await page.$('[role="alert"], [class*="error"], [class*="errore"]');
          const errorText = errorEl ? await errorEl.textContent() : null;
          await this.close();
          return {
            ok: false,
            error: errorText?.trim() || "Login failed. Check your credentials.",
          };
        }

        // Unknown state
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

    // Quick validation — load cookies and check if we get redirected to login
    try {
      // Check connectivity before launching browser (same as login)
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
      await page.waitForTimeout(5000);
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

    // Navigate directly to the search results URL
    // Pattern discovered: /commerce/nav/supermercato/store/ricerca/{query}
    const searchUrl = `${BASE_URL}/commerce/nav/supermercato/store/ricerca/${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: "commit", timeout: 30000 });
    await page.waitForTimeout(SPA_BOOT_WAIT);

    const products: Product[] = [];

    // 1. Try intercepted API responses first (most reliable)
    for (const resp of apiResponses) {
      const extracted = this.extractProductsFromApiResponse(resp.data);
      products.push(...extracted);
    }

    // 2. Scrape from the real DOM structure
    //    Esselunga uses AngularJS: div.product[id] > a[aria-label] + img + price + button
    if (products.length === 0) {
      const domProducts = await page.evaluate((): Product[] => {
        const results: Product[] = [];
        // Product cards are div.product with a numeric ID
        const cards = document.querySelectorAll("div.product[id]");

        cards.forEach((card) => {
          // Product name from the link's aria-label or img alt
          const link = card.querySelector("a[aria-label]");
          const img = card.querySelector("img[alt]");
          const name = link?.getAttribute("aria-label") || img?.getAttribute("alt") || "";
          if (!name) return;

          // Product URL: /commerce/nav/supermercato/store/prodotto/{sku}/{slug}
          const href = link?.getAttribute("href") ?? "";
          const fullUrl = href.startsWith("http") ? href : `https://spesaonline.esselunga.it${href}`;

          // SKU from the URL path: .../prodotto/114052/barilla-pasta-...
          const skuMatch = href.match(/\/prodotto\/(\d+)\//);
          const sku = skuMatch?.[1] ?? card.id;

          // Price: look for "Prezzo attuale X,XX€" in the card text
          const cardText = card.textContent ?? "";
          const currentPriceMatch = cardText.match(/Prezzo attuale\s*([\d,]+)\s*€/);
          const fallbackPriceMatch = cardText.match(/([\d,]+)\s*€/);
          const priceStr = currentPriceMatch?.[1] ?? fallbackPriceMatch?.[1] ?? "0";
          const price = parseFloat(priceStr.replace(",", ".")) || 0;

          // Price per unit (e.g. "1,85 € / kg")
          const perUnitMatch = cardText.match(/([\d,]+)\s*€\s*\/\s*(\w+)/);
          const pricePerUnit = perUnitMatch ? `${perUnitMatch[1]} €/${perUnitMatch[2]}` : undefined;

          // Image URL
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
        // Search returned no results — possibly no delivery address set
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

      // If it's a full URL, navigate to it. Otherwise search for the product.
      if (productUrlOrId.startsWith("http")) {
        await page.goto(productUrlOrId, { waitUntil: "commit", timeout: 30000 });
      } else {
        // Navigate to search and find the product
        const searchUrl = `${BASE_URL}/commerce/nav/supermercato/store/ricerca/${encodeURIComponent(productUrlOrId)}`;
        await page.goto(searchUrl, { waitUntil: "commit", timeout: 30000 });
      }

      await page.waitForTimeout(SPA_BOOT_WAIT);

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

      // Save cookies (cart state is server-side)
      await this.persistSession();
      await this.close();
      return { ok: true };
    } catch (e: unknown) {
      await this.close();
      return { ok: false, error: String(e) };
    }
  }

  async getCart(): Promise<Cart> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
    // The real cart/trolley page URL (discovered from navbar's "Carrello" link)
    await page.goto(`${BASE_URL}/commerce/nav/supermercato/checkout/trolley`, {
      waitUntil: "networkidle",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForTimeout(SPA_BOOT_WAIT);

    const cart = await page.evaluate((): Cart => {
      const items: CartItem[] = [];

      // Trolley page uses AngularJS with ng-repeat="receiptItem in trolleyCtrl.receiptItems"
      // Each item is a div.esselunga-checkout-trolley-container with a child
      // div.esselunga-checkout-trolley-container-prod[id="trolley_{sku}_{n}"]
      const cards = document.querySelectorAll("div.esselunga-checkout-trolley-container[ng-repeat]");

      cards.forEach((card) => {
        // Product name from the link
        const nameLink = card.querySelector("a.esselunga-checkout-trolley-container-prod-desc-label");
        const name = nameLink?.textContent?.trim() ?? "";
        if (!name) return;

        // SKU from the prod container's id: "trolley_{sku}_{n}"
        const prodDiv = card.querySelector("div.esselunga-checkout-trolley-container-prod[id]");
        const trolleyId = prodDiv?.id ?? "";
        const idParts = trolleyId.split("_");
        const sku = idParts.length >= 2 ? idParts[1] : trolleyId;

        // Unit price: look for "Prezzo Attuale X,XX€" in the unit price section
        const unitPriceDiv = card.querySelector(".esselunga-checkout-trolley-container-prod-unitprice");
        const unitText = unitPriceDiv?.textContent ?? "";
        const currentPriceMatch = unitText.match(/Prezzo Attuale\s*([\d,]+)\s*€/i);
        const fallbackPriceMatch = unitText.match(/([\d,]+)\s*€/);
        const priceStr = currentPriceMatch?.[1] ?? fallbackPriceMatch?.[1] ?? "0";
        const price = parseFloat(priceStr.replace(",", ".")) || 0;

        // Total price for this line (quantity × unit price)
        const totalPriceDiv = card.querySelector(".esselunga-checkout-trolley-container-totalprice");
        const totalText = totalPriceDiv?.textContent ?? "";
        const totalPriceMatch = totalText.match(/Prezzo Attuale\s*([\d,]+)\s*€/i);
        const totalFallback = totalText.match(/([\d,]+)\s*€/);
        const subtotal = parseFloat((totalPriceMatch?.[1] ?? totalFallback?.[1] ?? "0").replace(",", ".")) || 0;

        // Quantity: derive from subtotal / price, or look for select value
        const qtySelect = card.querySelector('select');
        const qty = qtySelect
          ? (parseInt((qtySelect as HTMLSelectElement).value) || 1)
          : (price > 0 ? Math.round(subtotal / price) : 1);

        // Price per unit (e.g. "1,58 € / kg")
        const descDiv = card.querySelector(".esselunga-checkout-trolley-container-prod-desc");
        const descText = descDiv?.textContent ?? "";
        const perUnitMatch = descText.match(/([\d,]+)\s*€\s*\/\s*(\w+)/);
        const pricePerUnit = perUnitMatch ? `${perUnitMatch[1]} €/${perUnitMatch[2]}` : undefined;

        // Image
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

      // Total from summary section
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
      await page.waitForTimeout(SPA_BOOT_WAIT);

      const removed = await page.evaluate((id: string): boolean => {
        // Trolley items: div.esselunga-checkout-trolley-container[ng-repeat]
        // Each has a child div.esselunga-checkout-trolley-container-prod[id="trolley_{sku}_{n}"]
        const cards = document.querySelectorAll("div.esselunga-checkout-trolley-container[ng-repeat]");

        for (const card of cards) {
          const prodDiv = card.querySelector("div.esselunga-checkout-trolley-container-prod[id]");
          const trolleyId = prodDiv?.id ?? "";
          // Extract SKU from "trolley_{sku}_{n}"
          const idParts = trolleyId.split("_");
          const sku = idParts.length >= 2 ? idParts[1] : "";
          const name = card.querySelector("a.esselunga-checkout-trolley-container-prod-desc-label")?.textContent?.trim() ?? "";

          if (sku === id || trolleyId.includes(id) || name.toLowerCase().includes(id.toLowerCase())) {
            // Delete button: aria-label="Elimina il prodotto dal carrello"
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

  // ─── Delivery Slots ─────────────────────────────────────────────────────────

  async getDeliverySlots(): Promise<DeliverySlot[]> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
    // Slots are accessed from the trolley page by clicking "Data e ora" / "PRENOTA"
    // which triggers ng-click="$ctrl.onDeliveryClick()" and opens a slot picker dialog.
    // This requires items in the cart.
    await page.goto(`${BASE_URL}/commerce/nav/supermercato/checkout/trolley`, {
      waitUntil: "networkidle",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForTimeout(SPA_BOOT_WAIT);

    // Check if cart is empty — slots won't be available
    const hasItems = await page.$("div.esselunga-checkout-trolley-container[ng-repeat]");
    if (!hasItems) {
      await this.close();
      throw new Error(
        "Cart is empty. Add items before checking delivery slots.\n" +
        "Run: spesa esselunga cart add <product-url-or-query>"
      );
    }

    // Click the "Data e ora" / "PRENOTA" button to open the slot picker
    try {
      const deliveryBtn = await page.$('button[ng-click*="onDeliveryClick"]');
      if (deliveryBtn) {
        await deliveryBtn.click();
        // Wait for the slot picker dialog/panel to load
        await page.waitForTimeout(5000);
      }
    } catch {
      // Button might not exist or might fail
    }

    // Scrape slots from the grid that appears after clicking "Data e ora"
    // The grid has:
    //   - Days: div.esselunga-slots-grid-time-slot[ng-repeat="day in slotCtrl.displayableDays"]
    //   - Rows: div.esselunga-slots-grid-slots[ng-repeat="range in slotCtrl.timeRanges"]
    //   - Cells: button.slot-button inside each row, one per day
    //     - class "disponibile" = available, "esaurita" = sold out, "prenotata" = booked
    //     - aria-label has full description: "Fascia oraria dalle HH:MM alle HH:MM di {day} {date} ..."
    const slots = await page.evaluate((): DeliverySlot[] => {
      const results: DeliverySlot[] = [];

      // Find the visible slot grid (el-show)
      const grid = document.querySelector("div.esselunga-slots.el-show .esselunga-slots-grid");
      if (!grid) return results;

      // Get day headers: "G02", "V03", "S04" etc.
      const dayHeaders = [...grid.querySelectorAll(".esselunga-slots-grid-time-slot[ng-repeat]")]
        .map(el => el.textContent?.trim() ?? "");

      // Iterate over each time-range row
      const rows = grid.querySelectorAll(".esselunga-slots-grid-slots[ng-repeat]");

      rows.forEach((row) => {
        // Time range from the date cell: "07:00\n08:00"
        const timeEl = row.querySelector(".esselunga-slots-grid-slots-item-date");
        const timeText = timeEl?.textContent?.trim() ?? "";
        // Parse "07:0008:00" or "07:00\n08:00" into "07:00-08:00"
        const timeParts = timeText.match(/(\d{1,2}:\d{2})/g);
        const timeRange = timeParts && timeParts.length >= 2 ? `${timeParts[0]}-${timeParts[1]}` : timeText;

        // Each slot button corresponds to a day column
        const buttons = row.querySelectorAll("button.slot-button");
        buttons.forEach((btn, dayIdx) => {
          const ariaLabel = btn.getAttribute("aria-label") ?? "";

          // Parse day info from aria-label for full name, or fall back to header
          const dayMatch = ariaLabel.match(/(lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica)\s+(\d{1,2})/i);
          const date = dayMatch
            ? `${dayMatch[1]} ${dayMatch[2]}`
            : (dayHeaders[dayIdx] ?? "");

          // Availability from CSS class (most reliable)
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

  // ─── Orders ─────────────────────────────────────────────────────────────────

  async getOrders(limit = 10): Promise<Order[]> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
    // Real orders URL: /ordini/precedenti ("I tuoi ordini")
    await page.goto(`${BASE_URL}/commerce/nav/supermercato/ordini/precedenti`, {
      waitUntil: "commit",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForTimeout(SPA_BOOT_WAIT);

    const orders = await page.evaluate((): Order[] => {
      const results: Order[] = [];

      // Check for "Non è presente nessun ordine" (no orders)
      const bodyText = document.body.textContent ?? "";
      if (bodyText.includes("Non è presente nessun ordine") || bodyText.includes("nessun ordine")) {
        return results;
      }

      // Orders may use ng-repeat with order items
      // Try multiple selector patterns for order rows
      const orderEls = document.querySelectorAll(
        '[ng-repeat*="order"], [ng-repeat*="ordin"], [ng-repeat*="spesa"], ' +
        '[class*="order-item"], [class*="ordine-item"], [class*="ordine-riga"], ' +
        'tr[class*="ordine"], div[class*="ordine"]'
      );

      orderEls.forEach((el) => {
        const text = el.textContent?.trim() ?? "";
        if (!text || text.length > 500) return;

        // Extract order ID (long numeric)
        const idMatch = text.match(/(?:ordine|order|#)\s*[:\s]*(\d{6,})/i) ||
                         text.match(/(\d{8,})/);

        // Extract date (DD/MM/YYYY)
        const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);

        // Extract total price
        const totalMatch = text.match(/(?:totale|total)\s*[:\s]*([\d,\.]+)\s*€/i) ||
                           text.match(/([\d,\.]+)\s*€/);

        // Extract status keywords
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
