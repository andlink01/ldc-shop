import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import { Miniflare, Log, LogLevel } from 'miniflare'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const merchantKey = 'isolated-runtime-merchant-key'
const entry = `
import { db, dbRun } from '@/lib/db';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { ensureDatabaseInitialized, setSetting, getProduct, getProductVariants } from '@/lib/db/queries';
import { createOrder } from '@/actions/checkout';
import { getBuyPageMeta, verifyPurchaseAnswers } from '@/actions/buy';
import { proxyRefund } from '@/actions/refund';
import { verifyOrderRefundStatus } from '@/actions/admin-orders';
import { importData } from '@/actions/data';
import { GET as downloadData } from '@/app/admin/data/download/route';
import { fulfillPaidOrder, fulfillPendingOrders } from '@/lib/fulfillment';
import { interleaveSnapshotReads } from './tests/d1-snapshot-fixture.mjs';
import { testNotification, testBarkNotification, testEmailNotification, saveCardsApiConfig, setCardsApiEnabled, pullCardFromApi } from '@/actions/admin';
import { sendOrderEmail } from '@/lib/email';
import { saveProductCardApiConfig, pullOneCardFromApi, getProductCardApiConfig } from '@/lib/card-api';
import { processInventoryEvents } from '@/lib/inventory-events';
import { createInventoryKey, viewInventoryKey, resetInventoryKey, deleteInventoryKey } from '@/actions/inventory';
import { listInventoryProducts } from '@/lib/inventory-api';
import { GET, POST } from '@/app/api/notify/route';
export default { async fetch(request, env) {
  globalThis.__runtimeEnv = env;
  try {
    const url = new URL(request.url);
    if (url.pathname === '/api/notify') return request.method === 'POST' ? POST(request) : GET(request);
    if (url.pathname === '/api/v1/products') return listInventoryProducts(request);
    let result;
    if (url.pathname === '/seed') {
      const input = await request.json();
      await ensureDatabaseInitialized();
      await db.insert(schema.products).values({ id: 'product', name: 'Runtime product', price: '3', ...input.product });
      await db.insert(schema.loginUsers).values({ userId: 'user', username: 'buyer', points: 20 });
      if (!input.onDemand && !input.noCards) await db.insert(schema.cards).values([{productId:'product',cardKey:'STOCK-ONE'},{productId:'product',cardKey:'STOCK-TWO'}]);
      const values = { telegram_enabled:'true', telegram_bot_token:'TEST-BOT', telegram_chat_id:'TEST-CHAT', bark_enabled:'true',
        bark_device_key:'TEST-DEVICE-KEY', bark_server_url:'https://api.day.app', resend_enabled:'true', resend_api_key:'TEST-RESEND',
        resend_from_email:'shop@example.com', ...input.settings };
      for (const [key,value] of Object.entries(values)) await setSetting(key,value);
      if (input.onDemand || input.restock) await saveProductCardApiConfig('product', { enabled:true, mode:input.onDemand?'on_demand':'stock', url:'https://supplier.example/cards', token:'TEST-SUPPLIER' });
      result = { success:true };
    } else if (url.pathname === '/notification') {
      const channel = url.searchParams.get('channel');
      result = channel === 'telegram' ? await testNotification() : channel === 'bark' ? await testBarkNotification() : await testEmailNotification('buyer@example.com');
    } else if (url.pathname === '/delivery-email') {
      result = await sendOrderEmail({ to:'buyer@example.com', orderId:'email-test', productName:'Runtime product', cardKeys:'TEST-CARD', idempotencyKey:'delivery:email-test' });
    } else if (url.pathname === '/checkout') {
      const input = await request.json();
      globalThis.__runtimeTrustLevel = input.trustLevel ?? 0;
      result = await createOrder(input.productId || 'product', input.quantity || 1, 'buyer@example.com', !!input.usePoints, input.answers);
    } else if (url.pathname === '/question-verify') {
      const input = await request.json();
      globalThis.__runtimeTrustLevel = input.trustLevel ?? 0;
      result = await verifyPurchaseAnswers(input.productId || 'product', input.answers);
    } else if (url.pathname === '/product-questions') {
      result = { product:await getProduct('product', {isLoggedIn:true,trustLevel:3}),
        variants:await getProductVariants('question-group', {isLoggedIn:true,trustLevel:3}) };
    } else if (url.pathname === '/sql') {
      const queries = await request.json();
      result = await env.DB.batch(queries.map(({sql,params=[]})=>env.DB.prepare(sql).bind(...params)));
    } else if (url.pathname === '/reviews') {
      result = await getBuyPageMeta('product');
    } else if (url.pathname === '/recover') {
      const input = await request.json();
      result = await fulfillPendingOrders(input.productId, input.limit);
    } else if (url.pathname === '/fulfill') {
      result = await fulfillPaidOrder((await request.json()).orderId);
    } else if (url.pathname === '/refund') {
      const input = await request.json();
      result = await proxyRefund(input.orderId, input.confirmVerifiedRetry);
    } else if (url.pathname === '/refund-verify') {
      result = await verifyOrderRefundStatus((await request.json()).orderId);
    } else if (url.pathname === '/backup') {
      const orderId = url.searchParams.get('deliver');
      const trace = interleaveSnapshotReads(env.DB, async()=>{
        const delivery=await fulfillPaidOrder(orderId);
        if (!delivery.delivered) throw new Error('Interleaved delivery failed');
      });
      if (orderId) globalThis.__runtimeEnv = {...env, DB:trace.database};
      try {
        const response = await downloadData(request);
        response.headers.set('x-test-interleaved', String(trace.didInterleave()));
        return response;
      } finally { globalThis.__runtimeEnv=env; }
    } else if (url.pathname === '/import') {
      const input = await request.json();
      result = await importData({get:()=>({text:async()=>input.dump})});
    } else if (url.pathname === '/supplier-config') {
      const input = await request.json();
      result = await saveCardsApiConfig('product', input.url, input.token, input.enabled, input.mode);
    } else if (url.pathname === '/supplier-toggle') {
      const input = await request.json();
      result = await setCardsApiEnabled('product', input.enabled, input.url, input.token, input.mode);
    } else if (url.pathname === '/supplier-state') {
      result = await getProductCardApiConfig('product');
    } else if (url.pathname === '/key-create') {
      result = await createInventoryKey(await request.json());
    } else if (url.pathname === '/key-view') {
      result = await viewInventoryKey(url.searchParams.get('id'));
    } else if (url.pathname === '/key-reset') {
      result = await resetInventoryKey((await request.json()).id);
    } else if (url.pathname === '/key-delete') {
      result = await deleteInventoryKey((await request.json()).id);
    } else if (url.pathname === '/key-state') {
      result = await db.select().from(schema.inventoryApiKeys);
    } else if (url.pathname === '/maintenance') {
      for (let i=0; i<4; i++) await processInventoryEvents();
      result = { success:true };
    } else if (url.pathname === '/pull') {
      result = await pullOneCardFromApi('product');
    } else if (url.pathname === '/manual-pull') {
      result = await pullCardFromApi('product');
    } else if (url.pathname === '/snapshot') {
      result = { orders:await db.select().from(schema.orders), cards:await db.select().from(schema.cards),
        deliveries:await db.select().from(schema.orderDeliveries), events:await db.select().from(schema.inventoryEvents),
        users:await db.select().from(schema.loginUsers), supplier:await db.select().from(schema.supplierRequests) };
    } else if (url.pathname === '/fail-payment-storage') {
      await dbRun(sql.raw("CREATE TRIGGER test_payment_failure BEFORE UPDATE ON orders WHEN NEW.status = 'paid' AND OLD.status = 'pending' BEGIN SELECT RAISE(ABORT, 'isolated payment failure'); END;"));
      result={success:true};
    } else if (url.pathname === '/repair-payment-storage') {
      await dbRun(sql.raw('DROP TRIGGER test_payment_failure'));
      result={success:true};
    } else if (url.pathname === '/unsupported-redirect-probe') {
      try { await fetch('https://blocked.example', {redirect:'error'}); result={rejected:false}; }
      catch (error) { result={rejected:true,message:error.message}; }
    } else return new Response('Not found',{status:404});
    return Response.json(result);
  } catch (error) { return Response.json({error:error.message,stack:error.stack},{status:500}); }
}};
`

