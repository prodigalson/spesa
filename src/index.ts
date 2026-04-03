#!/usr/bin/env bun
import { Command } from "commander";
import { setJsonMode, isJsonMode, setPlainMode, setYesMode, isYesMode, output, ok, err, printTable } from "./output.ts";
import { EsselungaClient } from "./platforms/esselunga/index.ts";
import { hasSession, sessionAge } from "./session.ts";
import { VERSION } from "./version.ts";
import { exitCodeFor } from "./exitcodes.ts";
import {
  getAllLists, getList, createList, deleteList,
  addToList, removeFromList, ensureFavorites,
} from "./lists.ts";
import type { ErrorCode } from "./types.ts";

const program = new Command();

program
  .name("spesa")
  .description("CLI for ordering groceries online in Italy")
  .version(VERSION)
  .option("--json", "Output as JSON (for agent use)")
  .option("--plain", "Output as tab-separated values (for piping)")
  .option("-y, --yes", "Non-interactive mode — never prompt for confirmation")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.json) setJsonMode(true);
    if (opts.plain) setPlainMode(true);
    if (opts.yes) setYesMode(true);
  });

// Helper: check session or exit (with auto-refresh attempt)
async function requireSession(): Promise<boolean> {
  if (!hasSession("esselunga")) {
    output(err("Not logged in. Run: spesa esselunga login", "LOGIN_REQUIRED"));
    process.exit(exitCodeFor("LOGIN_REQUIRED"));
    return false;
  }

  // Check if session is expired and attempt auto-refresh
  const age = sessionAge("esselunga");
  if (age !== null && age > 12) {
    if (!isJsonMode()) console.log("Session expired. Attempting auto-refresh...");
    const client = new EsselungaClient();
    const result = await client.ensureSession();
    if (!result.valid) {
      output(err("Session expired and auto-refresh failed. Run: spesa esselunga login", "SESSION_EXPIRED"));
      process.exit(exitCodeFor("SESSION_EXPIRED"));
      return false;
    }
    if (!isJsonMode() && result.refreshed) console.log("Session refreshed successfully.");
  }
  return true;
}

// Helper: parse positive integer option
function parsePositiveInt(val: string, name: string): number | null {
  const n = parseInt(val, 10);
  if (isNaN(n) || n < 1) {
    output(err(`Invalid --${name} value. Must be a positive integer.`, "INVALID_INPUT"));
    process.exit(exitCodeFor("INVALID_INPUT"));
    return null;
  }
  return n;
}

// Helper: exit with proper code
function exitWithError(code?: ErrorCode): never {
  process.exit(exitCodeFor(code));
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
      exitWithError("INVALID_INPUT");
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
      exitWithError(code);
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
      exitWithError("LOGIN_REQUIRED");
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
      exitWithError("SESSION_EXPIRED");
    }
  });

// ─── search ──────────────────────────────────────────────────────────────────

esselunga
  .command("search <query>")
  .description("Search for products on Esselunga")
  .option("-n, --limit <n>", "Max results", "10")
  .action(async (query, opts) => {
    if (!(await requireSession())) return;
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
      exitWithError("UNKNOWN");
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
    if (!(await requireSession())) return;
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
      exitWithError("UNKNOWN");
    }
  });

cart
  .command("add <url-or-id>")
  .description("Add a product to cart by URL or product ID")
  .option("-q, --qty <n>", "Quantity", "1")
  .action(async (urlOrId, opts) => {
    if (!(await requireSession())) return;
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
        exitWithError("ADD_TO_CART_FAILED");
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      exitWithError("UNKNOWN");
    }
  });

