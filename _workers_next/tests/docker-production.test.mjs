import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dockerProductionFixture, nativeMerchantKey } from './docker-production-fixture.mjs'

async function setup(t, options) {
    const f = await dockerProductionFixture(t, options)
    await f.database.prepare('INSERT INTO products (id,name,price) VALUES (?,?,?)').bind('product', 'Native product', '3').run()
    await f.database.prepare('INSERT INTO login_users (user_id,username,points) VALUES (?,?,?)').bind('owner', 'audit-admin', 20).run()
    return { ...f, sessionCookie: await f.cookie() }
}

async function pay(f, id, money = '3.00') {
    const params = { out_trade_no: id, trade_no: 'native-trade-' + id, trade_status: 'TRADE_SUCCESS', money }
    const sorted = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&')
    const response = await f.request(`/api/notify?${new URLSearchParams({ ...params, sign_type: 'MD5', sign: createHash('md5').update(sorted + nativeMerchantKey).digest('hex') })}`)
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal(await response.text(), 'success')
}

async function purchase(f, { product = 'product', points = false } = {}) {
    const created = await f.action('createOrder', '/buy/' + product, [product, 1, '', points], f.sessionCookie)
    assert.equal(created.result?.success, true, created.body)
    const id = created.result.params.out_trade_no
    await pay(f, id, created.result.params.money)
    return id
}

async function refundPurchase(f) {
    await f.database.prepare('UPDATE products SET price = ?, max_points_discount = ? WHERE id = ?').bind('5', '2', 'product').run()
    await f.database.prepare('INSERT INTO cards (product_id,card_key) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM cards WHERE product_id = ? AND is_used = 0)')
        .bind('product', 'NATIVE-REFUND-CARD', 'product').run()
    return purchase(f, { points: true })
}

test('native production routes authenticate, deliver once and protect cards from another account', async t => {
    const f = await setup(t)
    t.diagnostic(`Runtime: ${f.mode}`)
    const session = await f.request('/api/auth/session', { headers: { Cookie: f.sessionCookie } })
    assert.equal((await session.json()).user.id, 'owner')
    for (const page of ['/', '/admin/inventory-api', '/admin/fulfillment', '/admin/cards/product']) {
        const response = await f.request(page, { headers: { Cookie: f.sessionCookie } })
        assert.equal(response.status, 200, page)
        const html = await response.text()
        assert.ok(!html.includes('NEXT_HTTP_ERROR_FALLBACK'), page)
        if (page === '/') {
            const asset = /(?:src|href)="(\/_next\/static\/[^"?]+[^" ]*)"/.exec(html)?.[1]
            assert.ok(asset, 'The page must reference its compiled static assets')
            const staticResponse = await f.request(asset.replaceAll('&amp;', '&'))
            assert.equal(staticResponse.status, 200, asset)
            assert.ok((await staticResponse.arrayBuffer()).byteLength > 0)
        }
    }
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'PRIVATE-NATIVE-DELIVERY').run()
    const created = await f.action('createOrder', '/buy/product', ['product', 1, '', false], f.sessionCookie)
    assert.equal(created.result?.success, true, created.body)
    const id = created.result.params.out_trade_no
    await Promise.all(Array.from({ length: 3 }, () => pay(f, id)))
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM order_deliveries').bind().all()).results[0].count, 1)
    for (const cookie of ['', await f.cookie('other', 'other-user')]) {
        const response = await f.request('/order/' + id, { headers: { Cookie: cookie + '; ldc_pending_order=' + id } })
        assert.ok(!(await response.text()).includes('PRIVATE-NATIVE-DELIVERY'))
    }
    assert.ok((await (await f.request('/order/' + id, { headers: { Cookie: f.sessionCookie } })).text()).includes('PRIVATE-NATIVE-DELIVERY'))
})