let bundled
async function bundle() {
    if (!bundled) bundled = build({
        stdin: { contents: entry, resolveDir: root, sourcefile: 'isolated-runtime-worker.js' },
        bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022',
        tsconfig: path.join(root, 'tsconfig.json'),
        define: Object.fromEntries(Object.entries({ NODE_ENV: 'production', MERCHANT_ID: 'TEST-MERCHANT', MERCHANT_KEY: merchantKey,
            ADMIN_USERS: 'buyer', NEXT_PUBLIC_APP_URL: 'https://shop.example', AUTH_SECRET: 'isolated-test-secret' })
            .map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)])),
        plugins: [{ name: 'next-request-context', setup(build) {
            // Replace Next request context only. Business code, D1 driver and fetch run in workerd.
            const shims = {
                '@opennextjs/cloudflare': 'export const getCloudflareContext=()=>({env:globalThis.__runtimeEnv});',
                '@/lib/auth': 'export const auth=async()=>({user:{id:"user",username:"buyer",trustLevel:globalThis.__runtimeTrustLevel??0}});',
                'next/cache': 'export const revalidatePath=()=>{}; export const revalidateTag=()=>{}; export const updateTag=()=>{}; export const unstable_noStore=()=>{}; export const unstable_cache=fn=>fn;',
                'next/server': 'export const after=()=>{}; export class NextResponse extends Response { static json(value, init) { return Response.json(value, init); } }',
                'next/headers': 'export const cookies=async()=>({get:()=>undefined,set:()=>{}});',
                'next/constants': 'export const PHASE_EXPORT="phase-export"; export const PHASE_PRODUCTION_BUILD="phase-production-build";',
                react: 'export const cache=fn=>fn;',
            }
            build.onResolve({ filter: /^(?:@opennextjs\/cloudflare|@\/lib\/auth|next\/(?:cache|server|headers|constants)|react)$/ }, args => ({ path: args.path, namespace: 'request-context' }))
            build.onLoad({ filter: /.*/, namespace: 'request-context' }, args => ({ contents: shims[args.path], loader: 'js' }))
        } }],
        logLevel: 'silent',
    }).then(result => result.outputFiles[0].text)
    return bundled
}