cart
  .command("add-many")
  .description("Add multiple products to cart in one browser session")
  .option("--items <json>", 'JSON array of {query, qty?, pick?} objects, e.g. \'[{"query":"latte","qty":2},{"query":"pane"}]\'')
  .action(async (opts) => {
    if (!(await requireSession())) return;
    let items: { query: string; qty?: number; pick?: string }[];
    try {
      items = JSON.parse(opts.items);
      if (!Array.isArray(items) || items.length === 0) {
        output(err("--items must be a non-empty JSON array.", "INVALID_INPUT"));
        exitWithError("INVALID_INPUT");
      }
    } catch {
      output(err("Invalid JSON in --items. Expected: [{\"query\":\"latte\",\"qty\":2}]", "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
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
      exitWithError("UNKNOWN");
    }
  });

cart
  .command("remove <product-id>")
  .alias("rm")
  .description("Remove a product from cart by ID")
  .action(async (productId) => {
    if (!(await requireSession())) return;
    if (!isJsonMode()) console.log(`Removing ${productId} from cart...`);
    const client = new EsselungaClient();
    try {
      const result = await client.removeFromCart(productId);
      if (result.ok) {
        output(ok(null, "Item removed from cart"));
      } else {
        output(err(result.error ?? "Failed to remove item", "PRODUCT_NOT_FOUND"));
        exitWithError("PRODUCT_NOT_FOUND");
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      exitWithError("UNKNOWN");
    }
  });

cart
  .command("update <product-id>")
  .description("Update quantity of a product in the cart")
  .requiredOption("-q, --qty <n>", "New quantity")
  .action(async (productId, opts) => {
    if (!(await requireSession())) return;
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
        exitWithError("PRODUCT_NOT_FOUND");
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      exitWithError("UNKNOWN");
    }
  });

cart
  .command("clear")
  .description("Remove all items from cart")
  .action(async () => {
    if (!(await requireSession())) return;
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
        exitWithError("UNKNOWN");
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      exitWithError("UNKNOWN");
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
    if (!(await requireSession())) return;
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
        exitWithError("PRODUCT_NOT_FOUND");
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
        exitWithError("ADD_TO_CART_FAILED");
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      exitWithError("UNKNOWN");
    }
  });

// ─── checkout (compound: cart + slots summary) ──────────────────────────────

esselunga
  .command("checkout")
  .description("Show cart contents and available delivery slots in one step")
  .action(async () => {
    if (!(await requireSession())) return;

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
      exitWithError("UNKNOWN");
    }
  });

// ─── order (place order with selected slot) ─────────────────────────────────

esselunga
  .command("order")
  .description("Place an order with a selected delivery slot")
  .requiredOption("--slot <slot-id>", "Delivery slot ID (from slots command)")
  .action(async (opts) => {
    if (!(await requireSession())) return;

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
        exitWithError(result.errorCode ?? "ORDER_FAILED");
      }
    } catch (e: unknown) {
      output(err(String(e), "ORDER_FAILED"));
      exitWithError("ORDER_FAILED");
    }
  });

// ─── reorder (repeat a previous order) ──────────────────────────────────────

esselunga
  .command("reorder")
  .description("Re-add items from a previous order to your cart")
  .option("--order-id <id>", "Order ID to reorder (default: most recent)")
  .action(async (opts) => {
    if (!(await requireSession())) return;

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
        exitWithError(result.errorCode ?? "UNKNOWN");
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      exitWithError("UNKNOWN");
    }
  });

// ─── slots ───────────────────────────────────────────────────────────────────

esselunga
  .command("slots")
  .description("Show available delivery slots")
  .action(async () => {
    if (!(await requireSession())) return;
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
      exitWithError("UNKNOWN");
    }
  });

// ─── orders ──────────────────────────────────────────────────────────────────

esselunga
  .command("orders")
  .description("List recent orders")
  .option("-n, --limit <n>", "Max orders to show", "10")
  .action(async (opts) => {
    if (!(await requireSession())) return;
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
      exitWithError("UNKNOWN");
    }
  });

// ─── lists ──────────────────────────────────────────────────────────────────

const list = esselunga
  .command("list")
  .description("Manage reusable shopping lists (stored locally)");

