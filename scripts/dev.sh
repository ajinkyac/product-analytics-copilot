#!/usr/bin/env bash
# dev.sh — Start all local development services
# Usage: bash scripts/dev.sh
#        ./scripts/dev.sh --skip-db   (skip docker compose up)
#        ./scripts/dev.sh --api-only

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── Color helpers ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[dev]${NC}  $*"; }
success() { echo -e "${GREEN}[dev]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[dev]${NC}  $*"; }
error()   { echo -e "${RED}[dev]${NC}  $*" >&2; }

# ── Argument parsing ───────────────────────────────────────────────────────────
SKIP_DB=false
API_ONLY=false
WEB_ONLY=false

for arg in "$@"; do
  case $arg in
    --skip-db)   SKIP_DB=true ;;
    --api-only)  API_ONLY=true ;;
    --web-only)  WEB_ONLY=true ;;
    --help|-h)
      echo "Usage: $0 [--skip-db] [--api-only] [--web-only]"
      exit 0
      ;;
  esac
done

# ── Check prerequisites ────────────────────────────────────────────────────────
check_command() {
  if ! command -v "$1" &>/dev/null; then
    error "Required command not found: $1"
    error "Please install $1 and try again."
    exit 1
  fi
}

check_command node
check_command pnpm

if [[ "$SKIP_DB" == "false" ]]; then
  check_command docker
fi

# ── Check Node version ─────────────────────────────────────────────────────────
NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_VERSION" -lt 20 ]]; then
  error "Node.js 20+ required. Current: $(node --version)"
  exit 1
fi

# ── Check .env ─────────────────────────────────────────────────────────────────
if [[ ! -f ".env" ]]; then
  warn ".env not found — copying from .env.example"
  cp .env.example .env
  warn "Please edit .env and set OPENAI_API_KEY and JWT_SECRET before continuing."
  warn "Then re-run: bash scripts/dev.sh"
  exit 1
fi

# Check for required env vars
source .env
if [[ -z "${OPENAI_API_KEY:-}" ]] || [[ "$OPENAI_API_KEY" == "sk-..." ]]; then
  warn "OPENAI_API_KEY not set in .env — AI features will return errors."
fi
if [[ -z "${JWT_SECRET:-}" ]] || [[ "$JWT_SECRET" == *"change-me"* ]]; then
  warn "JWT_SECRET not set in .env — using insecure default for development."
fi

# ── Start PostgreSQL ───────────────────────────────────────────────────────────
if [[ "$SKIP_DB" == "false" ]] && [[ "$WEB_ONLY" == "false" ]]; then
  info "Starting PostgreSQL via Docker Compose..."
  docker compose up -d postgres

  info "Waiting for PostgreSQL to be ready..."
  for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U copilot -d copilot_dev &>/dev/null; then
      success "PostgreSQL is ready."
      break
    fi
    if [[ $i -eq 30 ]]; then
      error "PostgreSQL did not become ready in time."
      exit 1
    fi
    sleep 1
  done

  # Run migrations if needed
  info "Checking for pending migrations..."
  pnpm --filter api db:migrate 2>&1 | tail -5
fi

# ── Create DuckDB data directory ───────────────────────────────────────────────
mkdir -p data/seed

# ── Cleanup handler ────────────────────────────────────────────────────────────
PIDS=()

cleanup() {
  echo ""
  info "Shutting down dev services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  success "All services stopped."
}

trap cleanup EXIT INT TERM

# ── Start services ─────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  Product Analytics Copilot — Development Mode${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [[ "$WEB_ONLY" == "false" ]]; then
  info "Starting API server on http://localhost:3001 ..."
  pnpm --filter api dev &
  PIDS+=($!)
fi

if [[ "$API_ONLY" == "false" ]]; then
  # Give the API a moment to start before the web app opens
  sleep 2
  info "Starting Web app on http://localhost:5173 ..."
  pnpm --filter web dev &
  PIDS+=($!)
fi

echo ""
echo -e "${GREEN}Services running:${NC}"
[[ "$WEB_ONLY" == "false" ]]  && echo -e "  API  →  ${CYAN}http://localhost:3001${NC}"
[[ "$API_ONLY" == "false" ]]  && echo -e "  Web  →  ${CYAN}http://localhost:5173${NC}"
echo ""
echo -e "  Press ${YELLOW}Ctrl+C${NC} to stop all services."
echo ""

# Wait for all background processes
wait "${PIDS[@]}"
