import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { fixture } from './database-fixture.mjs'

async function setup(t) {
    const f = fixture(t)
    await f.ready
    await f.queries.setSetting('bark_enabled', 'true')
    await f.queries.setSetting('bark_device_key', 'TEST-DEVICE-KEY')
    await f.queries.setSetting('bark_server_url', 'https://api.day.app')
    return { ...f, ...f.load('lib/notifications'), ...f.load('lib/inventory-events') }
}

test('Bark uses POST JSON, avoids key/data-logo URLs and keeps escaped payloads within budget', async t => {
    const f = await setup(t)
    await f.queries.setSetting('shop_logo', 'data:image/png;base64,' + 'a'.repeat(80000))
    await f.queries.setSetting('shop_logo_source', 'custom')
    let seen
    f.setFetch(async (url, options) => { seen = { url, options, body: JSON.parse(options.body) }; return Response.json({ code: 200 }) })
    assert.equal((await f.sendBarkMessage('标题'.repeat(300), '😀"\n'.repeat(2000), { url: 'https://shop.example/order/' + 'a'.repeat(900), group: 'Orders' })).success, true)
    assert.equal(seen.url, 'https://api.day.app/push')
    assert.equal(seen.options.method, 'POST')
    assert.equal(seen.options.redirect, 'error')
    assert.equal(seen.body.device_key, 'TEST-DEVICE-KEY')
    assert.ok(!seen.body.icon.startsWith('data:'))
    assert.ok(new TextEncoder().encode(seen.options.body).length <= 3500)
    assert.ok(!seen.url.includes('TEST-DEVICE-KEY'))
})

test('Bark reports HTTP 520, rejected responses and network failures as failures', async t => {
    const f = await setup(t)
    f.setFetch(async () => new Response('PRIVATE-ERROR', { status: 520 }))
    const failed = await f.sendBarkMessage('Title', 'Body')
    assert.equal(failed.success, false)
    assert.match(failed.error, /520/)
    assert.ok(!failed.error.includes('PRIVATE-ERROR'))
    f.setFetch(async () => Response.json({ code: 400, message: 'TEST-DEVICE-KEY' }))
    assert.equal((await f.sendBarkMessage('Title', 'Body')).success, false)
    f.setFetch(async () => { throw new Error('TEST-DEVICE-KEY') })
    assert.ok(!(await f.sendBarkMessage('Title', 'Body')).error.includes('TEST-DEVICE-KEY'))
})

test('Bark supports a custom server path and rejects credentials or unsafe URLs', async t => {
    const f = await setup(t)
    await f.queries.setSetting('bark_server_url', 'https://bark.example/base/')
    f.setFetch(async url => { assert.equal(url, 'https://bark.example/base/push'); return Response.json({ code: 200 }) })
    assert.equal((await f.sendBarkMessage('Title', 'Body')).success, true)
    await f.queries.setSetting('bark_server_url', 'https://user:password@bark.example')
    f.setFetch(() => assert.fail('Unsafe URL must not be fetched'))
    assert.equal((await f.sendBarkMessage('Title', 'Body')).success, false)
})

test('notification retries preserve successful channels and completed events stay completed', async t => {
    const f = await setup(t)
    await f.queries.setSetting('telegram_enabled', 'true')
    await f.queries.setSetting('telegram_bot_token', 'TEST-BOT')
    await f.queries.setSetting('telegram_chat_id', 'TEST-CHAT')
    await f.db.insert(f.schema.orders).values({ orderId: 'order', productId: 'payment_link', productName: 'Product <one>', amount: '1', status: 'paid' })
    await f.load('lib/fulfillment').queuePaymentNotification('order')
    let telegram = 0, bark = 0
    f.setFetch(async (url, options) => {
        if (url.includes('api.telegram.org')) { telegram++; assert.ok(JSON.parse(options.body).text.includes('&lt;one&gt;')); return Response.json({ ok: true }) }
        bark++; return bark === 1 ? new Response(null, { status: 520 }) : Response.json({ code: 200 })
    })
    await f.processInventoryEvents()
    await f.dbRun(sql`UPDATE inventory_events SET next_attempt_at = 0`)
    await f.processInventoryEvents()
    await f.processInventoryEvents()
    assert.equal(telegram, 1)
    assert.equal(bark, 2)
    assert.ok((await f.db.select().from(f.schema.inventoryEvents))[0].completedAt)
})

test('concurrent event workers send an event only once while its lease is active', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.orders).values({ orderId: 'order', productId: 'payment_link', productName: 'Product', amount: '1', status: 'paid' })
    await f.load('lib/fulfillment').queuePaymentNotification('order')
    let release, started, calls = 0
    const requested = new Promise(resolve => { started = resolve })
    f.setFetch(async () => { calls++; started(); await new Promise(resolve => { release = resolve }); return Response.json({ code: 200 }) })
    const first = f.processInventoryEvents()
    await requested
    await f.processInventoryEvents()
    release(); await first
    assert.equal(calls, 1)
})

test('expiry alerts deduplicate each product hourly, exclude used/expired cards and can be disabled', async t => {
    const f = await setup(t)
    await f.db.insert(f.schema.products).values({ id: 'product', name: 'Product', price: '1' })
    await f.db.insert(f.schema.cards).values([
        { productId: 'product', cardKey: 'PRIVATE-SOON', expiresAt: new Date(Date.now() + 300000) },
        { productId: 'product', cardKey: 'expired', expiresAt: new Date(0) },
        { productId: 'product', cardKey: 'used', expiresAt: new Date(Date.now() + 300000), isUsed: true },
    ])
    assert.equal((await f.enqueueExpiryAlerts()).queued, 1)
    assert.equal((await f.enqueueExpiryAlerts()).queued, 0)
    const event = (await f.db.select().from(f.schema.inventoryEvents))[0]
    assert.equal(JSON.parse(event.data).count, 1)
    assert.ok(!event.data.includes('PRIVATE-SOON'))
    await f.queries.setSetting('expiry_alert_minutes', '0')
    assert.equal((await f.enqueueExpiryAlerts()).queued, 0)
})

test('delivery emails escape card/product HTML and use stable Resend idempotency', async t => {
    const f = await setup(t)
    for (const [key, value] of Object.entries({ resend_enabled: 'true', resend_api_key: 'TEST-RESEND', resend_from_email: 'shop@example.com' })) await f.queries.setSetting(key, value)
    f.setFetch(async (url, options) => {
        assert.equal(url, 'https://api.resend.com/emails')
        assert.equal(options.headers['Idempotency-Key'], 'delivery:order')
        const html = JSON.parse(options.body).html
        assert.ok(html.includes('&lt;private&gt;'))
        assert.ok(!html.includes('<private>'))
        return Response.json({ id: 'email' })
    })
    assert.equal((await f.load('lib/email').sendOrderEmail({ to: 'buyer@example.com', orderId: 'order', productName: '<product>', cardKeys: '<private>', idempotencyKey: 'delivery:order' })).success, true)
})
