#!/bin/sh

echo "Starting LDC Shop (Docker)..."

if [ "$AUTH_SECRET" = "replace_with_a_random_secret_string" ] || [ "$NEXTAUTH_SECRET" = "replace_with_a_random_secret_string" ]; then
    echo "ERROR: AUTH_SECRET is still set to the example placeholder 'replace_with_a_random_secret_string'."
    echo "Please generate a strong random secret before starting the container."
    exit 1
fi

# Auto-set AUTH_URL from APP_URL so NextAuth uses the correct external origin
# (Docker sets HOSTNAME=0.0.0.0 which would make NextAuth generate wrong callback URLs)
if [ -z "$AUTH_URL" ] && [ -n "$APP_URL" ]; then
    export AUTH_URL="$APP_URL"
    echo "AUTH_URL auto-set to $APP_URL"
fi

# Ensure data directory exists and is writable
mkdir -p /app/data 2>/dev/null || true
if [ ! -w /app/data ]; then
    echo "WARNING: /app/data is not writable, SQLite may fail."
    echo "Fix: ensure the host volume directory is writable (chmod 777 ./data)"
fi

# The application performs the versioned, idempotent upgrade on its first request.
# This preserves existing data and avoids an interactive drizzle-kit prompt at startup.
echo "Database upgrades will run on the first application request."

# Start the cron job in background
echo "Starting cron scheduler..."
node cron.mjs &

# Start the Next.js server
echo "Starting Next.js server..."
exec node server.js
