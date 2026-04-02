#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { EsselungaClient } from "./platforms/esselunga/index.ts";
import { hasSession } from "./session.ts";
import type { ErrorCode } from "./types.ts";
import { VERSION } from "./version.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string, errorCode?: ErrorCode) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, errorCode: errorCode ?? "UNKNOWN" }),
      },
    ],
    isError: true as const,
  };
}

function requireSession() {
  if (!hasSession("esselunga")) {
    return errorResult(
      "No valid Esselunga session. The user must log in manually by running:\n" +
        "  spesa esselunga login -u EMAIL -p PASSWORD\n" +
        "Login requires a visible browser window for MFA and cannot be done via MCP.",
      "LOGIN_REQUIRED"
    );
  }
  return null;
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
  // Session
  {
    name: "check_session",
    description:
      "Check if the Esselunga session is valid. Returns session status, username, and age. " +
      "Run this before any other tool. If invalid, the user must run the CLI login command manually.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "check_connectivity",
    description:
      "Check if spesaonline.esselunga.it is reachable. Use to diagnose network/VPN issues.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "logout",
    description: "Clear the saved Esselunga session.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },

  // Search
  {
    name: "search_products",
    description:
      "Search for products on Esselunga by name or brand. Returns products sorted by matchScore " +
      "(1.0 = exact match, >0.7 = good match). Each product has id, name, price, url, and matchScore.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search term, e.g. 'latte intero', 'pasta barilla', 'mozzarella di bufala'",
        },
        max_results: {
          type: "number",
          description: "Maximum results to return (default: 10)",
        },
      },
      required: ["query"],
    },
  },

  // Cart
  {
    name: "get_cart",
    description: "Get current cart contents including items, quantities, prices, and total.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "add_to_cart",
    description:
      "Add a single product to the cart by URL or product ID. " +
      "Prefer product URLs (from search_products) for deterministic results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        product_url_or_id: {
          type: "string",
          description: "Full product URL or product ID/SKU",
        },
        quantity: {
          type: "number",
          description: "Quantity to add (default: 1)",
        },
      },
      required: ["product_url_or_id"],
    },
  },
  {
    name: "add_many_to_cart",
    description:
      "Add multiple products to the cart in a single browser session. " +
      "Much faster than calling add_to_cart repeatedly. Each item is searched and the best match is added. " +
      "NOT idempotent: calling twice will add duplicates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          description: "Array of items to add",
          items: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search term for this product",
              },
              qty: {
                type: "number",
                description: "Quantity (default: 1)",
              },
              pick: {
                type: "string",
                enum: ["first", "cheapest", "exact"],
                description: "Pick strategy (default: first)",
              },
            },
            required: ["query"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "remove_from_cart",
    description: "Remove a product from the cart by product ID (from get_cart).",
    inputSchema: {
      type: "object" as const,
      properties: {
        product_id: {
          type: "string",
          description: "Product ID to remove (use the id field from get_cart results)",
        },
      },
      required: ["product_id"],
    },
  },
  {
    name: "update_cart_item",
    description: "Update the quantity of a product already in the cart.",
    inputSchema: {
      type: "object" as const,
      properties: {
        product_id: {
          type: "string",
          description: "Product ID to update",
        },
        quantity: {
          type: "number",
          description: "New quantity",
        },
      },
      required: ["product_id", "quantity"],
    },
  },
  {
    name: "clear_cart",
    description: "Remove ALL items from the cart. Idempotent: safe to retry.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },

  // Orders
  {
    name: "get_delivery_slots",
    description:
      "Get available delivery time slots. Cart must have items. " +
      "Returns slot IDs in format 'dayIndex-startTime-endTime' (e.g. '0-09:00-10:00'). " +
      "Use these IDs with place_order.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "place_order",
    description:
      "Place an order with a selected delivery slot. This charges the user's payment method. " +
      "NOT idempotent: do NOT retry after success. " +
      "Returns order confirmation with orderId, slot, total, and itemCount.",
    inputSchema: {
      type: "object" as const,
      properties: {
        slot_id: {
          type: "string",
          description: "Delivery slot ID from get_delivery_slots (e.g. '0-09:00-10:00')",
        },
      },
      required: ["slot_id"],
    },
  },
  {
    name: "get_orders",
    description: "List recent past orders with order ID, date, status, and total.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum orders to return (default: 10)",
        },
      },
      required: [],
    },
  },
  {
    name: "reorder",
    description:
      "Re-add items from a previous order to the current cart. " +
      "Defaults to the most recent order if no order_id is specified.",
    inputSchema: {
      type: "object" as const,
      properties: {
        order_id: {
          type: "string",
          description: "Order ID to reorder from. Omit for most recent order.",
        },
      },
      required: [],
    },
  },

  // Health
  {
    name: "doctor",
    description:
      "Run health checks: Bun runtime, Playwright WebKit, session status, and network connectivity. " +
      "Run this first on a new machine or when things aren't working.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// ─── Server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "spesa", version: VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      // ── Session ──────────────────────────────────────────────────────
      case "check_session": {
        if (!hasSession("esselunga")) {
          return jsonResult({
            valid: false,
            message:
              "No valid session. The user must log in by running:\n" +
              "  spesa esselunga login -u EMAIL -p PASSWORD\n" +
              "Login requires a visible browser window for MFA.",
          });
        }
        const client = new EsselungaClient();
        const status = await client.checkSession();
        if (!status.valid) {
          return jsonResult({
            ...status,
            message:
              "Session expired. The user must re-login by running:\n" +
              "  spesa esselunga login -u EMAIL -p PASSWORD",
          });
        }
        return jsonResult(status);
      }

      case "check_connectivity": {
        const conn = await EsselungaClient.checkConnectivity();
        return jsonResult(conn);
      }

      case "logout": {
        const client = new EsselungaClient();
        await client.logout();
        return jsonResult({ ok: true, message: "Session cleared." });
      }

      // ── Search ───────────────────────────────────────────────────────
      case "search_products": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = new EsselungaClient();
        const products = await client.search(
          args.query as string,
          { maxResults: (args.max_results as number) ?? 10 }
        );
        return jsonResult(products);
      }

      // ── Cart ─────────────────────────────────────────────────────────
      case "get_cart": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = new EsselungaClient();
        const cart = await client.getCart();
        return jsonResult(cart);
      }

      case "add_to_cart": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = new EsselungaClient();
        const result = await client.addToCart(
          args.product_url_or_id as string,
          (args.quantity as number) ?? 1
        );
        if (!result.ok) {
          return errorResult(result.error ?? "Failed to add to cart", "ADD_TO_CART_FAILED");
        }
        return jsonResult({ ok: true, message: `Added to cart (qty: ${(args.quantity as number) ?? 1})` });
      }

      case "add_many_to_cart": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const items = args.items as { query: string; qty?: number; pick?: string }[];
        if (!Array.isArray(items) || items.length === 0) {
          return errorResult("items must be a non-empty array", "INVALID_INPUT");
        }
        const client = new EsselungaClient();
        const results = await client.addManyToCart(items);
        return jsonResult(results);
      }

      case "remove_from_cart": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = new EsselungaClient();
        const result = await client.removeFromCart(args.product_id as string);
        if (!result.ok) {
          return errorResult(result.error ?? "Failed to remove item", "PRODUCT_NOT_FOUND");
        }
        return jsonResult({ ok: true, message: "Item removed from cart" });
      }

      case "update_cart_item": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = new EsselungaClient();
        const result = await client.updateCartItem(
          args.product_id as string,
          args.quantity as number
        );
        if (!result.ok) {
          return errorResult(result.error ?? "Failed to update item", "PRODUCT_NOT_FOUND");
        }
        return jsonResult({ ok: true, message: `Updated quantity to ${args.quantity}` });
      }

      case "clear_cart": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = new EsselungaClient();
        const result = await client.clearCart();
        if (!result.ok) {
          return errorResult(result.error ?? "Failed to clear cart", "UNKNOWN");
        }
        return jsonResult({
          ok: true,
          removedCount: result.removedCount,
          message: `Cart cleared (${result.removedCount} items removed)`,
        });
      }

      // ── Orders ───────────────────────────────────────────────────────
      case "get_delivery_slots": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = new EsselungaClient();
        const slots = await client.getDeliverySlots();
        return jsonResult(slots);
      }

      case "place_order": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = new EsselungaClient();
        const result = await client.placeOrder(args.slot_id as string);
        if (!result.ok) {
          return errorResult(
            result.error ?? "Failed to place order",
            result.errorCode ?? "ORDER_FAILED"
          );
        }
        return jsonResult(result.data);
      }

      case "get_orders": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = new EsselungaClient();
        const orders = await client.getOrders((args.limit as number) ?? 10);
        return jsonResult(orders);
      }

      case "reorder": {
        const sessionErr = requireSession();
        if (sessionErr) return sessionErr;
        const client = new EsselungaClient();
        const result = await client.reorder(args.order_id as string | undefined);
        if (!result.ok) {
          return errorResult(
            result.error ?? "Failed to reorder",
            result.errorCode ?? "UNKNOWN"
          );
        }
        return jsonResult(result.data);
      }

      // ── Health ───────────────────────────────────────────────────────
      case "doctor": {
        const checks: { name: string; ok: boolean; detail: string }[] = [];

        // Bun runtime
        checks.push({ name: "bun", ok: true, detail: process.version });

        // Playwright WebKit
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
          } else if (
            msg.includes("libmanette") || msg.includes("libenchant") ||
            msg.includes("libhyphen") || msg.includes("libsecret") ||
            msg.includes("libwoff") || msg.includes("shared libraries") || msg.includes(".so")
          ) {
            detail = "Missing system libraries for WebKit";
            fix = "Run: sudo npx playwright install-deps webkit";
          }
          checks.push({ name: "playwright-webkit", ok: false, detail: `${detail}. Fix: ${fix}` });
        }

        // Session
        if (hasSession("esselunga")) {
          checks.push({ name: "session", ok: true, detail: "Esselunga session found" });
        } else {
          checks.push({
            name: "session",
            ok: false,
            detail: "No session. Run: spesa esselunga login -u EMAIL -p PASS",
          });
        }

        // Connectivity
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

        const allOk = checks.every((c) => c.ok);
        return jsonResult({ checks, allOk });
      }

      default:
        return errorResult(`Unknown tool: ${name}`, "UNKNOWN");
    }
  } catch (e: unknown) {
    return errorResult(String(e), "UNKNOWN");
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
