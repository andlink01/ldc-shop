import { dbExecRaw, dbRun } from './index'
import { sql } from 'drizzle-orm'
import { getErrorText } from '@/lib/errors'

export const INVENTORY_FEATURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS inventory_api_keys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL, token_encrypted TEXT,
    product_ids TEXT NOT NULL DEFAULT '[]', can_read INTEGER NOT NULL DEFAULT 1, can_write INTEGER NOT NULL DEFAULT 1,
    is_enabled INTEGER NOT NULL DEFAULT 1, expires_at INTEGER, created_at INTEGER NOT NULL,
    last_used_at INTEGER, created_by TEXT
);
CREATE TABLE IF NOT EXISTS inventory_api_requests (
    id TEXT PRIMARY KEY, key_id TEXT REFERENCES inventory_api_keys(id) ON DELETE SET NULL,
    action TEXT NOT NULL, product_id TEXT, method TEXT NOT NULL, status INTEGER NOT NULL,
    added_count INTEGER NOT NULL DEFAULT 0, replayed INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT,
    error TEXT, duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_deliveries (
    order_id TEXT PRIMARY KEY REFERENCES orders(order_id) ON DELETE CASCADE, attempt_id TEXT NOT NULL UNIQUE,
    card_ids TEXT NOT NULL, card_key TEXT NOT NULL, is_shared INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_events (
    event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, order_id TEXT REFERENCES orders(order_id) ON DELETE CASCADE,
    product_id TEXT, data TEXT, telegram_sent INTEGER NOT NULL DEFAULT 0, bark_sent INTEGER NOT NULL DEFAULT 0,
    email_sent INTEGER NOT NULL DEFAULT 0, replenish_attempted INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT, lease_until INTEGER, next_attempt_at INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, error TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inventory_api_requests_created_idx ON inventory_api_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_events_due_idx ON inventory_events(completed_at, next_attempt_at, lease_until);
CREATE INDEX IF NOT EXISTS cards_product_expiry_idx ON cards(product_id, is_used, expires_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS cards_supplier_request_idx ON cards(supplier_request_id) WHERE supplier_request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS supplier_requests (
    request_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
    item_index INTEGER NOT NULL, server_url TEXT NOT NULL, card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
    state TEXT NOT NULL DEFAULT 'pending', lease_token TEXT, lease_until INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL,
    UNIQUE(order_id, item_index)
);
`

export async function ensureInventoryFeatureTables() {
    await dbExecRaw(INVENTORY_FEATURE_SCHEMA)
    const columns = await dbRun<{ name: string }>(sql`PRAGMA table_info(inventory_api_keys)`)
    if (!columns.results.some(column => column.name === 'token_encrypted')) {
        try { await dbExecRaw('ALTER TABLE inventory_api_keys ADD COLUMN token_encrypted TEXT;') }
        catch (error) { if (!getErrorText(error).toLowerCase().includes('duplicate column')) throw error }
    }
}