test('native Linux DO OAuth creates and persists the buyer through real authentication routes', async t => {
    let challenge, tokenCalls = 0, profileCalls = 0
    // NextRequest normalizes numeric loopback hosts to localhost.
    let authOrigin
    const f = await setup(t, { provider: async request => {
        const url = new URL(request.url)
        if (url.hostname !== 'connect.linux.do') return undefined
        if (url.pathname === '/oauth2/token') {
            tokenCalls++
            const body = new URLSearchParams(await request.text())
            assert.equal(body.get('code'), 'isolated-native-linuxdo-code')
            assert.equal(body.get('redirect_uri'), authOrigin + '/api/auth/callback/linuxdo')
            assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenge)
            return Response.json({ access_token: 'isolated-native-linuxdo-access', token_type: 'Bearer', expires_in: 3600 })
        }
        if (url.pathname === '/api/user') {
            profileCalls++
            assert.equal(request.headers.get('authorization'), 'Bearer isolated-native-linuxdo-access')
            return Response.json({ id: 789, username: 'native-linuxdo-user', name: 'Linux DO Test', trust_level: 2 })
        }
        assert.fail(`Unexpected OAuth request: ${url.pathname}`)
    } })
    authOrigin = f.baseUrl.replace('127.0.0.1', 'localhost')
    const jar = new Map()
    const remember = response => {
        for (const value of response.headers.getSetCookie()) {
            const pair = value.split(';')[0], index = pair.indexOf('=')
            jar.set(pair.slice(0, index), pair.slice(index + 1))
        }
    }
    const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const csrf = await f.request('/api/auth/csrf')
    remember(csrf)
    const { csrfToken } = await csrf.json()
    assert.ok(csrfToken)
    const signin = await f.request('/api/auth/signin/linuxdo', { method: 'POST', headers: { Cookie: cookie(),
        'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' },
        body: new URLSearchParams({ csrfToken, callbackUrl: authOrigin + '/buy/product?from=login' }), redirect: 'manual' })
    remember(signin)
    const authorization = new URL((await signin.json()).url)
    assert.equal(authorization.origin, 'https://connect.linux.do')
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorization.searchParams.get('redirect_uri'), authOrigin + '/api/auth/callback/linuxdo')
    challenge = authorization.searchParams.get('code_challenge')
    const callback = await f.request('/api/auth/callback/linuxdo?code=isolated-native-linuxdo-code', { headers: { Cookie: cookie() }, redirect: 'manual' })
    remember(callback)
    await callback.text()
    assert.equal(callback.status, 302, f.logs())
    assert.equal(callback.headers.get('location'), authOrigin + '/buy/product?from=login', f.logs())
    const session = await (await f.request('/api/auth/session', { headers: { Cookie: cookie() } })).json()
    assert.equal(session.user.id, '789')
    assert.equal(session.user.username, 'native-linuxdo-user')
    assert.equal(session.user.trustLevel, 2)
    // The header records the user when the browser follows the OAuth return URL.
    const returnedPage = await f.request('/buy/product?from=login', { headers: { Cookie: cookie() } })
    assert.equal(returnedPage.status, 200, f.logs())
    await returnedPage.text()
    const persisted = (await f.database.prepare('SELECT username,last_login_at FROM login_users WHERE user_id = ?').bind('789').all()).results[0]
    assert.ok(persisted, f.logs())
    assert.equal(persisted.username, 'native-linuxdo-user')
    assert.ok(persisted.last_login_at > 0)
    assert.equal(tokenCalls, 1)
    assert.equal(profileCalls, 1)
})

test('native checkout and question verification enforce trust and keep every variant answer private', async t => {
    const f = await setup(t)
    const questions = JSON.stringify([{ q: 'Question?', a: 'PRIVATE-NATIVE-ANSWER' }])
    await f.database.prepare('UPDATE products SET visibility_level = ?, purchase_questions = ?, variant_group_id = ? WHERE id = ?').bind(2, questions, 'group', 'product').run()
    await f.database.prepare('INSERT INTO products (id,name,price,variant_group_id,purchase_questions) VALUES (?,?,?,?,?)')
        .bind('variant', 'Other variant', '3', 'group', JSON.stringify([{ q: 'Variant question?', a: 'PRIVATE-VARIANT-ANSWER' }])).run()
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'NATIVE-QUESTION-CARD').run()
    for (const headers of [{ Cookie: f.sessionCookie }, { Cookie: f.sessionCookie, RSC: '1' }]) {
        const page = await f.request('/buy/product', { headers })
        const html = await page.text()
        assert.equal(page.status, 200)
        assert.ok(html.includes('Question?') && html.includes('Variant question?'))
        assert.ok(!html.includes('PRIVATE-NATIVE-ANSWER') && !html.includes('PRIVATE-VARIANT-ANSWER'))
    }
    const low = await f.cookie('owner', 'audit-admin', 1)
    for (const [name, args] of [['createOrder', ['product', 1, '', true, ['PRIVATE-NATIVE-ANSWER']]], ['verifyPurchaseAnswers', ['product', ['PRIVATE-NATIVE-ANSWER']]]]) {
        const denied = await f.action(name, '/buy/product', args, low)
        assert.equal(denied.result?.error, 'buy.visibilityDenied', denied.body)
    }
    for (const answers of [[{}], ['wrong']]) {
        const denied = await f.action('createOrder', '/buy/product', ['product', 1, '', false, answers], f.sessionCookie)
        assert.equal(denied.result?.success, false, denied.body)
    }
    assert.equal((await f.action('verifyPurchaseAnswers', '/buy/product', ['product', [' private-native-answer ']], f.sessionCookie)).result?.success, true)
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM orders').bind().all()).results[0].count, 0)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 20)
    assert.equal((await f.database.prepare('SELECT reserved_order_id FROM cards').bind().all()).results[0].reserved_order_id, null)
    const accepted = await f.action('createOrder', '/buy/product', ['product', 1, '', false, ['PRIVATE-NATIVE-ANSWER']], f.sessionCookie)
    assert.equal(accepted.result?.success, true, accepted.body)
})

