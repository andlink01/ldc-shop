import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql, eq } from 'drizzle-orm';
import { fixture, API_KEY } from './database-fixture.mjs';

const context = (id = 'invitationcode') => ({ params: Promise.resolve({ productId: id }) });
function request(body, { key = API_KEY, idempotencyKey = 'request-1', headers = {} } = {}) {
    return new Request('https://shop.example/api/v1/products/invitationcode/cards', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Idempotency-Key': idempotencyKey, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}
async function setup(t, options) {
    const f = fixture(t, options);
    await f.ready;
    await f.db.insert(f.schema.products).values({ id: 'invitationcode', name: 'Invitation', price: '1.00' });
    return { ...f, ...f.load('lib/inventory-api') };
}

test('API is disabled without configuration; bad tokens never initialize storage', async (t) => {
    for (const [configured, supplied, status] of [['', API_KEY, 503], [API_KEY, 'wrong', 401]]) {
        const f = fixture(t, { initialize: false, env: { INVENTORY_API_KEY: configured } });
        const response = await f.load('lib/inventory-api').addInventoryCards(request({ cards: ['sddssssss'] }, { key: supplied }), context());
        assert.equal(response.status, status);
        const tables = await f.dbRun(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
        assert.equal(tables.results.length, 0);
    }
});

test('fixed route imports card with 22h30 expiry and updates visible stock', async (t) => {
    const f = await setup(t);
    const route = f.load('app/api/v1/products/[productId]/cards/route');
    const start = Date.now();
    const response = await route.POST(request({ cards: ['sddssssss'], expiresInSeconds: 81000 }), context());
    assert.equal(response.status, 201);
    assert.equal((await response.json()).data.added, 1);
    const [card] = await f.db.select().from(f.schema.cards);
    assert.equal(card.cardKey, 'sddssssss');
    assert.ok(card.expiresAt.getTime() >= start + 81_000_000);
    assert.ok(card.expiresAt.getTime() <= Date.now() + 81_000_000);
    const stock = await route.GET(new Request('https://shop.example', { headers: { Authorization: `Bearer ${API_KEY}` } }), context());
    assert.deepEqual((await stock.json()).data.stock, { unused: 1, available: 1, locked: 0 });
    assert.ok(f.invalidations.includes('/buy/invitationcode'));
    assert.ok(f.invalidations.includes('home:products'));
});

test('retries preserve relative expiry and import once; conflicting reuse returns 409', async (t) => {
    const f = await setup(t);
    const payload = { cards: ['sddssssss'], expiresInSeconds: 81000 };
    const first = await f.addInventoryCards(request(payload), context());
    assert.equal(first.status, 201);
    const expiry = (await f.db.select().from(f.schema.cards))[0].expiresAt.getTime();
    const retry = await f.addInventoryCards(request(payload), context());
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).data.replayed, true);
    const conflict = await f.addInventoryCards(request({ cards: ['changed'] }), context());
    assert.equal(conflict.status, 409);
    const rows = await f.db.select().from(f.schema.cards);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].expiresAt.getTime(), expiry);
    assert.equal((await f.db.select().from(f.schema.products))[0].stockCount, 1);
});

test('500-card import stays within D1 bind limit and receipts persist across handler reloads', async (t) => {
    const f = await setup(t);
    const payload = { cards: Array.from({ length: 500 }, (_, i) => `card-${i}`) };
    assert.equal((await f.addInventoryCards(request(payload), context())).status, 201);
    assert.equal((await f.db.select().from(f.schema.cards)).length, 500);
    assert.equal((await f.db.select().from(f.schema.inventoryImports)).length, 1);
    assert.equal((await f.db.select().from(f.schema.products))[0].stockCount, 500);
    const reloaded = f.reload('lib/inventory-api');
    assert.equal((await reloaded.addInventoryCards(request(payload), context())).status, 200);
    assert.equal((await f.db.select().from(f.schema.cards)).length, 500);
});

test('concurrent identical requests commit stock once', async (t) => {
    const f = await setup(t);
    const payload = { cards: ['concurrent'] };
    const responses = await Promise.all(Array.from({ length: 4 }, () => f.addInventoryCards(request(payload), context())));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 200, 200, 201]);
    assert.equal((await f.db.select().from(f.schema.cards)).length, 1);
    assert.equal((await f.db.select().from(f.schema.products))[0].stockCount, 1);
});

test('a mid-batch storage failure rolls back receipt, cards, and stock and can be retried', async (t) => {
    const f = await setup(t);
    await f.dbRun(sql.raw("CREATE TRIGGER fail_card BEFORE INSERT ON cards WHEN NEW.card_key = 'bad' BEGIN SELECT RAISE(ABORT, 'test failure'); END;"));
    const payload = { cards: [...Array.from({ length: 20 }, (_, i) => `card-${i}`), 'bad'] };
    const failed = await f.addInventoryCards(request(payload), context());
    assert.equal(failed.status, 500);
    assert.equal((await f.db.select().from(f.schema.cards)).length, 0);
    assert.equal((await f.db.select().from(f.schema.inventoryImports)).length, 0);
    assert.equal((await f.db.select().from(f.schema.products))[0].stockCount, 0);
    await f.dbRun(sql`DROP TRIGGER fail_card`);
    assert.equal((await f.addInventoryCards(request(payload), context())).status, 201);
});