async function setup(t, seed = {}, configure = () => undefined) {
    const calls = { telegram: 0, bark: 0, email: 0, supplier: 0, redirected: 0 }
    // Every external request terminates here; this fixture has no access to real providers.
    const outboundService = async request => {
        const custom = await configure(request, calls)
        if (custom) return custom
        const url = new URL(request.url)
        if (url.origin === 'https://api.telegram.org' && url.pathname === '/botTEST-BOT/sendMessage') {
            calls.telegram++; return Response.json({ ok: true })
        }
        if (url.origin === 'https://api.day.app' && url.pathname === '/push') {
            calls.bark++; return Response.json({ code: 200 })
        }
        if (url.origin === 'https://api.resend.com' && url.pathname === '/emails') {
            calls.email++; return Response.json({ id: 'test-email' })
        }
        if (url.origin === 'https://supplier.example' && url.pathname === '/cards') {
            calls.supplier++
            if (request.method === 'GET') return Response.json({ cardKey: `RESTOCK-${calls.supplier}` })
            const body = await request.json()
            assert.equal(body.requestId, request.headers.get('idempotency-key'))
            assert.equal(request.headers.get('authorization'), 'Bearer TEST-SUPPLIER')
            return Response.json({ success: true, requestId: body.requestId, data: { cardKey: `SUPPLIER-${calls.supplier}` } })
        }
        assert.fail(`External network disabled: ${url.origin}`)
    }
    const worker = new Miniflare({ modules: true, script: await bundle(), compatibilityDate: '2025-11-12', compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: crypto.randomUUID() }, d1Persist: false, outboundService, log: new Log(LogLevel.NONE) })
    t.after(async () => { await worker.dispose() })
    const json = async (pathname, input) => {
        const response = await worker.dispatchFetch(`https://shop.example${pathname}`, input === undefined ? undefined : {
            method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' },
        })
        const text = await response.text()
        assert.equal(response.status, 200, text)
        return JSON.parse(text)
    }
    await json('/seed', seed)
    return { worker, json, calls }
}

function sign(params) {
    const sorted = Object.keys(params).filter(key => key !== 'sign' && key !== 'sign_type').sort().map(key => `${key}=${params[key]}`).join('&')
    return createHash('md5').update(sorted + merchantKey).digest('hex')
}

async function pay(f, checkout, overrides = {}, method = 'GET') {
    const params = { out_trade_no: checkout.params.out_trade_no, trade_no: 'test-trade', trade_status: 'TRADE_SUCCESS', money: checkout.params.money, ...overrides }
    const query = new URLSearchParams({ ...params, sign: sign(params), sign_type: 'MD5' })
    return f.worker.dispatchFetch(`https://shop.example/api/notify${method === 'GET' ? '?' + query : ''}`, method === 'POST' ? {
        method, body: query.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    } : undefined)
}

test('real workerd reproduces rejection of redirect error mode', async t => {
    const f = await setup(t)
    const result = await f.json('/unsupported-redirect-probe')
    assert.equal(result.rejected, true)
    assert.match(result.message, /Invalid redirect value/)
})

test('Telegram, Bark and both email send paths run successfully in real workerd', async t => {
    const f = await setup(t)
    for (const channel of ['telegram', 'bark', 'email']) {
        const result = await f.json(`/notification?channel=${channel}`)
        assert.equal(result.success, true, result.error)
    }
    const email = await f.json('/delivery-email')
    assert.equal(email.success, true, email.error)
    assert.deepEqual(f.calls, { telegram: 1, bark: 1, email: 2, supplier: 0, redirected: 0 })
})

test('stock checkout, signed callback, delivery and notifications complete once in real D1', async t => {
    const f = await setup(t)
    const checkout = await f.json('/checkout', { quantity: 2 })
    assert.equal(checkout.success, true, checkout.error)
    assert.equal(checkout.params.sign, sign(checkout.params))
    assert.equal(checkout.params.notify_url, 'https://shop.example/api/notify')
    assert.equal((await f.json('/snapshot')).orders[0].status, 'pending')
    for (const response of await Promise.all(['GET', 'POST', 'GET'].map(method => pay(f, checkout, {}, method)))) {
        assert.equal(response.status, 200)
        assert.equal(await response.text(), 'success')
    }
    await f.json('/maintenance')
    const state = await f.json('/snapshot')
    assert.equal(state.orders[0].status, 'delivered')
    assert.equal(state.orders[0].cardKey, 'STOCK-ONE\nSTOCK-TWO')
    assert.equal(state.deliveries.length, 1)
    assert.equal(state.cards.filter(card => card.isUsed).length, 2)
    assert.ok(state.events.every(event => event.completedAt))
    assert.equal(f.calls.telegram, 1)
    assert.equal(f.calls.bark, 1)
    assert.equal(f.calls.email, 1)
})

