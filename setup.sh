#!/usr/bin/env bash
# setup.sh – one-time install for the Klootschieten API
set -e

echo "=== Klootschieten API – Setup ==="
echo ""

# Check Node.js >= 18
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is niet geïnstalleerd. Installeer Node.js >= 18."
  exit 1
fi

MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 vereist (gevonden: $(node -v))"
  exit 1
fi
echo "Node.js $(node -v) ✓"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Create data directory
mkdir -p data

# Init package.json if absent
if [ ! -f package.json ]; then
  npm init -y --quiet
fi

echo ""
echo "npm packages installeren..."
npm install

echo ""
echo "Playwright Chromium installeren..."
npx playwright install chromium --with-deps

echo ""
echo "=== Setup klaar! ==="
echo ""
echo "Eerste scrape uitvoeren:"
echo "  node src/jobs/scrape.js"
echo ""
echo "API server starten:"
echo "  node src/server.js"
echo ""
echo "Met automatisch scrapen bij opstarten:"
echo "  SCRAPE_ON_START=true node src/server.js"
echo ""
echo "Omgevingsvariabelen (optioneel):"
echo "  PORT=3000               HTTP poort"
echo "  DB_PATH=./data/matches.db  SQLite bestand"
echo "  SCRAPE_API_KEY=geheim   Beschermt POST /api/v1/scrape"
echo "  SCRAPE_CRON='0 23 * * 0'  Cron schema (standaard: zondag 23:00)"
echo "  SCRAPE_ON_START=true    Scrape direct bij opstarten"
