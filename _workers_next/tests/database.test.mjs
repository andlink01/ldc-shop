import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { fixture } from './database-fixture.mjs';

test('fresh schema initializes all business tables and raw SQL returns rows', async (t) => {
    const f = fixture(t);
    await f.ready;
    const tables = await f.dbRun(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
    for (const name of ['products', 'cards', 'orders', 'review_replies', 'inventory_imports', 'wishlist_votes']) {
        assert.ok(tables.results.some((table) => table.name === name), name);
    }
    assert.equal(await f.queries.getSetting('schema_version'), '22');
    await f.db.insert(f.schema.products).values({ id: 'stable', name: 'Stable', price: '1' });
    await f.db.insert(f.schema.cards).values({ productId: 'stable', cardKey: 'test' });
    const returning = await f.dbRun(sql`UPDATE cards SET reserved_order_id = 'order' WHERE product_id = 'stable' RETURNING id, card_key`);
    assert.equal(returning.results[0].card_key, 'test');
});

test('schema v19 upgrades without changing product IDs, cards or orders', async (t) => {
    const f = fixture(t, { initialize: false });
    await f.dbExecRaw(`
        CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, price TEXT NOT NULL, category TEXT, image TEXT, is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, purchase_limit INTEGER, created_at INTEGER);
        CREATE TABLE cards (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, card_key TEXT NOT NULL, is_used INTEGER DEFAULT 0, used_at INTEGER, created_at INTEGER);
        CREATE TABLE orders (order_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, product_name TEXT NOT NULL, amount TEXT NOT NULL, email TEXT, status TEXT, trade_no TEXT, card_key TEXT, paid_at INTEGER, delivered_at INTEGER, user_id TEXT, username TEXT, payee TEXT, quantity INTEGER DEFAULT 1, created_at INTEGER);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
        CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, order_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL, rating INTEGER NOT NULL, comment TEXT, created_at INTEGER);
        INSERT INTO settings (key, value) VALUES ('schema_version', '19');
        INSERT INTO products (id, name, price) VALUES ('invitationcode', 'Invitation', '1.00');
        INSERT INTO cards (product_id, card_key) VALUES ('invitationcode', 'sddssssss');
        INSERT INTO orders (order_id, product_id, product_name, amount, status) VALUES ('existing-order', 'invitationcode', 'Invitation', '1.00', 'pending');
    `);
    await f.queries.ensureDatabaseInitialized();
    assert.equal(await f.queries.getSetting('schema_version'), '22');
    assert.equal((await f.db.select().from(f.schema.products))[0].id, 'invitationcode');
    assert.equal((await f.db.select().from(f.schema.cards))[0].cardKey, 'sddssssss');
    assert.equal((await f.db.select().from(f.schema.orders))[0].orderId, 'existing-order');
    await f.db.select().from(f.schema.reviewReplies);
    await f.db.select().from(f.schema.inventoryImports);
});

test('schema v21 adds import receipts and preserves existing records', async (t) => {
    const legacy = fixture(t, { initialize: false });
    await legacy.dbExecRaw(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
        CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price TEXT NOT NULL, created_at INTEGER);
        INSERT INTO settings (key, value) VALUES ('schema_version', '21');
        INSERT INTO products (id, name, price) VALUES ('stable', 'Stable', '1');
    `);
    await legacy.queries.ensureDatabaseInitialized();
    assert.equal(await legacy.queries.getSetting('schema_version'), '22');
    assert.equal((await legacy.dbRun(sql`SELECT id FROM products`)).results[0].id, 'stable');
    assert.deepEqual((await legacy.db.select().from(legacy.schema.inventoryImports)), []);
});