test('zero-stock procurement purchases only after payment and sends the resulting card once in real workerd', async t => {
    const f = await setup(t, { onDemand: true })
    const checkout = await f.json('/checkout', {})
    assert.equal(checkout.success, true, checkout.error)
    assert.equal(f.calls.supplier, 0)
    assert.equal((await f.json('/snapshot')).cards.length, 0)
    assert.equal((await pay(f, checkout)).status, 200)
    await f.json('/maintenance')
    const state = await f.json('/snapshot')
    assert.equal(state.orders[0].status, 'delivered', JSON.stringify({ supplier: state.supplier, calls: f.calls }))
    assert.equal(state.orders[0].cardKey, 'SUPPLIER-1')
    assert.equal(state.supplier.length, 1)
    assert.equal(state.supplier[0].state, 'received')
    await pay(f, checkout)
    await f.json('/maintenance')
    assert.equal(f.calls.supplier, 1)
    assert.equal(f.calls.email, 1)
})

test('legacy GET restocking and points checkout work in real D1 without external payment', async t => {
    const f = await setup(t, { restock: true })
    const pull = await f.json('/pull')
    assert.equal(pull.ok, true, pull.error)
    const checkout = await f.json('/checkout', { usePoints: true })
    assert.equal(checkout.success, true, checkout.error)
    assert.equal(checkout.isZeroPrice, true)
    await f.json('/maintenance')
    const state = await f.json('/snapshot')
    assert.equal(state.orders[0].status, 'delivered')
    assert.equal(state.users[0].points, 17)
    assert.equal(state.deliveries.length, 1)
    assert.equal(f.calls.supplier, 2)
})

test('payment callback rejects the wrong amount without delivering in real workerd', async t => {
    const f = await setup(t)
    const checkout = await f.json('/checkout', {})
    for (const money of ['2.00', '2.99', 'NaN', 'Infinity', '3invalid', '']) {
        assert.equal((await pay(f, checkout, { money })).status, 400, money)
    }
    const state = await f.json('/snapshot')
    assert.equal(state.orders[0].status, 'pending')
    assert.equal(state.deliveries.length, 0)
})

test('all six credential-bearing requests reject redirects without sending credentials to another server', async t => {
    const redirects = (request, calls) => {
        const host = new URL(request.url).hostname
        if (host === 'redirect.example') {
            calls.redirected++
            return Response.json({ ok: true, code: 200, id: 'redirected-email' })
        }
        return new Response(null, { status: 307, headers: { Location: 'https://redirect.example/trap' } })
    }
    const f = await setup(t, { restock: true }, redirects)
    for (const channel of ['telegram', 'bark', 'email']) {
        const result = await f.json(`/notification?channel=${channel}`)
        assert.equal(result.success, false)
    }
    assert.equal((await f.json('/delivery-email')).success, false)
    assert.equal((await f.json('/pull')).error, 'api_request_failed_307')
    const procurement = await setup(t, { onDemand: true }, redirects)
    const checkout = await procurement.json('/checkout', {})
    await pay(procurement, checkout)
    await procurement.json('/maintenance')
    const state = await procurement.json('/snapshot')
    assert.equal(state.orders[0].status, 'paid')
    assert.equal(state.supplier[0].error, 'supplier_http_307')
    assert.equal(state.cards.length, 0)
    assert.equal(f.calls.redirected, 0)
    assert.equal(procurement.calls.redirected, 0)
})

test('Bark reports HTTP failures, invalid JSON and rejection codes distinctly without exposing keys', async t => {
    let mode = 'http'
    const f = await setup(t, {}, request => {
        if (new URL(request.url).hostname !== 'api.day.app') return undefined
        if (mode === 'http') return new Response('TEST-DEVICE-KEY', { status: 520 })
        if (mode === 'html') return new Response('<html>TEST-DEVICE-KEY</html>')
        return Response.json({ code: 400, message: 'TEST-DEVICE-KEY' })
    })
    for (const [value, expected] of [['http', /HTTP 520/], ['html', /invalid JSON/], ['api', /code 400/]]) {
        mode = value
        const result = await f.json('/notification?channel=bark')
        assert.equal(result.success, false)
        assert.match(result.error, expected)
        assert.ok(!result.error.includes('TEST-DEVICE-KEY'))
    }
})

test('payment storage errors request gateway retry and recover without duplicate delivery in real D1', async t => {
    const f = await setup(t)
    const checkout = await f.json('/checkout', {})
    await f.json('/fail-payment-storage')
    assert.equal((await pay(f, checkout)).status, 500)
    assert.equal((await f.json('/snapshot')).orders[0].status, 'pending')
    await f.json('/repair-payment-storage')
    assert.equal((await pay(f, checkout)).status, 200)
    await f.json('/maintenance')
    const state = await f.json('/snapshot')
    assert.equal(state.orders[0].status, 'delivered')
    assert.equal(state.deliveries.length, 1)
    assert.equal(state.orders.length, 1)
    assert.equal(f.calls.telegram, 1)
    assert.equal(f.calls.bark, 1)
    assert.equal(f.calls.email, 1)
})

test('both modes return missing URL errors as data in production workerd and preserve the disabled draft', async t => {
    const f = await setup(t, { noCards: true })
    for (const mode of ['stock', 'on_demand']) {
        const saved = await f.json('/supplier-config', { mode, enabled: false, url: '', token: '' })
        assert.equal(saved.success, true)
        assert.equal(saved.enabled, false)
        const enabled = await f.json('/supplier-toggle', { enabled: true })
        assert.equal(enabled.success, false)
        assert.equal(enabled.error, 'admin.cards.apiUrlRequired')
        assert.equal((await f.json('/supplier-state')).enabled, false)
    }
    assert.equal(f.calls.supplier, 0)
})

