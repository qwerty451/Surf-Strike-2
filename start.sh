#!/usr/bin/env bash
# Start the public game host: game server + Cloudflare quick tunnel + discovery
# registration with the deployed Vercel site (docs/architecture.md#start-up-flow).
# Wraps `pnpm host` with preflight checks. Ctrl+C stops it and clears discovery.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

ENV_FILE="apps/server/.env"
DEFAULT_DB="apps/server/data/surf.db"

usage() {
	cat <<'EOF'
Usage: ./start.sh [--port <n>] [--db <path>] [-h|--help]

Starts the public Surf Strike 2 host (`pnpm host`): game server, Cloudflare
quick tunnel, and registration of the tunnel URL with the Vercel site
(DISCOVERY_URL in apps/server/.env). Ctrl+C stops the host and clears the
published URL.

Options:
  --port <n>    Game server port (overrides PORT in apps/server/.env; default 27015)
  --db <path>   SQLite file (DB_PATH; default apps/server/data/surf.db, the
                persistent production leaderboard)
  -h, --help    Show this help and exit
EOF
}

die() {
	echo "start.sh: $*" >&2
	exit 1
}

# Value of KEY from the .env file (last assignment wins, surrounding quotes stripped).
# Only used for non-secret keys; HOST_SECRET is checked for presence, never read out.
env_value() {
	local line
	line=$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 || true)
	line=${line#*=}
	line=${line%$'\r'}
	line=${line%\"}
	line=${line#\"}
	line=${line%\'}
	line=${line#\'}
	printf '%s' "$line"
}

port_arg=""
db_arg=""
while [[ $# -gt 0 ]]; do
	case "$1" in
	--port)
		[[ $# -ge 2 ]] || die "--port needs a value"
		port_arg=$2
		shift 2
		;;
	--port=*)
		port_arg=${1#*=}
		shift
		;;
	--db)
		[[ $# -ge 2 ]] || die "--db needs a value"
		db_arg=$2
		shift 2
		;;
	--db=*)
		db_arg=${1#*=}
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage >&2
		die "unknown argument: $1"
		;;
	esac
done

# --- Node 24 via fnm -------------------------------------------------------
if command -v fnm >/dev/null 2>&1; then
	eval "$(fnm env --shell bash)"
	if ! fnm use --silent-if-unchanged >/dev/null 2>&1; then
		fnm use 24 >/dev/null 2>&1 || true
	fi
fi
command -v node >/dev/null 2>&1 || die "Node not found. Install Node 24 (e.g. 'fnm install 24')."
node_major=$(node -p 'process.versions.node.split(".")[0]')
if ((node_major < 22)); then
	die "Node $(node -v) is too old; need Node >= 22 (24 recommended, see .node-version). Run 'fnm install 24'."
fi
# pnpm may only exist as another Node version's corepack shim; fall back to this Node's corepack.
if command -v pnpm >/dev/null 2>&1; then
	PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
	PNPM=(corepack pnpm)
else
	die "pnpm not found. Run 'corepack enable' (Node $(node -v))."
fi

# --- Config ----------------------------------------------------------------
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found. Copy apps/server/.env.example to $ENV_FILE and fill in HOST_SECRET and DISCOVERY_URL."
grep -Eq '^[[:space:]]*HOST_SECRET=["'\'']?[^[:space:]"'\'']' "$ENV_FILE" ||
	die "HOST_SECRET is not set in $ENV_FILE (see apps/server/.env.example)."
discovery_url=$(env_value DISCOVERY_URL)
[[ -n "$discovery_url" ]] || die "DISCOVERY_URL is not set in $ENV_FILE (see apps/server/.env.example)."
discovery_url=${discovery_url%/}

port=${port_arg:-${PORT:-$(env_value PORT)}}
port=${port:-27015}
if ! [[ "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
	die "invalid port: $port"
fi
export PORT=$port

if [[ -n "$db_arg" ]]; then
	# Absolute path: the server runs from apps/server, so a relative path would shift.
	mkdir -p "$(dirname "$db_arg")"
	DB_PATH="$(cd "$(dirname "$db_arg")" && pwd)/$(basename "$db_arg")"
	export DB_PATH
fi
db_shown=${DB_PATH:-$(env_value DB_PATH)}
db_shown=${db_shown:-$DEFAULT_DB}

# Refuse to run locally if a fixed self-hosted server is configured and healthy.
fixed_url=${FIXED_SERVER_URL:-$(env_value FIXED_SERVER_URL)}
fixed_url=${fixed_url%/}
if [[ -n "$fixed_url" ]] && command -v curl >/dev/null 2>&1; then
	if curl -fsS --max-time 3 "$fixed_url/health" 2>/dev/null | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
		die "fixed self-hosted server is already live at $fixed_url; refusing to overwrite discovery."
	fi
fi

# --- cloudflared -----------------------------------------------------------
if [[ -n "${CLOUDFLARED:-}" ]]; then
	[[ -x "$CLOUDFLARED" ]] || command -v "$CLOUDFLARED" >/dev/null 2>&1 || die "CLOUDFLARED=$CLOUDFLARED is not executable."
elif [[ -n "$(env_value CLOUDFLARED)" ]]; then
	cf=$(env_value CLOUDFLARED)
	[[ -x "$cf" ]] || command -v "$cf" >/dev/null 2>&1 || die "CLOUDFLARED=$cf (from $ENV_FILE) is not executable."
elif [[ ! -x "$HOME/.local/bin/cloudflared" ]] && ! command -v cloudflared >/dev/null 2>&1; then
	die "cloudflared not found (looked in \$CLOUDFLARED, ~/.local/bin/cloudflared, PATH). Install it or set CLOUDFLARED."
fi

# --- Dependencies ----------------------------------------------------------
if [[ ! -d node_modules || ! -d apps/server/node_modules ]]; then
	echo "start.sh: installing dependencies (pnpm install --frozen-lockfile)"
	"${PNPM[@]}" install --frozen-lockfile
fi

# --- Port free? ------------------------------------------------------------
holder=""
if command -v ss >/dev/null 2>&1; then
	holder=$(ss -Hltnp "sport = :$port" 2>/dev/null || true)
elif command -v lsof >/dev/null 2>&1; then
	holder=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
fi
if [[ -n "$holder" ]]; then
	echo "start.sh: port $port is already in use:" >&2
	if command -v lsof >/dev/null 2>&1; then
		pids=$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u || true)
		for pid in $pids; do
			args=$(ps -o args= -p "$pid" 2>/dev/null || true)
			((${#args} <= 160)) || args="...${args: -157}"
			echo "  pid $pid: $args" >&2
		done
		[[ -n "$pids" ]] || echo "$holder" | sed 's/^/  /' >&2
	else
		echo "$holder" | sed 's/^/  /' >&2
	fi
	die "stop that process (e.g. a local 'pnpm server' dev game server) or pick another port with --port <n>."
fi

# --- Go --------------------------------------------------------------------
cat <<EOF
Surf Strike 2 public host
  site:  $discovery_url
  port:  $port
  db:    $db_shown
  node:  $(node -v)
Ctrl+C to stop (clears the published server URL).

EOF
exec "${PNPM[@]}" host
