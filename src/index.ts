#!/usr/bin/env bun
import { Command } from "commander";
import { setJsonMode, isJsonMode, setYesMode, isYesMode, output, ok, err, printTable } from "./output.ts";
import { EsselungaClient } from "./platforms/esselunga/index.ts";
import { hasSession } from "./session.ts";
import { VERSION } from "./version.ts";

const program = new Command();

program
  .name("spesa")
  .description("CLI for ordering groceries online in Italy")
  .version(VERSION)
  .option("--json", "Output as JSON (for agent use)")
  .option("-y, --yes", "Non-interactive mode — never prompt for confirmation")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.json) setJsonMode(true);
    if (opts.yes) setYesMode(true);
  });

// Helper: check session or exit
function requireSession(): boolean {
  if (!hasSession("esselunga")) {
    output(err("Not logged in. Run: spesa esselunga login", "LOGIN_REQUIRED"));
    process.exit(1);
    return false;
  }
  return true;
}

// Helper: parse positive integer option
function parsePositiveInt(val: string, name: string): number | null {
  const n = parseInt(val, 10);
  if (isNaN(n) || n < 1) {
    output(err(`Invalid --${name} value. Must be a positive integer.`, "INVALID_INPUT"));
    process.exit(1);
    return null;
  }
  return n;
}

// ─── esselunga ───────────────────────────────────────────────────────────────

const esselunga = program
  .command("esselunga")
  .alias("e")
  .description("Interact with Esselunga online grocery");

esselunga
  .command("login")
  .description("Authenticate with Esselunga (opens browser for MFA if needed)")
  .requiredOption("-u, --username <email>", "Esselunga account email")
  .option("-p, --password <password>", "Esselunga password (or set SPESA_PASSWORD env var)")
  .option("--headless", "Run browser in headless mode (MFA won't work)")
  .action(async (opts) => {
    const password = opts.password || process.env.SPESA_PASSWORD;
    if (!password) {
      output(err("Password required. Use -p flag or set SPESA_PASSWORD env var.", "INVALID_INPUT"));
      process.exit(1);
      return;
    }
    const client = new EsselungaClient();
    if (!isJsonMode()) {
      console.log("Logging in to Esselunga...");
    }
    const result = await client.login(opts.username, password, {
      headless: opts.headless ?? false,
    });
    if (result.ok) {
      output(ok(null, "Logged in successfully. Session saved."));
    } else {
      const code = result.mfaRequired ? "MFA_REQUIRED" as const : "UNKNOWN" as const;
      output(err(result.error ?? "Login failed", code));
      process.exit(1);
    }
  });

esselunga
  .command("logout")
  .description("Clear saved Esselunga session")
  .action(async () => {
    const client = new EsselungaClient();
    await client.logout();
    output(ok(null, "Session cleared."));
  });

esselunga
  .command("status")
  .description("Check Esselunga session status")
  .action(async () => {
    if (!hasSession("esselunga")) {
      output(err("Not logged in. Run: spesa esselunga login", "LOGIN_REQUIRED"));
      process.exit(1);
      return;
    }
    if (!isJsonMode()) {
      console.log("Checking session...");
    }
    const client = new EsselungaClient();
    const status = await client.checkSession();
    if (status.valid) {
      const msg = `Logged in${status.username ? ` as ${status.username}` : ""} (session ${Math.round(status.ageHours ?? 0)}h old)`;
      output(ok(status, msg));
    } else {
      output(err(`Session expired or invalid (${Math.round(status.ageHours ?? 0)}h old). Re-login required.`, "SESSION_EXPIRED"));
      process.exit(1);
    }
  });

// ─── search ──────────────────────────────────────────────────────────────────