test('enabling procurement with an optional empty token makes no request until payment in real workerd', async t => {
    const f = await setup(t, { noCards: true }, async (request, calls) => {
        if (new URL(request.url).hostname !== 'supplier.example') return undefined
        calls.supplier++
        assert.equal(request.headers.get('authorization'), null)
        const body = await request.json()
        assert.equal(body.requestId, request.headers.get('idempotency-key'))
        return Response.json({ success: true, requestId: body.requestId, data: { cardKey: 'OPTIONAL-TOKEN-CARD' } })
    })
    assert.equal((await f.json('/supplier-config', { mode: 'on_demand', enabled: false, url: 'https://supplier.example/cards', token: '' })).success, true)
    assert.equal((await f.json('/supplier-toggle', { enabled: true })).success, true)
    assert.equal(f.calls.supplier, 0)
    const checkout = await f.json('/checkout', {})
    assert.equal(checkout.success, true)
    assert.equal((await pay(f, checkout)).status, 200)
    await f.json('/maintenance')
    assert.equal((await f.json('/snapshot')).orders[0].cardKey, 'OPTIONAL-TOKEN-CARD')
    assert.equal(f.calls.supplier, 1)
})

test('encrypted inventory keys can be viewed and reset with correct authentication in real workerd', async t => {
    const f = await setup(t)
    const created = await f.json('/key-create', { name: 'Tool', productIds: ['product'], canRead: true, canWrite: false, expiresAt: null })
    assert.equal(created.success, true)
    const [key] = await f.json('/key-state')
    assert.ok(!JSON.stringify(key).includes(created.token))
    assert.equal((await f.json(`/key-view?id=${key.id}`)).token, created.token)
    const auth = token => f.worker.dispatchFetch('https://shop.example/api/v1/products', { headers: { Authorization: `Bearer ${token}` } })
    assert.equal((await auth(created.token)).status, 200)
    const reset = await f.json('/key-reset', { id: key.id })
    assert.equal(reset.success, true)
    assert.notEqual(reset.token, created.token)
    assert.equal((await auth(created.token)).status, 401)
    assert.equal((await auth(reset.token)).status, 200)
    assert.equal((await f.json(`/key-view?id=${key.id}`)).token, reset.token)
    assert.equal((await f.json('/key-state')).length, 1)
    assert.equal((await f.json('/key-delete', { id: key.id })).success, true)
    assert.equal((await auth(reset.token)).status, 401)
    assert.equal((await f.json('/key-state')).length, 0)
    assert.equal((await f.json(`/key-view?id=${key.id}`)).error, 'inventory.keyNotFound')
})

test('manual restocking returns HTTP and response errors as data in production workerd', async t => {
    let mode = 'http'
    const f = await setup(t, { restock: true, noCards: true }, request => {
        if (new URL(request.url).hostname !== 'supplier.example') return undefined
        if (mode === 'http') return new Response('PRIVATE-CARD', { status: 520 })
        if (mode === 'invalid') return new Response('PRIVATE-CARD', { headers: { 'Content-Type': 'application/json' } })
        return Response.json({})
    })
    for (const [value, error] of [['http', 'api_request_failed_520'], ['invalid', 'api_invalid_response'], ['missing', 'api_card_missing']]) {
        mode = value
        const result = await f.json('/manual-pull')
        assert.equal(result.success, false)
        assert.equal(result.error, error)
        assert.ok(!JSON.stringify(result).includes('PRIVATE'))
        assert.equal((await f.json('/snapshot')).cards.length, 0)
    }
})

test('real D1 checkout enforces trust levels and leaves denied buyers stock and points untouched', async t => {
    const f = await setup(t, { product: { visibilityLevel: 2 } })
    for (const trustLevel of [0, 1]) {
        const result = await f.json('/checkout', { trustLevel, usePoints: true })
        assert.equal(result.success, false)
        assert.equal(result.error, 'buy.visibilityDenied')
    }
    const before = await f.json('/snapshot')
    assert.equal(before.orders.length, 0)
    assert.equal(before.users[0].points, 20)
    assert.ok(before.cards.every(card => !card.isUsed && !card.reservedOrderId))
    assert.equal((await f.json('/checkout', { trustLevel: 2 })).success, true)
})

test('purchase questions reject malformed answers and invalid stored questions in real workerd', async t => {
    const f = await setup(t, { product: { purchaseQuestions: JSON.stringify([{ q: 'Answer?', a: 'Correct' }]) } })
    for (const answers of [[{}], [1], { 0: 'Correct', length: 1 }]) {
        const result = await f.json('/checkout', { answers })
        assert.equal(result.success, false)
        assert.equal(result.error, 'buy.answersRequired')
    }
    assert.equal((await f.json('/snapshot')).orders.length, 0)
    await f.json('/sql', [{ sql: 'UPDATE products SET purchase_questions = ? WHERE id = ?', params: ['invalid-json', 'product'] }])
    assert.equal((await f.json('/checkout', { answers: ['Correct'] })).error, 'buy.questionsUnavailable')
    await f.json('/sql', [{ sql: 'UPDATE products SET purchase_questions = ? WHERE id = ?', params: [JSON.stringify([{ q: 'Answer?', a: 'Correct' }]), 'product'] }])
    assert.equal((await f.json('/checkout', { answers: [' correct '] })).success, true)
})

