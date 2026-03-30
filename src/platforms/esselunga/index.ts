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

  // Cart page
  cartItemSelector: '[role="option"], [class*="cart-item"], [class*="lineItem"]',

  // Delivery slots (from community reverse-engineering)
  slotAvailable: '.disponibile, [class*="slot"][class*="available"]',
  slotInput: 'input[name="quality"]',
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

  /** Wait for the Angular SPA to finish booting (loading spinner gone) */
  private async waitForSPA(page: Page): Promise<void> {
    // Wait for the search bar to appear — it's one of the last things to render
    try {
      await page.waitForSelector(SEL.searchInput, { timeout: SPA_BOOT_WAIT });
    } catch {
      // Fallback: just wait a fixed amount
      await page.waitForTimeout(5000);
    }
  }

  // ─── Auth ───────────────────────────────────────────────────────────────────

  async login(
    username: string,
    password: string,
    opts: { headless?: boolean } = {}
  ): Promise<{ ok: boolean; error?: string; mfaRequired?: boolean }> {
    try {
      // Headed mode by default so user can handle MFA
      await this.launch(opts.headless ?? false);
      const page = await this.getPage();

      // 1. Navigate to homepage — the SPA needs time to boot
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await this.waitForSPA(page);

      // 2. Click "Accedi" button — redirects to account.esselunga.it
      try {
        const loginBtn = await page.waitForSelector(SEL.loginButton, { timeout: 8000 });
        await loginBtn.click();
      } catch {
        // Maybe already on login page or there's a different flow
      }

      // 3. Wait for the login form on account.esselunga.it
      //    URL pattern: account.esselunga.it/area-utenti/applicationCheck?appName=spesaOnLine&...
      try {
        await page.waitForURL(/account\.esselunga\.it/, { timeout: 10000 });
      } catch {
        // Try navigating directly
        await page.goto(
          `https://${AUTH_DOMAIN}/area-utenti/applicationCheck?appName=spesaOnLine&daru=${encodeURIComponent(BASE_URL + ":443/commerce/login/spesaonline/store/home?")}&loginType=light`,
          { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }
        );
      }

      // 4. Fill the login form
      //    Real form has: textbox "E-mail", textbox "password", button "ACCEDI"
      const emailField = await page.waitForSelector(SEL.loginEmail, { timeout: 8000 });
      const passField = await page.waitForSelector(SEL.loginPassword, { timeout: 3000 });

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
      try {
        await page.waitForURL(/spesaonline\.esselunga\.it/, { timeout: 15000 });
        // Success — back on the store
        await page.waitForTimeout(2000);
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
      await this.launch(true);
      const page = await this.getPage();
      await page.goto(HOME_URL, {
        waitUntil: "domcontentloaded",
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
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await page.waitForTimeout(SPA_BOOT_WAIT);

    const products: Product[] = [];

    // 1. Try intercepted API responses first (most reliable)
    for (const resp of apiResponses) {
      const extracted = this.extractProductsFromApiResponse(resp.data);
      products.push(...extracted);
    }

    // 2. Fall back to DOM scraping from ARIA tree
    //    Product cards live in [role="listbox"] > [role="option"] with structured content
    if (products.length === 0) {
      const domProducts = await page.evaluate(
        (selectors): Product[] => {
          const results: Product[] = [];
          const options = document.querySelectorAll(selectors.productOption);

          options.forEach((option) => {
            const label = option.getAttribute("aria-label") || option.textContent || "";

            // "Aggiungi al carrello" buttons contain the full product name
            const addBtn = option.querySelector(
              'button[aria-label*="Aggiungi al carrello"]'
            ) as HTMLButtonElement | null;

            if (!addBtn) return;

            // Extract product name from the button's aria-label
            // Pattern: "Aggiungi al carrello Barilla Pasta Spaghetti n.5 500 g"
            const btnLabel = addBtn.getAttribute("aria-label") ?? "";
            const name = btnLabel.replace(/^Aggiungi al carrello\s*/i, "").trim();
            if (!name) return;

            // Get product detail link
            const links = option.querySelectorAll("a");
            let productUrl = "";
            for (const link of links) {
              if (link.href && link.href.includes("product")) {
                productUrl = link.href;
                break;
              }
              if (link.href && !productUrl) productUrl = link.href;
            }

            // Extract price from text content
            const text = option.textContent ?? "";
            // Look for price pattern: €X.XX or X,XX €
            const priceMatch = text.match(/€\s*([\d,.]+)|([\d,.]+)\s*€/);
            let price = 0;
            if (priceMatch) {
              const priceStr = (priceMatch[1] || priceMatch[2] || "0").replace(",", ".");
              price = parseFloat(priceStr) || 0;
            }

            const id = productUrl
              ? productUrl.split("/").pop() ?? ""
              : Math.random().toString(36).slice(2);

            // Get image
            const img = option.querySelector("img");
            const imageUrl = img?.src;

            results.push({
              id,
              name,
              price,
              url: productUrl || window.location.href,
              imageUrl,
              available: true,
            });
          });

          return results;
        },
        { productOption: SEL.productOption }
      );
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

  // ─── Cart ───────────────────────────────────────────────────────────────────

  async addToCart(
    productUrlOrId: string,
    quantity = 1
  ): Promise<{ ok: boolean; error?: string }> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      // If it's a full URL, navigate to it. Otherwise search for the product.
      if (productUrlOrId.startsWith("http")) {
        await page.goto(productUrlOrId, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      } else {
        // Navigate to search and find the product
        const searchUrl = `${BASE_URL}/commerce/nav/supermercato/store/ricerca/${encodeURIComponent(productUrlOrId)}`;
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      }

      await page.waitForTimeout(SPA_BOOT_WAIT);

      // Set quantity using the combobox/select if > 1
      if (quantity > 1) {
        try {
          const qtySelect = await page.$(SEL.productQtySelect);
          if (qtySelect) {
            await qtySelect.selectOption(String(quantity));
          }
        } catch {
          // Quantity setting failed — will add 1 and repeat
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

    await page.goto(`${BASE_URL}/commerce/nav/supermercato/store/carrello`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForTimeout(SPA_BOOT_WAIT);

    const cart = await page.evaluate((): Cart => {
      const items: CartItem[] = [];

      // Cart items appear as list/option elements or distinct cart-item containers
      const cards = document.querySelectorAll(
        '[class*="cart-item"], [class*="CartItem"], [class*="lineItem"], [role="listitem"]'
      );

      cards.forEach((card) => {
        const nameEl =
          card.querySelector('[class*="name"], [class*="title"], h3, h4') ||
          card.querySelector("a");
        const priceEl = card.querySelector('[class*="price"], [class*="prezzo"]');
        const qtyEl = card.querySelector(
          'select[aria-label*="Quantit" i], input[type="number"], [class*="quantity"]'
        );
        const linkEl = card.querySelector("a");

        const name = nameEl?.textContent?.trim() ?? "";
        if (!name) return;

        const priceText = priceEl?.textContent?.trim() ?? "0";
        const priceMatch = priceText.match(/[\d,\.]+/);
        const price = priceMatch ? parseFloat(priceMatch[0].replace(",", ".")) : 0;

        const qty =
          parseInt(
            (qtyEl as HTMLSelectElement)?.value ??
              (qtyEl as HTMLInputElement)?.value ??
              "1"
          ) || 1;

        const url = (linkEl as HTMLAnchorElement)?.href ?? "";
        const id = url ? url.split("/").pop() ?? "" : Math.random().toString(36).slice(2);

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
  }

  async removeFromCart(productId: string): Promise<{ ok: boolean; error?: string }> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    try {
      await page.goto(`${BASE_URL}/commerce/nav/supermercato/store/carrello`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await page.waitForTimeout(SPA_BOOT_WAIT);

      const removed = await page.evaluate((id: string): boolean => {
        const cards = document.querySelectorAll(
          '[class*="cart-item"], [class*="CartItem"], [class*="lineItem"], [role="listitem"]'
        );
        for (const card of cards) {
          const link = card.querySelector("a");
          const text = card.textContent ?? "";
          if (link?.href.includes(id) || text.includes(id)) {
            const removeBtn = card.querySelector(
              'button[aria-label*="rimuovi" i], button[aria-label*="remove" i], button[aria-label*="elimina" i], button[class*="remove"]'
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

    // Slots are shown during checkout flow, starting from the cart
    await page.goto(`${BASE_URL}/commerce/nav/supermercato/store/carrello`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForTimeout(SPA_BOOT_WAIT);

    // Look for checkout/slots widget
    // Known from community: slots use class "disponibile" on input[name="quality"]
    const slots = await page.evaluate((): DeliverySlot[] => {
      const results: DeliverySlot[] = [];
      const slotEls = document.querySelectorAll(
        'input[name="quality"], [class*="slot"], [class*="fascia"], [class*="time-slot"]'
      );

      slotEls.forEach((el, i) => {
        const isAvailable =
          el.classList.contains("disponibile") ||
          (el.classList.contains("slot") && !el.classList.contains("esaurito")) ||
          !(el as HTMLInputElement).disabled;

        const label =
          el.closest("label")?.textContent?.trim() ||
          el.getAttribute("aria-label") ||
          el.parentElement?.textContent?.trim() ||
          "";

        const dateMatch = label.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]?\d{0,4}/);
        const timeMatch = label.match(/\d{1,2}[:\.]\d{2}\s*[-–]\s*\d{1,2}[:\.]\d{2}/);

        results.push({
          id: (el as HTMLInputElement).value || String(i),
          date: dateMatch?.[0] ?? "",
          timeRange: timeMatch?.[0] ?? label.slice(0, 40),
          available: isAvailable,
        });
      });

      return results;
    });

    await this.close();
    return slots;
  }

  // ─── Orders ─────────────────────────────────────────────────────────────────

  async getOrders(limit = 10): Promise<Order[]> {
    const session = loadSession(PLATFORM);
    if (!session)
      throw new Error("Not logged in. Run: spesa esselunga login");

    await this.launch(true);
    const page = await this.getPage();

    await page.goto(`${BASE_URL}/commerce/nav/supermercato/store/ordini`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForTimeout(SPA_BOOT_WAIT);

    const orders = await page.evaluate((): Order[] => {
      const results: Order[] = [];
      const orderEls = document.querySelectorAll(
        '[class*="order-item"], [class*="OrderItem"], [class*="ordine"], [role="listitem"]'
      );

      orderEls.forEach((el) => {
        const idEl = el.querySelector('[class*="order-id"], [class*="numero"]');
        const dateEl = el.querySelector('[class*="date"], [class*="data"]');
        const statusEl = el.querySelector('[class*="status"], [class*="stato"]');
        const totalEl = el.querySelector('[class*="total"], [class*="totale"]');

        const totalText = totalEl?.textContent?.trim() ?? "0";
        const totalMatch = totalText.match(/[\d,\.]+/);

        results.push({
          id:
            idEl?.textContent?.trim() ||
            el.getAttribute("data-order-id") ||
            String(results.length + 1),
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
