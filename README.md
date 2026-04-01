# spesa

CLI for ordering groceries online in Italy. Currently supports **Esselunga** (spesaonline.esselunga.it).

Search products, manage your cart, check delivery slots, and view orders ... all from the terminal or as a tool for AI agents.

## Requirements

- **macOS** (tested on Apple Silicon)
- **[Bun](https://bun.sh)** v1.3+ runtime
- **An Italian IP address** (VPN works). Esselunga blocks non-Italian IPs.
- **An Esselunga account** with a delivery address already set

## Install

```bash
# 1. Clone the repo
git clone https://github.com/prodigalson/spesa.git
cd spesa

# 2. Install dependencies
bun install

# 3. Install Playwright's WebKit browser engine
bunx playwright install webkit

# 4. Build the CLI wrapper
bun run build

# 5. Add to PATH (optional)
export PATH="$PWD/dist:$PATH"
# Or add to your shell profile:
# echo 'export PATH="/path/to/spesa/dist:$PATH"' >> ~/.zshrc
```

After install, run `spesa --help` to verify:

```
Usage: spesa [options] [command]

CLI for ordering groceries online in Italy

Options:
  -V, --version   output the version number
  --json          Output as JSON (for agent use)
  -h, --help      display help for command

Commands:
  esselunga|e     Interact with Esselunga online grocery
  help [command]  display help for command
```

## Quick Start

### 1. Log in

```bash
spesa esselunga login -u your@email.com -p yourpassword
```

This opens a visible browser window (WebKit/Safari). If Esselunga asks for MFA/OTP, complete it in the browser, then press Enter in the terminal.

Session is saved to `~/.spesa/sessions/esselunga.json` and lasts about 12 hours.

### 2. Search for products

```bash
spesa esselunga search "pasta barilla"
```

```
┌──────────────┬──────────────────────────────────────────┬───────┬────────────┬───────────┐
│ ID           │ Name                                     │ Brand │ Price (€)  │ Available │
├──────────────┼──────────────────────────────────────────┼───────┼────────────┼───────────┤
│ 114052       │ Barilla Pasta Spaghetti n.5 1Kg          │       │ 1.85       │ ✓         │
│ 114081       │ Barilla Pasta Spaghetti n.5 500g         │       │ 0.99       │ ✓         │
│ ...          │ ...                                      │       │ ...        │ ...       │
└──────────────┴──────────────────────────────────────────┴───────┴────────────┴───────────┘
```

### 3. Add to cart

```bash
# By search query (adds first result)
spesa esselunga cart add "spaghetti barilla"

# By product URL (from search results)
spesa esselunga cart add https://spesaonline.esselunga.it/commerce/nav/supermercato/store/prodotto/114052/barilla-pasta-spaghetti-n5-1kg
```

### 4. View your cart

```bash
spesa esselunga cart list
```

### 5. Check delivery slots

```bash
spesa esselunga slots
```

Shows available delivery windows for the next 7 days with 2-hour time ranges.

### 6. Remove from cart

```bash
spesa esselunga cart remove <product-id>
```

## JSON Mode (for AI agents)

Every command supports `--json` for structured output:

```bash
spesa esselunga search "mozzarella" --json --limit 3
```

```json
{
  "ok": true,
  "data": [
    {
      "id": "123456",
      "name": "Mozzarella di Bufala Campana DOP 125g",
      "price": 1.99,
      "pricePerUnit": "15,92 €/kg",
      "url": "https://spesaonline.esselunga.it/...",
      "imageUrl": "https://images.services.esselunga.it/...",
      "available": true
    }
  ]
}
```

Errors return `{ "ok": false, "error": "..." }` with exit code 1.

## All Commands

| Command | Description |
|---------|-------------|
| `spesa esselunga login -u EMAIL -p PASS` | Log in (opens browser for MFA) |
| `spesa esselunga logout` | Clear saved session |
| `spesa esselunga status` | Check if session is valid |
| `spesa esselunga search QUERY` | Search products (`-n` for max results) |
| `spesa esselunga cart list` | Show cart contents |
| `spesa esselunga cart add URL_OR_QUERY` | Add product to cart (`-q` for quantity) |
| `spesa esselunga cart remove ID` | Remove product from cart |
| `spesa esselunga slots` | Show delivery time slots |
| `spesa esselunga orders` | List past orders (`-n` for limit) |

All commands accept `--json` for structured output.

## How It Works

Esselunga has no public API. This CLI uses **Playwright** with **WebKit** (Safari engine) to automate the Esselunga AngularJS web app:

- **WebKit, not Chromium.** Esselunga's WAF blocks Playwright's Chromium. WebKit with a real Safari user-agent gets through.
- **Direct URL navigation.** Instead of clicking through the slow SPA, we navigate directly to search URLs, the cart page (`/checkout/trolley`), and the orders page (`/ordini/precedenti`).
- **DOM scraping.** Product cards use `div.product[id]` with AngularJS bindings. Cart items use `div.esselunga-checkout-trolley-container`. Delivery slots use a `button.slot-button` grid with `disponibile`/`esaurita` CSS classes.
- **API interception.** When available, we intercept XHR/fetch responses for product JSON before falling back to DOM scraping.
- **Cookie persistence.** Sessions are saved as Playwright cookies to `~/.spesa/sessions/` and restored on each command.

## Troubleshooting

**"Cannot reach spesaonline.esselunga.it"**
Your IP might be blocked by Esselunga's WAF. Use a VPN with an Italian IP, or wait 30-60 minutes.

**"Not logged in"**
Run `spesa esselunga login -u ... -p ...` again. Sessions expire after ~12 hours.

**"No results. You need to set a delivery address first"**
Log in via the browser (`spesa esselunga login`), and set your delivery address in the Esselunga UI before searching.

**"Add to cart button not found"**
Occasionally the SPA takes longer than 8 seconds to load. Just retry the command.

**Login hangs or times out**
Make sure you're on an Italian IP. Esselunga blocks international traffic entirely.

## Development

```bash
# Run directly without building
bun run dev

# Type check
bun run typecheck

# Run a specific command
bun run src/index.ts esselunga search "latte" --json
```

## License

MIT
