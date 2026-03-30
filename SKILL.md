---
name: spesa
description: Order groceries online in Italy via Esselunga. Search products, manage cart, check delivery slots, view orders. Invoke when the user wants to buy groceries, add items to cart, or check Esselunga delivery.
---

# spesa — Italian Grocery Ordering

CLI for ordering groceries online in Italy. Currently supports Esselunga (Step 1). Everli coming in Step 2.

## Setup (one-time)

```bash
# Install dependencies and build
cd /path/to/spesa
bun install
bunx playwright install chromium
bun run build
# Binary is now at ./dist/spesa — add to PATH or use full path
```

## Authentication

The CLI requires a one-time login. It opens a visible browser window so you can complete MFA:

```bash
spesa esselunga login -u your@email.com -p yourpassword
```

Session is saved to `~/.spesa/sessions/esselunga.json` and lasts ~12 hours.

Check session status:
```bash
spesa esselunga status
spesa esselunga status --json
```

## Searching for Products

```bash
# Human-readable table
spesa esselunga search "latte intero"
spesa esselunga search "pasta barilla" --limit 5

# JSON output (for agent use)
spesa esselunga search "pane" --json
```

JSON output format:
```json
{
  "ok": true,
  "data": [
    {
      "id": "12345",
      "name": "Latte Intero Esselunga 1L",
      "brand": "Esselunga",
      "price": 1.29,
      "pricePerUnit": "1.29/L",
      "url": "https://spesaonline.esselunga.it/...product/12345",
      "available": true
    }
  ]
}
```

## Managing the Cart

```bash
# Add by product URL or ID
spesa esselunga cart add https://spesaonline.esselunga.it/.../product/12345
spesa esselunga cart add 12345 --qty 3

# View cart
spesa esselunga cart list
spesa esselunga cart list --json

# Remove item
spesa esselunga cart remove 12345
```

Cart JSON format:
```json
{
  "ok": true,
  "data": {
    "items": [
      { "id": "12345", "name": "Latte Intero 1L", "price": 1.29, "quantity": 2, "subtotal": 2.58 }
    ],
    "total": 2.58,
    "itemCount": 2
  }
}
```

## Delivery Slots

```bash
spesa esselunga slots
spesa esselunga slots --json
```

## Orders

```bash
spesa esselunga orders
spesa esselunga orders --limit 5 --json
```

## Full Agent Workflow

```bash
# 1. Verify session
spesa esselunga status --json

# 2. Search for items
spesa esselunga search "mozzarella di bufala" --json --limit 5

# 3. Add top result to cart
spesa esselunga cart add <url-from-search> --qty 2 --json

# 4. View cart to confirm
spesa esselunga cart list --json

# 5. Check delivery slots
spesa esselunga slots --json
```

## Error Handling

All commands exit with code 1 on failure. JSON mode always returns `{ "ok": false, "error": "..." }` on failure.

Common errors:
- `Not logged in` → run `spesa esselunga login`
- `Session expired` → re-run `spesa esselunga login`
- `MFA required` → run login without `--headless` (default) and complete in browser

## Architecture Notes

- Uses Playwright (headless Chromium) to drive the Esselunga Angular SPA
- Intercepts XHR/fetch responses to capture product API data when available
- Falls back to DOM scraping for product cards and cart items
- Sessions stored as cookies in `~/.spesa/sessions/`
- No public API — all interactions via browser automation
