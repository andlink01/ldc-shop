import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';
import { PHASE_PRODUCTION_BUILD, PHASE_EXPORT } from 'next/constants';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import type { RawResult, SqlStatement } from './contracts';

let sqliteInstance: Database.Database;

const BUILD_TIME_SCHEMA = `
    CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, price TEXT NOT NULL,
        compare_at_price TEXT, max_points_discount TEXT, category TEXT, image TEXT, is_hot INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1, is_shared INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0,
        purchase_limit INTEGER, purchase_warning TEXT, visibility_level INTEGER DEFAULT -1,
        stock_count INTEGER DEFAULT 0, locked_count INTEGER DEFAULT 0, sold_count INTEGER DEFAULT 0,
        rating INTEGER DEFAULT 0, review_count INTEGER DEFAULT 0, created_at INTEGER,
        variant_group_id TEXT, variant_label TEXT, purchase_questions TEXT, product_images TEXT
    );
    CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, card_key TEXT NOT NULL,
        is_used INTEGER DEFAULT 0, reserved_order_id TEXT, reserved_at INTEGER,
        expires_at INTEGER, used_at INTEGER, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, product_name TEXT NOT NULL,
        amount TEXT NOT NULL, email TEXT, payee TEXT, status TEXT DEFAULT 'pending',
        trade_no TEXT, card_key TEXT, card_ids TEXT, paid_at INTEGER, delivered_at INTEGER,
        user_id TEXT, username TEXT, points_used INTEGER DEFAULT 0, quantity INTEGER DEFAULT 1,
        current_payment_id TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS login_users (
        user_id TEXT PRIMARY KEY, username TEXT, email TEXT, points INTEGER DEFAULT 0,
        is_blocked INTEGER DEFAULT 0, desktop_notifications_enabled INTEGER DEFAULT 0,
        created_at INTEGER, last_login_at INTEGER, last_checkin_at INTEGER,
        consecutive_days INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS daily_checkins_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT,
        sort_order INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, order_id TEXT NOT NULL,
        user_id TEXT NOT NULL, username TEXT NOT NULL, rating INTEGER NOT NULL,
        comment TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS review_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT, review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, username TEXT NOT NULL, comment TEXT NOT NULL, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS inventory_imports (
        idempotency_key TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        payload_hash TEXT NOT NULL, imported_count INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS refund_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, user_id TEXT,
        username TEXT, reason TEXT, status TEXT DEFAULT 'pending', admin_username TEXT,
        admin_note TEXT, created_at INTEGER, updated_at INTEGER, processed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS user_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, type TEXT NOT NULL,
        title_key TEXT NOT NULL, content_key TEXT NOT NULL, data TEXT,
        is_read INTEGER DEFAULT 0, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS admin_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT NOT NULL, target_value TEXT,
        title TEXT NOT NULL, body TEXT NOT NULL, sender TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS user_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT,
        title TEXT NOT NULL, body TEXT NOT NULL, is_read INTEGER DEFAULT 0, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS broadcast_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
        sender TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS broadcast_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL,
        user_id TEXT NOT NULL, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS wishlist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT,
        user_id TEXT, username TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS wishlist_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
        user_id TEXT NOT NULL, created_at INTEGER
    );
`;

function createDb() {
    const phase = process.env.NEXT_PHASE;
    if (phase === PHASE_PRODUCTION_BUILD || phase === PHASE_EXPORT) {
        sqliteInstance = new Database(':memory:');
        sqliteInstance.exec(BUILD_TIME_SCHEMA);
        return drizzle(sqliteInstance, { schema });
    }

    const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'ldc-shop.sqlite');
    const dir = path.dirname(dbPath);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    sqliteInstance = new Database(dbPath);
    sqliteInstance.pragma('journal_mode = WAL');
    sqliteInstance.pragma('foreign_keys = ON');
    return drizzle(sqliteInstance, { schema });
}

export const db = createDb();

/**
 * Execute raw SQL that may contain multiple statements.
 * better-sqlite3's db.run()/prepare() only accepts a single statement,
 * but .exec() supports multiple statements separated by semicolons.
 */
export async function dbExecRaw(sqlStr: string): Promise<void> {
    sqliteInstance.exec(sqlStr);
}

const dialect = new SQLiteSyncDialect();

export async function dbRun<T = Record<string, unknown>>(query: SQL): Promise<RawResult<T>> {
    const compiled = dialect.sqlToQuery(query);
    const statement = sqliteInstance.prepare(compiled.sql);
    if (statement.reader) {
        return { results: statement.all(...compiled.params) as T[] };
    }
    const result = statement.run(...compiled.params);
    return { results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
}

export async function dbBatchRaw(statements: SqlStatement[]): Promise<void> {
    sqliteInstance.transaction(() => {
        for (const { sql, params } of statements) sqliteInstance.prepare(sql).run(...params);
    }).immediate();
}
