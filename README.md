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
| `spesa esselunga buy QUERY` | Search + pick + add to cart in one step (`--pick cheapest/first/exact`, `-q` for qty) |
| `spesa esselunga cart list` | Show cart contents |
| `spesa esselunga cart add URL_OR_QUERY` | Add product to cart (`-q` for quantity) |
| `spesa esselunga cart remove ID` | Remove product from cart |
| `spesa esselunga checkout` | Show cart + delivery slots in one step |
| `spesa esselunga slots` | Show delivery time slots |
| `spesa esselunga orders` | List past orders (`-n` for limit) |

All commands accept `--json` for structured output and `-y`/`--yes` for non-interactive mode.

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

## OpenClaw Skill

spesa is also an [OpenClaw](https://clawhub.ai) agent skill. Any AI coding agent that supports OpenClaw can use it to order groceries on your behalf.

### Install as a skill

```bash
# Via ClawHub CLI
npx clawhub@latest install spesa

# Or manually: copy into your skills directory
git clone https://github.com/prodigalson/spesa.git ~/.openclaw/skills/spesa
cd ~/.openclaw/skills/spesa && bun install && bunx playwright install webkit && bun run build
```

### For Claude Code

```bash
# Add to your project's skills
cp -r /path/to/spesa .claude/skills/spesa
```

The `SKILL.md` frontmatter tells the agent when to activate:

```yaml
name: spesa
description: Order groceries online in Italy via Esselunga...
metadata:
  openclaw:
    requires:
      bins: [bun]
    emoji: "🛒"
```

The agent will invoke spesa when you say things like "order groceries", "add milk to my Esselunga cart", or "check delivery slots". All commands support `--json` for structured agent consumption.

### Agent workflow example

```bash
# OLD: 5 commands, 5 approval prompts
# spesa esselunga status --json
# spesa esselunga search "mozzarella di bufala" --json --limit 5
# spesa esselunga cart add <url-from-search> --json
# spesa esselunga cart list --json
# spesa esselunga slots --json

# NEW: 3 commands with compound operations
spesa esselunga status --json --yes              # 1. check session
spesa esselunga buy "mozzarella di bufala" --json --yes  # 2. search + pick + add
spesa esselunga checkout --json --yes            # 3. cart + slots
```

---

## Development

```bash
# Run directly without building
bun run dev

# Type check
bun run typecheck

# Run a specific command
bun run src/index.ts esselunga search "latte" --json
```

---

## In italiano

### Cos'è spesa?

**spesa** è uno strumento da riga di comando per fare la spesa online in Italia. Al momento supporta **Esselunga** (spesaonline.esselunga.it).

Puoi cercare prodotti, gestire il carrello, controllare le fasce orarie di consegna e visualizzare gli ordini, tutto dal terminale. Funziona anche come strumento per agenti AI grazie alla modalità `--json`.

### Requisiti

- **macOS** (testato su Apple Silicon)
- **[Bun](https://bun.sh)** v1.3+
- **Un indirizzo IP italiano** (funziona anche con VPN)
- **Un account Esselunga** con indirizzo di consegna già impostato

### Installazione rapida

```bash
# 1. Clona il repository
git clone https://github.com/prodigalson/spesa.git
cd spesa

# 2. Installa le dipendenze
bun install

# 3. Installa il browser WebKit (motore Safari)
bunx playwright install webkit

# 4. Compila il CLI
bun run build

# 5. Aggiungi al PATH (opzionale)
export PATH="$PWD/dist:$PATH"
```

### Come si usa

```bash
# Accedi (si apre una finestra del browser per l'autenticazione)
spesa esselunga login -u tua@email.com -p latuapassword

# Cerca prodotti
spesa esselunga search "pasta barilla"

# Aggiungi al carrello
spesa esselunga cart add "spaghetti barilla"

# Visualizza il carrello
spesa esselunga cart list

# Controlla le fasce orarie di consegna
spesa esselunga slots

# Rimuovi dal carrello
spesa esselunga cart remove <id-prodotto>

# Visualizza ordini passati
spesa esselunga orders
```

Tutti i comandi supportano `--json` per output strutturato.

### Come funziona

Esselunga non ha un'API pubblica. Questo CLI usa **Playwright** con **WebKit** (motore Safari) per automatizzare il sito web. WebKit è necessario perché il WAF di Esselunga blocca i browser basati su Chromium.

---

## License

MIT