test('real workerd keeps every variant answer private and verifies questions without checkout side effects', async t => {
    const questions = JSON.stringify([{ q: 'Runtime question?', a: 'PRIVATE-RUNTIME-ANSWER' }])
    const f = await setup(t, { product: { visibilityLevel: 2, variantGroupId: 'question-group', purchaseQuestions: questions } })
    await f.json('/sql', [{ sql: 'INSERT INTO products (id,name,price,variant_group_id,purchase_questions) VALUES (?,?,?,?,?)',
        params: ['variant', 'Runtime variant', '3', 'question-group', JSON.stringify([{ q: 'Variant question?', a: 'PRIVATE-VARIANT-ANSWER' }])] }])
    const publicData = await f.json('/product-questions')
    assert.deepEqual(JSON.parse(publicData.product.purchaseQuestions), [{ q: 'Runtime question?' }])
    assert.equal(publicData.variants.length, 2)
    assert.ok(!JSON.stringify(publicData).includes('PRIVATE-'))
    const verify = (answers, trustLevel = 2) => f.json('/question-verify', { answers, trustLevel })
    assert.equal((await verify(['PRIVATE-RUNTIME-ANSWER'], 1)).error, 'buy.visibilityDenied')
    assert.equal((await verify([{}])).error, 'buy.answersRequired')
    assert.equal((await verify(['wrong'])).error, 'buy.questionsWrong')
    assert.equal((await verify([' private-runtime-answer '])).success, true)
    await f.json('/sql', [{ sql: 'UPDATE login_users SET is_blocked = 1 WHERE user_id = ?', params: ['user'] }])
    assert.equal((await verify(['PRIVATE-RUNTIME-ANSWER'])).error, 'buy.userBlocked')
    const state = await f.json('/snapshot')
    assert.equal(state.orders.length, 0)
    assert.equal(state.users[0].points, 20)
    assert.ok(state.cards.every(card => !card.isUsed && !card.reservedOrderId))
})

test('automatic GET stock rejects used and expired values and concurrent duplicates in real D1', async t => {
    let cardKey = ' USED-CARD '
    const f = await setup(t, { restock: true, noCards: true }, request => {
        if (new URL(request.url).hostname === 'supplier.example') return Response.json({ cardKey })
    })
    await f.json('/sql', [
        { sql: 'INSERT INTO cards (product_id,card_key,is_used,used_at) VALUES (?,?,1,?)', params: ['product', 'USED-CARD', Date.now()] },
        { sql: 'INSERT INTO cards (product_id,card_key,expires_at) VALUES (?,?,?)', params: ['product', 'EXPIRED-CARD', Date.now() - 1000] },
    ])
    for (const value of [' USED-CARD ', 'EXPIRED-CARD']) {
        cardKey = value
        assert.equal((await f.json('/pull')).error, 'api_card_duplicate')
    }
    cardKey = 'NEW-UNIQUE-CARD'
    const results = await Promise.all(Array.from({ length: 3 }, () => f.json('/pull')))
    assert.equal(results.filter(result => result.ok).length, 1)
    assert.equal((await f.json('/snapshot')).cards.filter(card => card.cardKey === cardKey).length, 1)
    // Manual imports may still intentionally contain duplicate values.
    await f.json('/sql', [{ sql: 'INSERT INTO cards (product_id,card_key) VALUES (?,?)', params: ['product', cardKey] }])
    assert.equal((await f.json('/snapshot')).cards.filter(card => card.cardKey === cardKey).length, 2)
})

test('a real D1 full backup cannot reissue a sold card after an interleaved delivery and restore', async t => {
    const f = await setup(t, { noCards: true })
    await f.json('/sql', [
        { sql: 'INSERT INTO cards (product_id,card_key) VALUES (?,?)', params: ['product', 'BACKUP-ONLY-CARD'] },
        { sql: 'INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id) VALUES (?,?,?,?,?,?)', params: ['backup-order', 'product', 'Runtime product', '3', 'paid', 'user'] },
    ])
    const response = await f.worker.dispatchFetch('https://shop.example/backup?type=full&format=sql&deliver=backup-order')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-test-interleaved'), 'true')
    const dump = await response.text()
    assert.equal((await f.json('/snapshot')).orders[0].status, 'delivered')
    const restored = await setup(t, { noCards: true })
    await restored.json('/sql', [{ sql: 'DELETE FROM products' }])
    const imported = await restored.json('/import', { dump })
    assert.equal(imported.success, true, JSON.stringify(imported))
    assert.equal(imported.errors, 0)
    const state = await restored.json('/snapshot')
    assert.equal(state.orders[0].status === 'delivered', state.cards[0].isUsed)
    assert.equal((await restored.json('/fulfill', { orderId: 'backup-order' })).delivered, true)
    await restored.json('/sql', [{ sql: 'INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id) VALUES (?,?,?,?,?,?)', params: ['second-order', 'product', 'Runtime product', '3', 'paid', 'user'] }])
    assert.equal((await restored.json('/fulfill', { orderId: 'second-order' })).delivered, false)
    assert.equal((await restored.json('/snapshot')).deliveries.length, 1)
})