test('native automatic GET stock rejects a sold value and concurrent duplicate responses', async t => {
    let cardKey = 'USED-NATIVE-CARD'
    const f = await setup(t, { provider: request => new URL(request.url).hostname === 'supplier.example' ? Response.json({ cardKey }) : undefined })
    await f.database.prepare('INSERT INTO cards (product_id,card_key,is_used) VALUES (?,?,1)').bind('product', cardKey).run()
    assert.equal((await f.action('saveCardsApiConfig', '/admin/cards/product', ['product', 'https://supplier.example/cards', '', true, 'stock'], f.sessionCookie)).result?.success, true)
    assert.equal((await f.action('pullCardFromApi', '/admin/cards/product', ['product'], f.sessionCookie)).result?.error, 'api_card_duplicate')
    cardKey = 'NEW-NATIVE-CARD'
    const responses = await Promise.all(Array.from({ length: 3 }, () => f.action('pullCardFromApi', '/admin/cards/product', ['product'], f.sessionCookie)))
    assert.equal(responses.filter(response => response.result?.success).length, 1)
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM cards WHERE card_key = ?').bind(cardKey).all()).results[0].count, 1)
})

test('native SQL backup and multipart restore retain issued cards and prevent a second sale', async t => {
    const f = await setup(t)
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'NATIVE-BACKUP-CARD').run()
    const id = await purchase(f)
    const response = await f.request('/admin/data/download?type=full&format=sql', { headers: { Cookie: f.sessionCookie } })
    const dump = await response.text()
    assert.equal(response.status, 200, dump)
    const restored = await setup(t)
    await restored.database.prepare('DELETE FROM products').bind().run()
    const form = new FormData()
    form.set('file', new File([dump], 'native-backup.sql', { type: 'application/sql' }))
    const imported = await restored.action('importData', '/admin/data', [form], restored.sessionCookie)
    assert.equal(imported.result?.success, true, imported.body)
    assert.equal(imported.result?.errors, 0)
    assert.equal((await restored.database.prepare('SELECT status FROM orders WHERE order_id = ?').bind(id).all()).results[0].status, 'delivered')
    assert.equal((await restored.database.prepare('SELECT is_used FROM cards').bind().all()).results[0].is_used, 1)
    assert.equal((await restored.action('createOrder', '/buy/product', ['product', 1, '', false], restored.sessionCookie)).result?.error, 'buy.outOfStock')
    assert.equal((await restored.database.prepare('SELECT count(*) AS count FROM order_deliveries').bind().all()).results[0].count, 1)
})

test('native refunds submit once concurrently and recover an accepted refund after a local rollback', async t => {
    let refunds = 0
    const f = await setup(t, { provider: async request => {
        if (new URL(request.url).hostname !== 'credit.linux.do') return undefined
        refunds++
        assert.equal(request.method, 'POST')
        assert.equal((await request.formData()).get('money'), '3.00')
        await new Promise(resolve => setTimeout(resolve, 100))
        return Response.json({ code: 1 })
    } })
    const id = await refundPurchase(f)
    const responses = await Promise.all(Array.from({ length: 3 }, () => f.action('proxyRefund', '/admin/orders/' + id, [id], f.sessionCookie)))
    assert.ok(responses.some(response => response.result?.processed))
    assert.equal(refunds, 1)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 20)
    const second = await refundPurchase(f)
    await f.database.prepare("CREATE TRIGGER fail_refund BEFORE UPDATE ON orders WHEN NEW.status = 'refunded' BEGIN SELECT RAISE(ABORT, 'isolated failure'); END;").bind().run()
    assert.equal((await f.action('proxyRefund', '/admin/orders/' + second, [second], f.sessionCookie)).result?.needsVerification, true)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 18)
    await f.database.prepare('DROP TRIGGER fail_refund').bind().run()
    await f.restart()
    assert.equal((await f.action('proxyRefund', '/admin/orders/' + second, [second], f.sessionCookie)).result?.processed, true)
    assert.equal(refunds, 2)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 20)
})