test('invalid input, unknown products, and expired timestamps leave stock untouched', async (t) => {
    const f = await setup(t);
    const inputs = [
        ['[]', 400], ['{', 400], [{ cards: [] }, 400], [{ cards: [42] }, 400], [{ cards: [''] }, 400],
        [{ cards: Array(501).fill('card') }, 400], [{ cards: ['card'], expiresInSeconds: -1 }, 400],
        [{ cards: ['card'], expiresAt: '2000-01-01T00:00:00Z' }, 400],
        [{ cards: ['card'], expiresAt: '2099-02-30T00:00:00Z' }, 400],
        [{ cards: ['card'], expiresAt: '2099-01-01T00:00:00Z', expiresInSeconds: 60 }, 400],
    ];
    for (const [body, status] of inputs) assert.equal((await f.addInventoryCards(request(body), context())).status, status);
    assert.equal((await f.addInventoryCards(request({ cards: ['card'] }, { headers: { 'Content-Type': 'text/plain' } }), context())).status, 415);
    assert.equal((await f.addInventoryCards(request('x'.repeat(256 * 1024 + 1)), context())).status, 413);
    assert.equal((await f.addInventoryCards(request({ cards: ['card'] }), context('missing'))).status, 404);
    assert.equal((await f.addInventoryCards(request({ cards: ['card'] }), context('../bad'))).status, 400);
    assert.equal((await f.db.select().from(f.schema.cards)).length, 0);
});

test('product pagination reports live available, reserved, and expired stock without card values', async (t) => {
    const f = await setup(t);
    await f.db.insert(f.schema.products).values({ id: 'another', name: 'Other', price: '2.00' });
    await f.db.insert(f.schema.cards).values([
        { productId: 'invitationcode', cardKey: 'secret-free' },
        { productId: 'invitationcode', cardKey: 'secret-reserved', reservedOrderId: 'order', reservedAt: new Date() },
        { productId: 'invitationcode', cardKey: 'secret-expired', expiresAt: new Date(Date.now() - 1000) },
    ]);
    const read = async (url) => {
        const response = await f.listInventoryProducts(new Request(url, { headers: { Authorization: `Bearer ${API_KEY}` } }));
        assert.equal(response.headers.get('cache-control'), 'no-store');
        return response.json();
    };
    const first = await read('https://shop.example/api/v1/products?limit=1');
    assert.equal(first.data.products[0].id, 'another');
    assert.equal(first.data.nextCursor, 'another');
    const second = await read('https://shop.example/api/v1/products?limit=1&cursor=another');
    assert.equal(second.data.nextCursor, null);
    assert.deepEqual(second.data.products[0].stock, { unused: 2, available: 1, locked: 1 });
    assert.doesNotMatch(JSON.stringify(second), /secret-/);
    await f.db.delete(f.schema.products).where(eq(f.schema.products.id, 'another'));
});

test('200-product inventory query stays within D1 binding limits', async (t) => {
    const f = await setup(t);
    for (let i = 0; i < 199; i++) {
        await f.db.insert(f.schema.products).values({ id: `product-${i}`, name: `Product ${i}`, price: '1' });
    }
    const response = await f.listInventoryProducts(new Request('https://shop.example/api/v1/products?limit=200', { headers: { Authorization: `Bearer ${API_KEY}` } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.products.length, 200);
});

test('imports recalculate available stock and keep shared-product infinite stock behavior', async (t) => {
    const f = await setup(t);
    await f.db.insert(f.schema.cards).values([
        { productId: 'invitationcode', cardKey: 'reserved', reservedAt: new Date(), reservedOrderId: 'order' },
        { productId: 'invitationcode', cardKey: 'expired', expiresAt: new Date(Date.now() - 1000) },
    ]);
    await f.addInventoryCards(request({ cards: ['available'] }), context());
    const [finite] = await f.db.select().from(f.schema.products);
    assert.equal(finite.stockCount, 1);
    assert.equal(finite.lockedCount, 1);
    await f.db.insert(f.schema.products).values({ id: 'shared', name: 'Shared', price: '1', isShared: true });
    assert.equal((await f.addInventoryCards(request({ cards: ['shared-key'] }, { idempotencyKey: 'shared-batch' }), context('shared'))).status, 201);
    const [shared] = await f.db.select().from(f.schema.products).where(eq(f.schema.products.id, 'shared'));
    const infinite = f.load('lib/constants').INFINITE_STOCK;
    assert.equal(shared.stockCount, infinite);
});