test('101 reviews and their replies remain complete in real D1', async t => {
    const f = await setup(t)
    await f.json('/sql', Array.from({ length: 101 }, (_, i) => ({
        sql: 'INSERT INTO reviews (product_id,order_id,user_id,username,rating,comment,created_at) VALUES (?,?,?,?,?,?,?)',
        params: ['product', 'review-' + i, 'user', 'buyer', 5, 'Review ' + i, Date.now() + i],
    })))
    await f.json('/sql', [{ sql: 'INSERT INTO review_replies (review_id,user_id,username,comment) VALUES (?,?,?,?)', params: [1, 'user', 'buyer', 'First review reply'] }])
    const result = await f.json('/reviews')
    assert.equal(result.reviewCount, 101)
    assert.equal(result.averageRating, 5)
    assert.equal(result.reviews.length, 101)
    assert.equal(result.reviews.find(review => review.id === 1).replies[0].comment, 'First review reply')
})

test('global fulfillment moves past 50 unavailable old orders to another product in real workerd', async t => {
    const f = await setup(t)
    await f.json('/sql', [{ sql: 'INSERT INTO products (id,name,price) VALUES (?,?,?)', params: ['a-unavailable', 'Unavailable', '3'] },
        ...Array.from({ length: 50 }, (_, i) => ({
            sql: 'INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,paid_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
            params: ['old-' + i, 'a-unavailable', 'Unavailable', '3', 'paid', 'user', 1, i + 1],
        })),
        { sql: 'INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id,paid_at,created_at) VALUES (?,?,?,?,?,?,?,?)', params: ['ready', 'product', 'Runtime product', '3', 'paid', 'user', Date.now(), Date.now()] },
    ])
    assert.equal((await f.json('/recover', { limit: 50 })).delivered, 0)
    assert.equal((await f.json('/recover', { limit: 50 })).delivered, 1)
    const state = await f.json('/snapshot')
    assert.equal(state.orders.find(order => order.orderId === 'ready').status, 'delivered')
    assert.equal(state.orders.filter(order => order.status === 'paid').length, 50)
})

test('real D1 delivers full buyer reservations behind 50 missing-stock orders while protecting FIFO stock', async t => {
    for (const productId of [undefined, 'product']) {
        const f = await setup(t)
        await f.json('/sql', [
            ...Array.from({ length: 50 }, (_, i) => ({ sql: 'INSERT INTO orders (order_id,product_id,product_name,amount,status,quantity,user_id,paid_at) VALUES (?,?,?,?,?,?,?,?)',
                params: ['old-' + String(i).padStart(2, '0'), 'product', 'Runtime product', '3', 'paid', 3, 'user', 1] })),
            { sql: 'INSERT INTO orders (order_id,product_id,product_name,amount,status,quantity,user_id,paid_at) VALUES (?,?,?,?,?,?,?,?)', params: ['reserved', 'product', 'Runtime product', '3', 'paid', 2, 'user', 2] },
            { sql: 'UPDATE cards SET reserved_order_id = ?, reserved_at = ?', params: ['reserved', 1] },
            { sql: 'INSERT INTO cards (product_id,card_key) VALUES (?,?)', params: ['product', 'OLDER-STOCK'] },
        ])
        assert.equal((await f.json('/recover', { productId, limit: 50 })).delivered, 1)
        assert.equal((await f.json('/recover', { productId, limit: 50 })).delivered, 0)
        const state = await f.json('/snapshot')
        assert.equal(state.orders.find(order => order.orderId === 'reserved').cardKey, 'STOCK-ONE\nSTOCK-TWO')
        assert.equal(state.cards.find(card => card.cardKey === 'OLDER-STOCK').reservedOrderId, 'old-00')
        assert.equal(state.orders.filter(order => order.status === 'paid').length, 50)
        assert.equal(state.deliveries.length, 1)
    }
})

test('a failed fulfillment transaction does not block another product in real D1', async t => {
    const f = await setup(t)
    await f.json('/sql', [
        { sql: 'INSERT INTO products (id,name,price) VALUES (?,?,?)', params: ['a-broken', 'Broken', '3'] },
        { sql: 'INSERT INTO cards (product_id,card_key) VALUES (?,?)', params: ['a-broken', 'BROKEN-CARD'] },
        ...[['bad', 'a-broken'], ['good', 'product']].map(([id, product]) => ({ sql: 'INSERT INTO orders (order_id,product_id,product_name,amount,status,user_id) VALUES (?,?,?,?,?,?)', params: [id, product, 'Runtime product', '3', 'paid', 'user'] })),
        { sql: "CREATE TRIGGER fail_delivery BEFORE UPDATE ON orders WHEN NEW.order_id = 'bad' AND NEW.status = 'delivered' BEGIN SELECT RAISE(ABORT, 'isolated failure'); END;" },
    ])
    const result = await f.json('/recover', { limit: 50 })
    assert.equal(result.failed, 1)
    assert.equal(result.delivered, 1)
    const state = await f.json('/snapshot')
    assert.equal(state.orders.find(order => order.orderId === 'bad').status, 'paid')
    assert.equal(state.orders.find(order => order.orderId === 'good').status, 'delivered')
})

