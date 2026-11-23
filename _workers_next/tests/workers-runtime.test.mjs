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
import { ensureDatabaseInitialized, setSetting } from '@/lib/db/queries';
import { createOrder } from '@/actions/checkout';
import { testNotification, testBarkNotification, testEmailNotification, saveCardsApiConfig, setCardsApiEnabled, pullCardFromApi } from '@/actions/admin';
import { sendOrderEmail } from '@/lib/email';
import { saveProductCardApiConfig, pullOneCardFromApi, getProductCardApiConfig } from '@/lib/card-api';
import { processInventoryEvents } from '@/lib/inventory-events';
import { createInventoryKey, viewInventoryKey, resetInventoryKey } from '@/actions/inventory';
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
      await db.insert(schema.products).values({ id: 'product', name: 'Runtime product', price: '3' });
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
      result = await createOrder('product', input.quantity || 1, 'buyer@example.com', !!input.usePoints);
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
                '@/lib/auth': 'export const auth=async()=>({user:{id:"user",username:"buyer",trustLevel:0}});',
                'next/cache': 'export const revalidatePath=()=>{}; export const revalidateTag=()=>{}; export const updateTag=()=>{}; export const unstable_noStore=()=>{}; export const unstable_cache=fn=>fn;',
                'next/server': 'export const after=()=>{};',
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