test('native refunds recover a lost response by trade ID and require review before resubmission', async t => {
    let refunds = 0, status = 0, accepted = false
    const f = await setup(t, { provider: async request => {
        const url = new URL(request.url)
        if (url.hostname !== 'credit.linux.do') return undefined
        if (request.method === 'POST') { refunds++; return accepted ? Response.json({ code: 1 }) : new Response(null, { status: 503 }) }
        const trade = url.searchParams.get('trade_no')
        assert.ok(trade?.startsWith('native-trade-'))
        return Response.json({ code: 1, status, trade_no: trade, out_trade_no: trade.slice('native-trade-'.length) + '_retry123' })
    } })
    const id = await refundPurchase(f)
    assert.equal((await f.action('proxyRefund', '/admin/orders/' + id, [id], f.sessionCookie)).result?.needsVerification, true)
    assert.equal((await f.action('proxyRefund', '/admin/orders/' + id, [id], f.sessionCookie)).result?.processed, true)
    assert.equal(refunds, 1)
    status = 1
    const second = await refundPurchase(f)
    const refund = confirm => f.action('proxyRefund', '/admin/orders/' + second, [second, confirm], f.sessionCookie)
    assert.equal((await refund(false)).result?.needsVerification, true)
    assert.equal((await refund(true)).result?.needsVerification, true)
    assert.equal(refunds, 2)
    assert.equal((await f.action('verifyOrderRefundStatus', '/admin/orders/' + second, [second], f.sessionCookie)).result?.needsReview, true)
    assert.equal((await refund(false)).result?.needsReview, true)
    accepted = true
    assert.equal((await refund(true)).result?.processed, true)
    assert.equal(refunds, 3)
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 20)
})