list
  .command("ls")
  .description("Show all saved lists")
  .action(() => {
    const lists = getAllLists();
    if (isJsonMode()) {
      output(ok(lists));
      return;
    }
    if (lists.length === 0) {
      console.log("No lists yet. Create one: spesa esselunga list create <name>");
      return;
    }
    printTable(
      ["Name", "Items", "Updated"],
      lists.map((l) => [l.name, l.items.length, l.updatedAt.slice(0, 10)])
    );
  });

list
  .command("create <name>")
  .description("Create a new empty list")
  .action((name) => {
    try {
      const l = createList(name);
      output(ok(l, `List "${name}" created.`));
    } catch (e: unknown) {
      output(err(String(e instanceof Error ? e.message : e), "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
    }
  });

list
  .command("delete <name>")
  .description("Delete a saved list")
  .action((name) => {
    try {
      deleteList(name);
      output(ok(null, `List "${name}" deleted.`));
    } catch (e: unknown) {
      output(err(String(e instanceof Error ? e.message : e), "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
    }
  });

list
  .command("show <name>")
  .description("Show items in a list")
  .action((name) => {
    const l = getList(name);
    if (!l) {
      output(err(`List "${name}" not found`, "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
    }
    if (isJsonMode()) {
      output(ok(l));
      return;
    }
    if (l!.items.length === 0) {
      console.log(`List "${name}" is empty. Add items: spesa esselunga list add ${name} <query>`);
      return;
    }
    printTable(
      ["Item", "Qty", "Pick"],
      l!.items.map((i) => [i.query, i.qty, i.pick ?? "first"])
    );
    console.log(`\n${l!.items.length} item(s) in "${name}"`);
  });

list
  .command("add <name> <query>")
  .description("Add an item to a list")
  .option("-q, --qty <n>", "Quantity", "1")
  .option("--pick <strategy>", "Pick strategy: first, cheapest, exact", "first")
  .action((name, query, opts) => {
    const qty = parsePositiveInt(opts.qty, "qty");
    if (!qty) return;
    try {
      const item = addToList(name, query, qty, opts.pick);
      output(ok(item, `Added "${query}" (qty: ${qty}) to list "${name}"`));
    } catch (e: unknown) {
      output(err(String(e instanceof Error ? e.message : e), "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
    }
  });

list
  .command("remove <name> <query>")
  .alias("rm")
  .description("Remove an item from a list")
  .action((name, query) => {
    try {
      removeFromList(name, query);
      output(ok(null, `Removed "${query}" from list "${name}"`));
    } catch (e: unknown) {
      output(err(String(e instanceof Error ? e.message : e), "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
    }
  });

list
  .command("order <name>")
  .description("Add all items from a list to your Esselunga cart")
  .action(async (name) => {
    if (!(await requireSession())) return;
    const l = getList(name);
    if (!l) {
      output(err(`List "${name}" not found`, "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
    }
    if (l!.items.length === 0) {
      output(err(`List "${name}" is empty`, "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
    }

    const items = l!.items.map((i) => ({
      query: i.query,
      qty: i.qty,
      pick: i.pick ?? ("first" as string),
    }));

    if (!isJsonMode()) console.log(`Ordering ${items.length} items from list "${name}"...`);
    const client = new EsselungaClient();
    try {
      const results = await client.addManyToCart(items);
      if (isJsonMode()) {
        output(ok({ list: name, results }));
      } else {
        for (const r of results) {
          const status = r.ok ? "✓" : "✗";
          console.log(`${status} ${r.query}: ${r.ok ? `Added (qty: ${r.qty})` : r.error}`);
        }
        const succeeded = results.filter((r) => r.ok).length;
        console.log(`\n${succeeded}/${results.length} items from "${name}" added to cart.`);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      exitWithError("UNKNOWN");
    }
  });

// ─── favorites (shorthand for the "favorites" list) ─────────────────────────

const fav = esselunga
  .command("fav")
  .description("Manage your favorites list (shorthand for list \"favorites\")");

fav
  .command("add <query>")
  .description("Add a product to favorites")
  .option("-q, --qty <n>", "Quantity", "1")
  .option("--pick <strategy>", "Pick strategy: first, cheapest, exact", "first")
  .action((query, opts) => {
    ensureFavorites();
    const qty = parsePositiveInt(opts.qty, "qty");
    if (!qty) return;
    try {
      const item = addToList("favorites", query, qty, opts.pick);
      output(ok(item, `Added "${query}" to favorites`));
    } catch (e: unknown) {
      output(err(String(e instanceof Error ? e.message : e), "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
    }
  });

fav
  .command("remove <query>")
  .alias("rm")
  .description("Remove a product from favorites")
  .action((query) => {
    ensureFavorites();
    try {
      removeFromList("favorites", query);
      output(ok(null, `Removed "${query}" from favorites`));
    } catch (e: unknown) {
      output(err(String(e instanceof Error ? e.message : e), "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
    }
  });

fav
  .command("list")
  .alias("ls")
  .description("Show all favorites")
  .action(() => {
    ensureFavorites();
    const l = getList("favorites")!;
    if (isJsonMode()) {
      output(ok(l));
      return;
    }
    if (l.items.length === 0) {
      console.log("No favorites yet. Add one: spesa esselunga fav add <query>");
      return;
    }
    printTable(
      ["Item", "Qty", "Pick"],
      l.items.map((i) => [i.query, i.qty, i.pick ?? "first"])
    );
    console.log(`\n${l.items.length} favorite(s)`);
  });

fav
  .command("order")
  .description("Add all favorites to your Esselunga cart")
  .action(async () => {
    if (!(await requireSession())) return;
    ensureFavorites();
    const l = getList("favorites")!;
    if (l.items.length === 0) {
      output(err("No favorites yet. Add some first.", "INVALID_INPUT"));
      exitWithError("INVALID_INPUT");
    }

    const items = l.items.map((i) => ({
      query: i.query,
      qty: i.qty,
      pick: i.pick ?? ("first" as string),
    }));

    if (!isJsonMode()) console.log(`Ordering ${items.length} favorites...`);
    const client = new EsselungaClient();
    try {
      const results = await client.addManyToCart(items);
      if (isJsonMode()) {
        output(ok({ list: "favorites", results }));
      } else {
        for (const r of results) {
          const status = r.ok ? "✓" : "✗";
          console.log(`${status} ${r.query}: ${r.ok ? `Added (qty: ${r.qty})` : r.error}`);
        }
        const succeeded = results.filter((r) => r.ok).length;
        console.log(`\n${succeeded}/${results.length} favorites added to cart.`);
      }
    } catch (e: unknown) {
      output(err(String(e), "UNKNOWN"));
      exitWithError("UNKNOWN");
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
      if (!allOk) process.exit(exitCodeFor("UNKNOWN"));
    } else {
      for (const c of checks) {
        console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      }
      const allOk = checks.every((c) => c.ok);
      console.log(allOk ? "\nAll good! Ready to use." : "\nSome checks failed. Fix the issues above.");
      if (!allOk) process.exit(exitCodeFor("UNKNOWN"));
    }
  });

// ─── schema (CLI introspection for agents) ──────────────────────────────────

function extractCommandTree(cmd: Command): object {
  const result: Record<string, unknown> = {
    name: cmd.name(),
    description: cmd.description(),
  };

  const aliases = cmd.aliases();
  if (aliases.length > 0) result.aliases = aliases;

  const opts = cmd.options.map((o) => ({
    flags: o.flags,
    description: o.description,
    required: o.required,
    defaultValue: o.defaultValue,
  }));
  if (opts.length > 0) result.options = opts;

  const args = cmd.registeredArguments?.map((a) => ({
    name: a.name(),
    required: a.required,
    description: a.description,
  }));
  if (args && args.length > 0) result.arguments = args;

  const subs = cmd.commands.map(extractCommandTree);
  if (subs.length > 0) result.subcommands = subs;

  return result;
}

program
  .command("schema")
  .description("Dump the full CLI command tree as JSON (for agent introspection)")
  .action(() => {
    const tree = extractCommandTree(program);
    console.log(JSON.stringify(tree, null, 2));
  });

program.parse();
