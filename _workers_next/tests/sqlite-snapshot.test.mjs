import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fixture } from './database-fixture.mjs'

const require = createRequire(import.meta.url)

test('SQLite backup reads keep one snapshot while another process commits a sale', async t => {
    const f = fixture(t)
    await f.ready
    assert.equal(f.isDocker, true)
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '1' })
    await f.db.insert(f.schema.cards).values({ productId: 'product', cardKey: 'SNAPSHOT-CARD' })
    await f.db.insert(f.schema.orders).values({ orderId: 'order', productId: 'product', productName: 'Product', amount: '1', status: 'paid' })
    const cardQuery = f.db.select().from(f.schema.cards)
    const originalAll = cardQuery.all.bind(cardQuery)
    cardQuery.all = () => {
        const rows = originalAll()
        execFileSync(process.execPath, ['-e', `
            const Database = require(process.argv[1]);
            const db = new Database(process.argv[2]);
            db.pragma('journal_mode = WAL');
            db.transaction(()=>{
                db.prepare("UPDATE cards SET is_used = 1, used_at = 1000").run();
                db.prepare("UPDATE orders SET status = 'delivered', delivered_at = 1000, card_ids = '1', card_key = 'SNAPSHOT-CARD'").run();
            }).immediate();
            db.close();
        `, require.resolve('better-sqlite3'), f.env.DATABASE_PATH], { timeout: 10000, windowsHide: true, stdio: 'pipe' })
        return rows
    }
    const [cards, orders] = await f.db.batch([cardQuery, f.db.select().from(f.schema.orders)])
    assert.equal(cards[0].isUsed, false)
    assert.equal(orders[0].status, 'paid')
    assert.equal((await f.db.select().from(f.schema.cards))[0].isUsed, true)
    assert.equal((await f.db.select().from(f.schema.orders))[0].status, 'delivered')
})