esselunga
  .command("search <query>")
  .description("Search for products on Esselunga")
  .option("-n, --limit <n>", "Max results", "10")
  .action(async (query, opts) => {
    if (!requireSession()) return;
    if (!isJsonMode()) {
      console.log(`Searching for "${query}"...`);
    }
    const client = new EsselungaClient();
    try {
      const limit = parsePositiveInt(opts.limit, "limit");
      if (!limit) return;
      const products = await client.search(query, { maxResults: limit });
      if (isJsonMode()) {
        output(ok(products));
      } else {
        if (products.length === 0) {
          console.log("No products found.");
          return;
        }
        printTable(
          ["ID", "Name", "Brand", "Price (€)", "Match", "Available"],
          products.map((p) => [
            p.id.slice(0, 12),
            p.name.slice(0, 40),
            p.brand ?? "",
            p.price.toFixed(2),
            p.matchScore !== undefined ? `${Math.round(p.matchScore * 100)}%` : "",
            p.available ? "✓" : "✗",
          ])
        );
        console.log(`\n${products.length} result(s) for "${query}"`);
        console.log("Use product URLs with: spesa esselunga cart add <url>");
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

// ─── cart ────────────────────────────────────────────────────────────────────

const cart = esselunga
  .command("cart")
  .description("Manage shopping cart");

cart
  .command("list")
  .alias("ls")
  .description("Show current cart contents")
  .action(async () => {
    if (!requireSession()) return;
    if (!isJsonMode()) console.log("Loading cart...");
    const client = new EsselungaClient();
    try {
      const c = await client.getCart();
      if (isJsonMode()) {
        output(ok(c));
      } else {
        if (c.items.length === 0) {
          console.log("Cart is empty.");
          return;
        }
        printTable(
          ["Name", "Qty", "Price (€)", "Subtotal (€)"],
          c.items.map((i) => [
            i.name.slice(0, 40),
            i.quantity,
            i.price.toFixed(2),
            i.subtotal.toFixed(2),
          ])
        );
        console.log(`\nTotal: €${c.total.toFixed(2)} (${c.itemCount} items)`);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

cart
  .command("add <url-or-id>")
  .description("Add a product to cart by URL or product ID")
  .option("-q, --qty <n>", "Quantity", "1")
  .action(async (urlOrId, opts) => {
    if (!requireSession()) return;
    if (!isJsonMode()) console.log(`Adding to cart...`);
    const client = new EsselungaClient();
    try {
      const qty = parsePositiveInt(opts.qty, "qty");
      if (!qty) return;
      const result = await client.addToCart(urlOrId, qty);
      if (result.ok) {
        output(ok(null, `Added to cart (qty: ${qty})`));
      } else {
        output(err(result.error ?? "Failed to add to cart", "ADD_TO_CART_FAILED"));
        process.exit(1);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

cart
  .command("add-many")
  .description("Add multiple products to cart in one browser session")
  .option("--items <json>", 'JSON array of {query, qty?, pick?} objects, e.g. \'[{"query":"latte","qty":2},{"query":"pane"}]\'')
  .action(async (opts) => {
    if (!requireSession()) return;
    let items: { query: string; qty?: number; pick?: string }[];
    try {
      items = JSON.parse(opts.items);
      if (!Array.isArray(items) || items.length === 0) {
        output(err("--items must be a non-empty JSON array.", "INVALID_INPUT"));
        process.exit(1);
        return;
      }
    } catch {
      output(err("Invalid JSON in --items. Expected: [{\"query\":\"latte\",\"qty\":2}]", "INVALID_INPUT"));
      process.exit(1);
      return;
    }

    if (!isJsonMode()) console.log(`Adding ${items.length} items to cart...`);
    const client = new EsselungaClient();
    try {
      const results = await client.addManyToCart(items);
      if (isJsonMode()) {
        output(ok(results));
      } else {
        for (const r of results) {
          const status = r.ok ? "✓" : "✗";
          console.log(`${status} ${r.query}: ${r.ok ? `Added (qty: ${r.qty})` : r.error}`);
        }
        const succeeded = results.filter((r) => r.ok).length;
        console.log(`\n${succeeded}/${results.length} items added.`);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

cart
  .command("remove <product-id>")
  .alias("rm")
  .description("Remove a product from cart by ID")
  .action(async (productId) => {
    if (!requireSession()) return;
    if (!isJsonMode()) console.log(`Removing ${productId} from cart...`);
    const client = new EsselungaClient();
    try {
      const result = await client.removeFromCart(productId);
      if (result.ok) {
        output(ok(null, "Item removed from cart"));
      } else {
        output(err(result.error ?? "Failed to remove item", "PRODUCT_NOT_FOUND"));
        process.exit(1);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

cart
  .command("update <product-id>")
  .description("Update quantity of a product in the cart")
  .requiredOption("-q, --qty <n>", "New quantity")
  .action(async (productId, opts) => {
    if (!requireSession()) return;
    const qty = parsePositiveInt(opts.qty, "qty");
    if (!qty) return;
    if (!isJsonMode()) console.log(`Updating ${productId} to qty ${qty}...`);
    const client = new EsselungaClient();
    try {
      const result = await client.updateCartItem(productId, qty);
      if (result.ok) {
        output(ok(null, `Updated quantity to ${qty}`));
      } else {
        output(err(result.error ?? "Failed to update item", "PRODUCT_NOT_FOUND"));
        process.exit(1);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

cart
  .command("clear")
  .description("Remove all items from cart")
  .action(async () => {
    if (!requireSession()) return;
    if (!isYesMode() && !isJsonMode()) {
      console.log("This will remove all items from your cart.");
      console.log("Use -y flag to skip this confirmation.");
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((res) => rl.question("Continue? [y/N] ", res));
      rl.close();
      if (answer.toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }
    if (!isJsonMode()) console.log("Clearing cart...");
    const client = new EsselungaClient();
    try {
      const result = await client.clearCart();
      if (result.ok) {
        output(ok({ removedCount: result.removedCount }, `Cart cleared (${result.removedCount} items removed)`));
      } else {
        output(err(result.error ?? "Failed to clear cart", "UNKNOWN"));
        process.exit(1);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

// ─── buy (compound: search + pick + add) ────────────────────────────────────

esselunga
  .command("buy <query>")
  .description("Search, pick the best match, and add to cart in one step")
  .option("-q, --qty <n>", "Quantity", "1")
  .option("-n, --limit <n>", "Max search results to consider", "5")
  .option("--pick <strategy>", "Pick strategy: cheapest, first, exact", "first")
  .action(async (query, opts) => {
    if (!requireSession()) return;
    const qty = parsePositiveInt(opts.qty, "qty");
    if (!qty) return;
    const limit = parsePositiveInt(opts.limit, "limit");
    if (!limit) return;

    const client = new EsselungaClient();
    try {
      // Step 1: Search
      if (!isJsonMode()) console.log(`Searching for "${query}"...`);
      const products = await client.search(query, { maxResults: limit });
      if (products.length === 0) {
        output(err(`No products found for "${query}"`, "PRODUCT_NOT_FOUND"));
        process.exit(1);
        return;
      }

      // Step 2: Pick best match
      let picked = products[0]; // default: first result
      if (opts.pick === "cheapest") {
        picked = products.reduce((a, b) => (a.price <= b.price ? a : b));
      } else if (opts.pick === "exact") {
        const exact = products.find(
          (p) => p.name.toLowerCase() === query.toLowerCase()
        );
        picked = exact ?? products[0];
      }

      if (!isJsonMode())
        console.log(`Picked: ${picked.name} — €${picked.price.toFixed(2)}`);

      // Step 3: Add to cart
      if (!isJsonMode()) console.log(`Adding to cart (qty: ${qty})...`);
      const result = await client.addToCart(picked.url || picked.id, qty);
      if (result.ok) {
        output(
          ok(
            { product: picked, quantity: qty },
            `Added "${picked.name}" × ${qty} to cart (€${(picked.price * qty).toFixed(2)})`
          )
        );
      } else {
        output(err(result.error ?? "Failed to add to cart", "ADD_TO_CART_FAILED"));
        process.exit(1);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

// ─── checkout (compound: cart + slots summary) ──────────────────────────────

esselunga
  .command("checkout")
  .description("Show cart contents and available delivery slots in one step")
  .action(async () => {
    if (!requireSession()) return;

    const client = new EsselungaClient();
    try {
      // Step 1: Get cart
      if (!isJsonMode()) console.log("Loading cart...");
      const cart = await client.getCart();

      if (cart.items.length === 0) {
        output(ok({ cart, slots: [] }, "Cart is empty. Add items before checking out."));
        return;
      }

      // Step 2: Get delivery slots
      if (!isJsonMode()) console.log("Loading delivery slots...");
      const slots = await client.getDeliverySlots();
      const available = slots.filter((s) => s.available);

      if (isJsonMode()) {
        output(ok({ cart, slots, availableSlotCount: available.length }));
      } else {
        printTable(
          ["Name", "Qty", "Price (€)", "Subtotal (€)"],
          cart.items.map((i) => [
            i.name.slice(0, 40),
            i.quantity,
            i.price.toFixed(2),
            i.subtotal.toFixed(2),
          ])
        );
        console.log(`\nTotal: €${cart.total.toFixed(2)} (${cart.itemCount} items)`);
        console.log(`\n${available.length} of ${slots.length} delivery slots available`);
        if (available.length > 0) {
          const next = available[0];
          console.log(`Next available: ${next.date} ${next.timeRange}`);
        }
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

// ─── order (place order with selected slot) ─────────────────────────────────

esselunga
  .command("order")
  .description("Place an order with a selected delivery slot")
  .requiredOption("--slot <slot-id>", "Delivery slot ID (from slots command)")
  .action(async (opts) => {
    if (!requireSession()) return;

    if (!isYesMode() && !isJsonMode()) {
      console.log("You are about to place an order. This will charge your payment method.");
      console.log("Use -y flag to skip this confirmation.");
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((res) => rl.question("Continue? [y/N] ", res));
      rl.close();
      if (answer.toLowerCase() !== "y") {
        console.log("Order cancelled.");
        return;
      }
    }

    if (!isJsonMode()) console.log("Placing order...");
    const client = new EsselungaClient();
    try {
      const result = await client.placeOrder(opts.slot);
      if (result.ok) {
        const data = result.data!;
        if (isJsonMode()) {
          output(ok(data));
        } else {
          console.log(`Order placed!`);
          if (data.orderId) console.log(`Order ID: ${data.orderId}`);
          console.log(`Delivery: ${data.slot.date} ${data.slot.timeRange}`);
          console.log(`Total: €${data.total.toFixed(2)} (${data.itemCount} items)`);
        }
      } else {
        output(err(result.error ?? "Failed to place order", result.errorCode ?? "ORDER_FAILED"));
        process.exit(1);
      }
    } catch (e: unknown) {
      output(err(String(e), "ORDER_FAILED"));
      process.exit(1);
    }
  });

// ─── reorder (repeat a previous order) ──────────────────────────────────────

esselunga
  .command("reorder")
  .description("Re-add items from a previous order to your cart")
  .option("--order-id <id>", "Order ID to reorder (default: most recent)")
  .action(async (opts) => {
    if (!requireSession()) return;

    if (!isJsonMode()) console.log("Loading previous orders...");
    const client = new EsselungaClient();
    try {
      const result = await client.reorder(opts.orderId);
      if (result.ok) {
        const data = result.data!;
        if (isJsonMode()) {
          output(ok(data));
        } else {
          console.log(`Reordering from order ${data.sourceOrderId}:`);
          for (const item of data.results) {
            const status = item.ok ? "✓" : "✗";
            console.log(`  ${status} ${item.name}${!item.ok ? ` (${item.error})` : ""}`);
          }
          console.log(`\n${data.added}/${data.total} items added to cart.`);
        }
      } else {
        output(err(result.error ?? "Failed to reorder", result.errorCode ?? "UNKNOWN"));
        process.exit(1);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

// ─── slots ───────────────────────────────────────────────────────────────────

esselunga
  .command("slots")
  .description("Show available delivery slots")
  .action(async () => {
    if (!requireSession()) return;
    if (!isJsonMode()) console.log("Loading delivery slots...");
    const client = new EsselungaClient();
    try {
      const slots = await client.getDeliverySlots();
      if (isJsonMode()) {
        output(ok(slots));
      } else {
        const available = slots.filter((s) => s.available);
        if (slots.length === 0) {
          console.log("No slots found. Make sure you have items in your cart.");
          return;
        }
        printTable(
          ["ID", "Date", "Time", "Available"],
          slots.map((s) => [s.id, s.date, s.timeRange, s.available ? "✓" : "✗"])
        );
        console.log(`\n${available.length} of ${slots.length} slots available`);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

// ─── orders ──────────────────────────────────────────────────────────────────

esselunga
  .command("orders")
  .description("List recent orders")
  .option("-n, --limit <n>", "Max orders to show", "10")
  .action(async (opts) => {
    if (!requireSession()) return;
    if (!isJsonMode()) console.log("Loading orders...");
    const client = new EsselungaClient();
    try {
      const limit = parsePositiveInt(opts.limit, "limit");
      if (!limit) return;
      const orders = await client.getOrders(limit);
      if (isJsonMode()) {
        output(ok(orders));
      } else {
        if (orders.length === 0) {
          console.log("No orders found.");
          return;
        }
        printTable(
          ["Order ID", "Date", "Status", "Total (€)"],
          orders.map((o) => [o.id, o.date, o.status, o.total.toFixed(2)])
        );
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      process.exit(1);
    }
  });

// ─── doctor (setup check) ───────────────────────────────────────────────────

esselunga
  .command("doctor")
  .description("Check that all dependencies are installed and working")
  .action(async () => {
    const checks: { name: string; ok: boolean; detail: string }[] = [];

    // 1. Check bun
    checks.push({ name: "bun", ok: true, detail: `${process.version}` });

    // 2. Check playwright + webkit
    try {
      const { webkit } = await import("playwright");
      const browser = await webkit.launch({ headless: true });
      const version = browser.version();
      await browser.close();
      checks.push({ name: "playwright-webkit", ok: true, detail: `WebKit ${version}` });
    } catch (e: unknown) {
      const msg = String(e);
      let detail = "Playwright WebKit launch failed";
      let fix = "Run: bunx playwright install webkit";

      if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch")) {
        detail = "WebKit browser not installed";
        fix = "Run: bunx playwright install webkit";
      } else if (
        msg.includes("libmanette") ||
        msg.includes("libenchant") ||
        msg.includes("libhyphen") ||
        msg.includes("libsecret") ||
        msg.includes("libwoff") ||
        msg.includes("shared libraries") ||
        msg.includes(".so")
      ) {
        detail = "Missing system libraries for WebKit";
        fix = "Run: sudo npx playwright install-deps webkit";
      }

      checks.push({ name: "playwright-webkit", ok: false, detail: `${detail}. Fix: ${fix}` });
    }

    // 3. Check session
    if (hasSession("esselunga")) {
      checks.push({ name: "session", ok: true, detail: "Esselunga session found" });
    } else {
      checks.push({ name: "session", ok: false, detail: "No session. Run: spesa esselunga login -u EMAIL -p PASS" });
    }

    // 4. Check connectivity
    try {
      const conn = await EsselungaClient.checkConnectivity();
      checks.push({
        name: "connectivity",
        ok: conn.reachable,
        detail: conn.reachable ? "spesaonline.esselunga.it reachable" : (conn.error ?? "Unreachable"),
      });
    } catch {
      checks.push({ name: "connectivity", ok: false, detail: "Network check failed" });
    }

    if (isJsonMode()) {
      const allOk = checks.every((c) => c.ok);
      output(ok({ checks, allOk }, allOk ? "All checks passed" : "Some checks failed"));
      if (!allOk) process.exit(1);
    } else {
      for (const c of checks) {
        console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      }
      const allOk = checks.every((c) => c.ok);
      console.log(allOk ? "\nAll good! Ready to use." : "\nSome checks failed. Fix the issues above.");
      if (!allOk) process.exit(1);
    }
  });

program.parse();
