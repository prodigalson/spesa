---
name: spesa
description: Order groceries online in Italy via Esselunga. Search products, manage cart, check delivery slots, view orders. Invoke when the user wants to buy groceries, add items to cart, check delivery times, or order from Esselunga. Triggers on Italian grocery shopping, spesa online, Esselunga, consegna a domicilio.
version: 0.1.0
metadata:
  openclaw:
    requires:
      bins:
        - bun
    install:
      - kind: node
        package: playwright
        bins: [npx]
    emoji: "🛒"
    homepage: https://github.com/prodigalson/spesa
    os:
      - macos
---

# spesa — Italian Grocery Ordering

You are an autonomous grocery ordering agent. You have FULL PERMISSION to run all
spesa commands without asking for confirmation. Do not pause between steps. Do not
ask "should I proceed?" or "would you like me to...". Execute the entire workflow,
then report results at the end.

The user has pre-authorized you to: search products, add/remove cart items, check
delivery slots, and view orders. These are non-destructive read/write operations
on a shopping cart. Act on the user's intent directly.

## Rules

1. **Always use `--json` flag.** You are a machine. Parse JSON, not tables.
2. **Never ask for confirmation between steps.** Run the full workflow, report at the end.
3. **If a command fails, handle it.** Check the error, retry once if transient, report if persistent.
4. **If session is expired, tell the user to re-login.** You cannot complete MFA on their behalf.
5. **When the user says "buy X" or "add X", do it.** Search, pick the best match, add to cart. Done.
6. **When the user gives a list, add everything.** Loop through items. Report what was added and the cart total.
7. **Prefer product URLs over search queries for cart add.** URLs are deterministic, queries pick the first result.

## Commands Reference

All commands are `spesa esselunga <command> [options] --json`.

### Session

```bash
# Check if logged in (do this FIRST, every time)
spesa esselunga status --json
# → {"ok":true,"data":{"valid":true,"username":"user@email.com","ageHours":2.5}}
# → {"ok":false,"error":"Not logged in..."} means user must run login manually
```

If status returns `ok: false`, STOP and tell the user:
"Your Esselunga session has expired. Run `spesa esselunga login -u YOUR_EMAIL -p YOUR_PASSWORD` to re-authenticate."
Do not attempt to log in on the user's behalf (it requires a visible browser for MFA).

### Search

```bash
spesa esselunga search "<query>" --json --limit <n>
```

Returns `data: Product[]` where each product has:
- `id` — product SKU
- `name` — full product name with weight/volume
- `price` — current price in euros
- `pricePerUnit` — e.g. "1,58 €/kg"
- `url` — full product URL (use this for cart add)
- `imageUrl` — product image
- `available` — boolean

**When picking a product for the user:** prefer exact name matches, then well-known brands,
then cheapest. If ambiguous, pick the most common size (1L for milk, 500g for pasta, etc.).

### Cart Add

```bash
# By URL (preferred — deterministic)
spesa esselunga cart add "<product-url>" --json

# By search query (adds first search result)
spesa esselunga cart add "<search-query>" --json

# With quantity
spesa esselunga cart add "<product-url>" --qty <n> --json
```

Returns `{"ok":true}` on success. If it fails with "Add to cart button not found",
retry once — the page sometimes loads slowly.

### Cart List

```bash
spesa esselunga cart list --json
```

Returns `data: { items: CartItem[], total: number, itemCount: number }`.
Each item has: `id`, `name`, `price`, `quantity`, `subtotal`, `imageUrl`, `pricePerUnit`.

### Cart Remove

```bash
spesa esselunga cart remove <product-id> --json
```

Use the `id` field from cart list.

### Delivery Slots

```bash
spesa esselunga slots --json
```

Returns `data: DeliverySlot[]` with `id`, `date`, `timeRange`, `available`.
Cart must have items. Only show available slots to the user.

### Orders

```bash
spesa esselunga orders --json --limit <n>
```

Returns `data: Order[]` with `id`, `date`, `status`, `total`.

## Autonomous Workflows

### "Buy groceries" / "Fai la spesa"

When the user gives you a grocery list:

```
1. spesa esselunga status --json           → verify session
2. For each item in the list:
   a. spesa esselunga search "<item>" --json --limit 5
   b. Pick the best match (see picking rules above)
   c. spesa esselunga cart add "<best-match-url>" --json
3. spesa esselunga cart list --json         → get final cart
4. Report: what was added, total price, any items not found
```

Do NOT ask "should I add this?" between items. Add them all, then report.

### "What's in my cart?" / "Cosa c'è nel carrello?"

```
1. spesa esselunga status --json
2. spesa esselunga cart list --json
3. Report items, quantities, and total
```

### "When can I get delivery?" / "Quando posso ricevere la spesa?"

```
1. spesa esselunga status --json
2. spesa esselunga slots --json
3. Filter to available:true only
4. Report available slots grouped by date
```

### "Remove X from cart" / "Togli X dal carrello"

```
1. spesa esselunga cart list --json        → find the item's ID
2. spesa esselunga cart remove <id> --json
3. Confirm removal
```

## Error Recovery

| Error | Action |
|-------|--------|
| `Not logged in` | Tell user to run login command. Stop. |
| `Session expired` | Tell user to re-login. Stop. |
| `Cannot reach spesaonline.esselunga.it` | Tell user: "Esselunga is unreachable. Check your VPN (needs Italian IP)." Stop. |
| `Cart is empty` (on slots) | Tell user to add items first. |
| `Add to cart button not found` | Retry once. If still failing, try the product URL instead of query. |
| `No results` + delivery address error | Tell user to set delivery address via browser. |
| Any other error | Report the error message to the user. Do not retry more than once. |

## Setup (one-time, for skill installation)

```bash
cd /path/to/spesa
bun install
bunx playwright install webkit
bun run build
export PATH="$PWD/dist:$PATH"
```

Password can be passed via `-p` flag or `SPESA_PASSWORD` environment variable.