async function refundSetup(t, configure) {
    const f = await setup(t, { product: { price: '5', maxPointsDiscount: '2' } }, configure)
    const checkout = await f.json('/checkout', { usePoints: true })
    assert.equal(checkout.success, true, checkout.error)
    assert.equal((await pay(f, checkout)).status, 200)
    return { ...f, orderId: checkout.params.out_trade_no }
}

test('concurrent refund requests contact the gateway and return points once in real workerd', async t => {
    let refunds = 0
    const f = await refundSetup(t, async request => {
        if (new URL(request.url).hostname !== 'credit.linux.do') return undefined
        assert.equal(request.method, 'POST')
        assert.equal(new URL(request.url).searchParams.get('act'), 'refund')
        assert.equal((await request.formData()).get('money'), '3.00')
        refunds++
        await new Promise(resolve => setTimeout(resolve, 100))
        return Response.json({ code: 1 })
    })
    const results = await Promise.all(Array.from({ length: 3 }, () => f.json('/refund', { orderId: f.orderId })))
    assert.ok(results.some(result => result.processed))
    assert.equal(refunds, 1)
    const state = await f.json('/snapshot')
    assert.equal(state.orders[0].status, 'refunded')
    assert.equal(state.users[0].points, 20)
    assert.ok(state.cards.every(card => !card.isUsed))
})

test('an accepted refund survives a local rollback and recovers without resubmission in real D1', async t => {
    let refunds = 0
    const f = await refundSetup(t, request => {
        if (new URL(request.url).hostname === 'credit.linux.do') { refunds++; return Response.json({ code: 1 }) }
    })
    await f.json('/sql', [{ sql: "CREATE TRIGGER fail_refund BEFORE UPDATE ON orders WHEN NEW.status = 'refunded' BEGIN SELECT RAISE(ABORT, 'isolated failure'); END;" }])
    assert.equal((await f.json('/refund', { orderId: f.orderId })).needsVerification, true)
    const before = await f.json('/snapshot')
    assert.equal(before.orders[0].status, 'delivered')
    assert.equal(before.users[0].points, 18)
    assert.equal(JSON.parse(before.events.find(event => event.kind === 'refund_request').data).state, 'accepted')
    await f.json('/sql', [{ sql: 'DROP TRIGGER fail_refund' }])
    assert.equal((await f.json('/refund', { orderId: f.orderId })).processed, true)
    assert.equal(refunds, 1)
    assert.equal((await f.json('/snapshot')).users[0].points, 20)
})

test('a lost refund acknowledgement remains uncertain when the platform returns status zero in real workerd', async t => {
    let refunds = 0, queries = 0, orderId
    const f = await refundSetup(t, request => {
        const url = new URL(request.url)
        if (url.hostname !== 'credit.linux.do') return undefined
        if (request.method === 'POST') { refunds++; return new Response(null, { status: 503 }) }
        queries++
        assert.equal(url.searchParams.get('trade_no'), 'test-trade')
        assert.ok(url.searchParams.get('out_trade_no'), 'the payment platform rejects a query without out_trade_no')
        return Response.json({ code: 1, status: 0, trade_no: 'test-trade', out_trade_no: orderId + '_retry123' })
    })
    orderId = f.orderId
    assert.equal((await f.json('/refund', { orderId })).needsVerification, true)
    assert.equal((await f.json('/refund', { orderId })).needsVerification, true)
    assert.equal((await f.json('/refund-verify', { orderId })).needsVerification, true)
    assert.equal(refunds, 1)
    assert.equal(queries, 2)
    const state = await f.json('/snapshot')
    assert.equal(state.users[0].points, 18)
    assert.equal(state.orders[0].status, 'delivered')
    assert.equal(state.cards[0].isUsed, true)
})

test('an uncertain refund needs explicit verification and confirmation before retry in real D1', async t => {
    let refunds = 0, accepted = false, orderId
    const f = await refundSetup(t, request => {
        const url = new URL(request.url)
        if (url.hostname !== 'credit.linux.do') return undefined
        if (request.method === 'POST') { refunds++; return accepted ? Response.json({ code: 1 }) : new Response(null, { status: 503 }) }
        return Response.json({ code: 1, status: 1, trade_no: 'test-trade', out_trade_no: orderId })
    })
    orderId = f.orderId
    assert.equal((await f.json('/refund', { orderId })).needsVerification, true)
    assert.equal((await f.json('/refund', { orderId, confirmVerifiedRetry: true })).needsVerification, true)
    assert.equal(refunds, 1)
    const verified = await f.json('/refund-verify', { orderId })
    assert.equal(verified.canRetry, true)
    assert.equal(verified.needsReview, true)
    assert.equal((await f.json('/refund', { orderId })).needsReview, true)
    accepted = true
    assert.equal((await f.json('/refund', { orderId, confirmVerifiedRetry: true })).processed, true)
    assert.equal(refunds, 2)
    assert.equal((await f.json('/snapshot')).users[0].points, 20)
})