test('native encrypted inventory keys and payment-triggered procurement operate through real routes', async t => {
    let purchases = 0
    const f = await setup(t, { provider: async request => {
        if (new URL(request.url).hostname !== 'supplier.example') return undefined
        purchases++
        const body = await request.json()
        assert.equal(body.requestId, request.headers.get('idempotency-key'))
        return Response.json({ success: true, requestId: body.requestId, data: { cardKey: 'NATIVE-SUPPLIED-CARD' } })
    } })
    const created = await f.action('createInventoryKey', '/admin/inventory-api', [{ name: 'Tool', productIds: ['product'], canRead: true, canWrite: true, expiresAt: null }], f.sessionCookie)
    assert.equal(created.result?.success, true, created.body)
    const key = (await f.database.prepare('SELECT id,token_encrypted FROM inventory_api_keys').bind().all()).results[0]
    assert.ok(!key.token_encrypted.includes(created.result.token))
    assert.equal((await f.action('viewInventoryKey', '/admin/inventory-api', [key.id], f.sessionCookie)).result?.token, created.result.token)
    const reset = await f.action('resetInventoryKey', '/admin/inventory-api', [key.id], f.sessionCookie)
    assert.equal(reset.result?.success, true)
    const revoked = await f.request('/api/v1/products', { headers: { Authorization: 'Bearer ' + created.result.token } })
    assert.equal(revoked.status, 401); await revoked.text()
    const imported = await f.request('/api/v1/products/product/cards', { method: 'POST', headers: { Authorization: 'Bearer ' + reset.result.token, 'Content-Type': 'application/json', 'Idempotency-Key': 'native-batch' }, body: JSON.stringify({ cards: ['NATIVE-IMPORTED-CARD'] }) })
    assert.equal(imported.status, 201); await imported.text()
    assert.equal((await f.action('deleteInventoryKey', '/admin/inventory-api', [key.id], f.sessionCookie)).result?.success, true)
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM inventory_imports').bind().all()).results[0].count, 1)
    await f.database.prepare('INSERT INTO products (id,name,price) VALUES (?,?,?)').bind('on-demand', 'Supplier product', '3').run()
    assert.equal((await f.action('saveCardsApiConfig', '/admin/cards/on-demand', ['on-demand', 'https://supplier.example/cards', '', true, 'on_demand'], f.sessionCookie)).result?.success, true)
    assert.equal(purchases, 0)
    const order = await f.action('createOrder', '/buy/on-demand', ['on-demand', 1, '', false], f.sessionCookie)
    assert.equal(order.result?.success, true, order.body)
    assert.equal(purchases, 0)
    const id = order.result.params.out_trade_no
    await Promise.all(Array.from({ length: 3 }, () => pay(f, id)))
    let row
    for (let i = 0; i < 40; i++) {
        row = (await f.database.prepare('SELECT status,card_key FROM orders WHERE order_id = ?').bind(id).all()).results[0]
        if (row.status === 'delivered') break
        await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.equal(row.status, 'delivered', f.logs())
    assert.equal(row.card_key, 'NATIVE-SUPPLIED-CARD')
    assert.equal(purchases, 1)
})

test('native startup upgrades a v22 volume, preserves archived data and rotates missing-stock recovery', async t => {
    const expires = Date.now() + 3600000
    const f = await dockerProductionFixture(t, { legacySql: `
        ${readFileSync(new URL('./legacy-docker-v22.sql', import.meta.url), 'utf8')}
        INSERT INTO settings (key,value) VALUES ('schema_version','22');
        INSERT INTO products (id,name,price) VALUES ('product','Archived product','3'),('a-unavailable','Unavailable','3');
        INSERT INTO login_users (user_id,username,points) VALUES ('owner','audit-admin',17);
        INSERT INTO cards (id,product_id,card_key,is_used,expires_at) VALUES (1,'product','ARCHIVED-NATIVE-CARD',1,${expires});
        INSERT INTO orders (order_id,product_id,product_name,amount,status,card_key,card_ids,user_id,username) VALUES ('archived','product','Archived product','3','delivered','ARCHIVED-NATIVE-CARD','1','owner','audit-admin');
        INSERT INTO inventory_imports VALUES ('archived-import','product','old-hash',1,${Date.now()});
    ` })
    assert.equal((await f.database.prepare('SELECT value FROM settings WHERE key = ?').bind('schema_version').all()).results[0].value, '25')
    const archived = (await f.database.prepare('SELECT is_used,expires_at,card_key FROM cards WHERE id = 1').bind().all()).results[0]
    assert.equal(archived.is_used, 1)
    assert.equal(archived.expires_at, expires)
    assert.equal(archived.card_key, 'ARCHIVED-NATIVE-CARD')
    assert.equal((await f.database.prepare('SELECT points FROM login_users WHERE user_id = ?').bind('owner').all()).results[0].points, 17)
    assert.equal((await f.database.prepare('SELECT idempotency_key FROM inventory_imports').bind().all()).results[0].idempotency_key, 'archived-import')
    for (let i = 0; i < 50; i++) await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,paid_at) VALUES (?,?,?,?,?,?,?)').bind('old-' + i, 'a-unavailable', 'Unavailable', '3', 'paid', 'owner', 1).run()
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'NATIVE-RECOVERY-CARD').run()
    await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,paid_at) VALUES (?,?,?,?,?,?,?)').bind('ready', 'product', 'Archived product', '3', 'paid', 'owner', Date.now()).run()
    const cleanup = async () => {
        const response = await f.request('/api/internal/cron/cleanup', { method: 'POST', headers: { 'X-Cron-Cleanup-Token': 'native-test-cron' } })
        assert.equal(response.status, 200, await response.clone().text())
        return response.json()
    }
    assert.equal((await cleanup()).fulfillment.delivered, 0)
    assert.equal((await cleanup()).fulfillment.delivered, 1)
    assert.equal((await f.database.prepare('SELECT status FROM orders WHERE order_id = ?').bind('ready').all()).results[0].status, 'delivered')
    assert.equal((await f.database.prepare("SELECT count(*) AS count FROM orders WHERE status = 'paid'").bind().all()).results[0].count, 50)
})

