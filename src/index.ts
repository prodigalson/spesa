#!/usr/bin/env bun
import { Command } from "commander";
import { setJsonMode, isJsonMode, output, ok, err, printTable } from "./output.ts";
import { EsselungaClient } from "./platforms/esselunga/index.ts";
import { hasSession, sessionAge } from "./session.ts";

const program = new Command();

program
  .name("spesa")
  .description("CLI for ordering groceries online in Italy")
  .version("0.1.0")
  .option("--json", "Output as JSON (for agent use)")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.json) setJsonMode(true);
  });

// ─── esselunga ───────────────────────────────────────────────────────────────

const esselunga = program
  .command("esselunga")
  .alias("e")
  .description("Interact with Esselunga online grocery");

esselunga
  .command("login")
  .description("Authenticate with Esselunga (opens browser for MFA if needed)")
  .requiredOption("-u, --username <email>", "Esselunga account email")
  .requiredOption("-p, --password <password>", "Esselunga password")
  .option("--headless", "Run browser in headless mode (MFA won't work)")
  .action(async (opts) => {
    const client = new EsselungaClient();
    if (!isJsonMode()) {
      console.log("Logging in to Esselunga...");
    }
    const result = await client.login(opts.username, opts.password, {
      headless: opts.headless ?? false,
    });
    if (result.ok) {
      output(ok(null, "Logged in successfully. Session saved."));
    } else {
      output(err(result.error ?? "Login failed"));
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
      output(err("Not logged in. Run: spesa esselunga login"));
      process.exit(1);
      return;
    }
    const age = sessionAge("esselunga");
    if (!isJsonMode()) {
      console.log("Checking session...");
    }
    const client = new EsselungaClient();
    const status = await client.checkSession();
    if (status.valid) {
      const msg = `Logged in${status.username ? ` as ${status.username}` : ""} (session ${Math.round(status.ageHours ?? 0)}h old)`;
      output(ok(status, msg));
    } else {
      output(err(`Session expired or invalid (${Math.round(age ?? 0)}h old). Re-login required.`));
      process.exit(1);
    }
  });

// ─── search ──────────────────────────────────────────────────────────────────

esselunga
  .command("search <query>")
  .description("Search for products on Esselunga")
  .option("-n, --limit <n>", "Max results", "10")
  .action(async (query, opts) => {
    if (!hasSession("esselunga")) {
      output(err("Not logged in. Run: spesa esselunga login"));
      process.exit(1);
      return;
    }
    if (!isJsonMode()) {
      console.log(`Searching for "${query}"...`);
    }
    const client = new EsselungaClient();
    try {
      const products = await client.search(query, { maxResults: parseInt(opts.limit) });
      if (isJsonMode()) {
        output(ok(products));
      } else {
        if (products.length === 0) {
          console.log("No products found.");
          return;
        }
        printTable(
          ["ID", "Name", "Brand", "Price (€)", "Available"],
          products.map((p) => [
            p.id.slice(0, 12),
            p.name.slice(0, 40),
            p.brand ?? "",
            p.price.toFixed(2),
            p.available ? "✓" : "✗",
          ])
        );
        console.log(`\n${products.length} result(s) for "${query}"`);
        console.log("Use product URLs with: spesa esselunga cart add <url>");
      }
    } catch (e: unknown) {
      output(err(String(e)));
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
    if (!hasSession("esselunga")) {
      output(err("Not logged in. Run: spesa esselunga login"));
      process.exit(1);
      return;
    }
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
      output(err(String(e)));
      process.exit(1);
    }
  });

cart
  .command("add <url-or-id>")
  .description("Add a product to cart by URL or product ID")
  .option("-q, --qty <n>", "Quantity", "1")
  .action(async (urlOrId, opts) => {
    if (!hasSession("esselunga")) {
      output(err("Not logged in. Run: spesa esselunga login"));
      process.exit(1);
      return;
    }
    if (!isJsonMode()) console.log(`Adding to cart...`);
    const client = new EsselungaClient();
    try {
      const result = await client.addToCart(urlOrId, parseInt(opts.qty));
      if (result.ok) {
        output(ok(null, `Added to cart (qty: ${opts.qty})`));
      } else {
        output(err(result.error ?? "Failed to add to cart"));
        process.exit(1);
      }
    } catch (e: unknown) {
      output(err(String(e)));
      process.exit(1);
    }
  });

cart
  .command("remove <product-id>")
  .alias("rm")
  .description("Remove a product from cart by ID")
  .action(async (productId) => {
    if (!hasSession("esselunga")) {
      output(err("Not logged in. Run: spesa esselunga login"));
      process.exit(1);
      return;
    }
    if (!isJsonMode()) console.log(`Removing ${productId} from cart...`);
    const client = new EsselungaClient();
    try {
      const result = await client.removeFromCart(productId);
      if (result.ok) {
        output(ok(null, "Item removed from cart"));
      } else {
        output(err(result.error ?? "Failed to remove item"));
        process.exit(1);
      }
    } catch (e: unknown) {
      output(err(String(e)));
      process.exit(1);
    }
  });

// ─── slots ───────────────────────────────────────────────────────────────────

esselunga
  .command("slots")
  .description("Show available delivery slots")
  .action(async () => {
    if (!hasSession("esselunga")) {
      output(err("Not logged in. Run: spesa esselunga login"));
      process.exit(1);
      return;
    }
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
      output(err(String(e)));
      process.exit(1);
    }
  });

// ─── orders ──────────────────────────────────────────────────────────────────

esselunga
  .command("orders")
  .description("List recent orders")
  .option("-n, --limit <n>", "Max orders to show", "10")
  .action(async (opts) => {
    if (!hasSession("esselunga")) {
      output(err("Not logged in. Run: spesa esselunga login"));
      process.exit(1);
      return;
    }
    if (!isJsonMode()) console.log("Loading orders...");
    const client = new EsselungaClient();
    try {
      const orders = await client.getOrders(parseInt(opts.limit));
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
      output(err(String(e)));
      process.exit(1);
    }
  });

program.parse();