test('native cron delivers a full reservation behind 50 missing-stock orders without reallocating FIFO stock', async t => {
    const f = await setup(t)
    for (let i = 0; i < 50; i++) await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,quantity,user_id,paid_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind('old-' + String(i).padStart(2, '0'), 'product', 'Native product', '3', 'paid', 3, 'owner', 1).run()
    await f.database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,quantity,user_id,paid_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind('reserved', 'product', 'Native product', '3', 'paid', 2, 'owner', 2).run()
    for (const cardKey of ['RESERVED-ONE', 'RESERVED-TWO']) await f.database.prepare('INSERT INTO cards (product_id,card_key,reserved_order_id,reserved_at) VALUES (?,?,?,?)')
        .bind('product', cardKey, 'reserved', 1).run()
    await f.database.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'OLDER-STOCK').run()
    const response = await f.request('/api/internal/cron/cleanup', { method: 'POST', headers: { 'X-Cron-Cleanup-Token': 'native-test-cron' } })
    assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await response.json()).fulfillment.delivered, 1)
    assert.equal((await f.database.prepare('SELECT card_key FROM orders WHERE order_id = ?').bind('reserved').all()).results[0].card_key, 'RESERVED-ONE\nRESERVED-TWO')
    assert.equal((await f.database.prepare('SELECT reserved_order_id FROM cards WHERE card_key = ?').bind('OLDER-STOCK').all()).results[0].reserved_order_id, 'old-00')
    assert.equal((await f.database.prepare('SELECT count(*) AS count FROM order_deliveries').bind().all()).results[0].count, 1)
    assert.equal((await f.database.prepare("SELECT count(*) AS count FROM orders WHERE status = 'paid'").bind().all()).results[0].count, 50)
})

test('native admin pages never stream private data to anonymous or non-admin requests', async t => {
    const f = await setup(t)
    const d = f.database, now = Date.now()
    await d.prepare('UPDATE products SET name = ?, is_active = 0, visibility_level = 3, purchase_questions = ? WHERE id = ?')
        .bind('MARK-HIDDEN-PRODUCT', JSON.stringify([{ q: 'Q?', a: 'MARK-ANSWER' }]), 'product').run()
    await d.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,username,email,card_key,trade_no,paid_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind('MARK-ORDER', 'product', 'P', '3', 'delivered', 'owner', 'audit-admin', 'mark-buyer@private.example', 'MARK-CARD-KEY', 'MARK-TRADE', now, now).run()
    await d.prepare('INSERT INTO cards (product_id,card_key) VALUES (?,?)').bind('product', 'MARK-UNSOLD-CARD').run()
    await d.prepare('INSERT INTO refund_requests (order_id,user_id,username,reason,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind('MARK-ORDER', 'owner', 'audit-admin', 'MARK-REFUND-REASON', 'pending', now, now).run()
    await d.prepare('INSERT INTO user_messages (user_id,username,title,body,created_at) VALUES (?,?,?,?,?)').bind('owner', 'audit-admin', 'T', 'MARK-PRIVATE-MESSAGE', now).run()
    await d.prepare('INSERT INTO settings (key,value) VALUES (?,?),(?,?)').bind('telegram_bot_token', 'MARK-TELEGRAM', 'resend_api_key', 'MARK-RESEND').run()
    const marks = ['MARK-HIDDEN-PRODUCT', 'MARK-ANSWER', 'mark-buyer@private.example', 'MARK-ORDER', 'MARK-CARD-KEY', 'MARK-TRADE',
        'MARK-UNSOLD-CARD', 'MARK-REFUND-REASON', 'MARK-PRIVATE-MESSAGE', 'MARK-TELEGRAM', 'MARK-RESEND']
    const paths = ['/admin', '/admin/announcement', '/admin/cards/product', '/admin/categories', '/admin/collect', '/admin/data', '/admin/fulfillment',
        '/admin/inventory-api', '/admin/messages', '/admin/notifications', '/admin/orders', '/admin/orders/MARK-ORDER', '/admin/product/edit/product',
        '/admin/product/new', '/admin/products', '/admin/refunds', '/admin/reviews', '/admin/settings', '/admin/users',
        '/admin/data/download?type=full&format=json', '/admin/export/download?type=orders&format=csv']
    const outsider = await f.cookie('other', 'other-user')
    for (const [who, cookie] of [['anonymous', null], ['non-admin', outsider]]) {
        for (const pathname of paths) {
            const response = await f.request(pathname, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} })
            const body = await response.text()
            // A response may echo its own URL, so ignore marks the request already carried.
            const leaked = marks.filter(mark => !pathname.includes(mark) && body.includes(mark))
            assert.deepEqual(leaked, [], `${who} ${pathname} (${response.status}) leaked ${leaked}`)
        }
    }
    const admin = await (await f.request('/admin/orders/MARK-ORDER', { headers: { Cookie: f.sessionCookie } })).text()
    assert.ok(admin.includes('MARK-CARD-KEY'))
})
