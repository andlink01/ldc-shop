import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { renderToString } from 'react-dom/server'
import { fixture } from './database-fixture.mjs'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
function host(tag) {
    return function TestHost({ children, ...props }) { return React.createElement(tag, props, children) }
}
const dialog = { Dialog: host('dialog'), ...Object.fromEntries(['DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle'].map(name => [name, host('div')])) }

function setup(t, mocks = {}, globals = {}) {
    const values = new Map()
    const storage = {
        writable: true,
        readable: true,
        getItem(key) { if (!this.readable) throw new Error('Storage disabled'); return values.get(key) ?? null },
        setItem(key, value) { if (!this.writable) throw new Error('Storage disabled'); values.set(key, value) },
    }
    const window = new EventTarget()
    const document = { cookie: '' }
    const pushed = []
    const f = fixture(t, {
        initialize: false,
        globals: { window, localStorage: storage, document, Event, ...globals },
        mocks: {
            react: React,
            'next/link': host('a'),
            'next/navigation': { useRouter: () => ({ push: url => pushed.push(url), refresh() {} }) },
            'react-markdown': host('article'),
            '@/components/ui/button': { Button: host('button') },
            '@/components/ui/input': { Input: host('input') },
            '@/components/ui/label': { Label: host('label') },
            '@/components/ui/dialog': dialog,
            '@/components/ui/card': Object.fromEntries(['Card', 'CardContent', 'CardFooter', 'CardHeader', 'CardTitle', 'CardDescription'].map(name => [name, host('div')])),
            '@/components/ui/checkbox': { Checkbox: host('input') },
            '@/components/ui/textarea': { Textarea: host('textarea') },
            'next/image': host('img'),
            '@/components/ui/badge': { Badge: host('span') },
            sonner: { toast: { success() {}, error() {}, info() {} } },
            ...mocks,
        },
    })
    return { ...f, values, storage, window, document, pushed }
}

function buttonName(node) {
    return node.props['aria-label'] || node.props.title || node.children.filter(child => typeof child === 'string').join('')
}

async function mount(t, element) {
    let renderer
    await act(async () => { renderer = create(element) })
    t.after(async () => { await act(async () => renderer.unmount()) })
    return renderer
}

test('search input follows navigation props while preserving typing until navigation changes', async t => {
    const f = setup(t)
    const { SearchContent } = f.load('components/search-content')
    const props = { q: 'first', category: 'all', sort: 'default', page: 1, pageSize: 24, total: 0, products: [], categories: [] }
    const view = await mount(t, React.createElement(SearchContent, props))
    assert.equal(view.root.findByType('input').props.value, 'first')
    await act(async () => view.root.findByType('input').props.onChange({ target: { value: 'typed' } }))
    await act(async () => view.update(React.createElement(SearchContent, { ...props })))
    assert.equal(view.root.findByType('input').props.value, 'typed')
    await act(async () => view.update(React.createElement(SearchContent, { ...props, q: 'second' })))
    assert.equal(view.root.findByType('input').props.value, 'second')
    await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }))
    assert.equal(new URL(f.pushed[0], 'https://shop.example').searchParams.get('q'), 'second')
})

test('login buttons lock during authorization, retain the product return address and allow retry after failure', async t => {
    const calls = [], redirected = []
    let release, fail = true
    class LoginRequestError extends Error { constructor(code) { super(code); this.code = code } }
    const f = setup(t, {
        '@/lib/oauth-login': { LoginRequestError, loginErrorMessage: () => null, startOAuthLogin: async (...args) => {
            calls.push(args)
            if (fail) throw new LoginRequestError('login.requestFailed')
            return new Promise(resolve => { release = resolve })
        } },
        'next/navigation': { useSearchParams: () => new URLSearchParams('callbackUrl=%2Fbuy%2Fproduct') },
    })
    f.window.location = { origin: 'https://shop.example', assign: url => redirected.push(url) }
    const { LoginContent } = f.load('components/login-content')
    const view = await mount(t, React.createElement(LoginContent, { providers: { linuxdo: true, github: false } }))
    assert.equal(view.root.findAllByType('button').length, 1)
    const button = () => view.root.findByType('button')
    await act(async () => button().props.onClick())
    assert.match(view.root.findByProps({ role: 'alert' }).children.join(''), /Check your network/)
    assert.equal(button().props.disabled, false)
    fail = false
    await act(async () => button().props.onClick())
    assert.equal(button().props.disabled, true)
    await act(async () => button().props.onClick())
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1], ['linuxdo', '/buy/product', 'https://shop.example'])
    await act(async () => release('https://connect.linux.do/oauth2/authorize?client_id=test'))
    assert.deepEqual(redirected, ['https://connect.linux.do/oauth2/authorize?client_id=test'])
    assert.equal(button().props.disabled, true)
    const restored = new Event('pageshow')
    Object.defineProperty(restored, 'persisted', { value: true })
    await act(async () => f.window.dispatchEvent(restored))
    assert.equal(button().props.disabled, false)
})

function localeProbe(f) {
    const { I18nProvider, useI18n } = f.load('lib/i18n/context')
    let current
    function Probe() {
        const context = useI18n()
        React.useEffect(() => { current = context }, [context])
        return React.createElement('span', null, context.locale)
    }
    return { element: React.createElement(I18nProvider, { initialLocale: 'zh' }, React.createElement(Probe)), current: () => current }
}

test('language selection restores storage, persists changes and follows repeated cross-tab changes', async t => {
    const f = setup(t)
    f.storage.setItem('ldc-locale', 'en')
    const probe = localeProbe(f)
    await mount(t, probe.element)
    assert.equal(probe.current().locale, 'en')
    await act(async () => probe.current().setLocale('zh'))
    assert.equal(probe.current().locale, 'zh')
    assert.equal(f.storage.getItem('ldc-locale'), 'zh')
    assert.match(f.document.cookie, /ldc-locale=zh/)
    for (const locale of ['en', 'zh', 'en']) {
        await act(async () => { f.storage.setItem('ldc-locale', locale); f.window.dispatchEvent(new Event('storage')) })
        assert.equal(probe.current().locale, locale)
    }
})

test('language can change when storage writes fail and does not resurrect stale choices after cross-tab changes', async t => {
    const f = setup(t)
    f.storage.setItem('ldc-locale', 'en')
    f.storage.writable = false
    const probe = localeProbe(f)
    await mount(t, probe.element)
    await act(async () => probe.current().setLocale('zh'))
    assert.equal(probe.current().locale, 'zh')
    assert.equal(f.storage.getItem('ldc-locale'), 'en')
    f.storage.writable = true
    for (const locale of ['zh', 'en']) {
        await act(async () => { f.storage.setItem('ldc-locale', locale); f.window.dispatchEvent(new Event('storage')) })
        assert.equal(probe.current().locale, locale)
    }
    f.storage.readable = false
    f.storage.writable = false
    await act(async () => probe.current().setLocale('zh'))
    assert.equal(probe.current().locale, 'zh')
})

test('announcement stays closed after dismissal and remount, and new content opens', async t => {
    const f = setup(t)
    const { AnnouncementPopup } = f.load('components/announcement-popup')
    const popup = { signature: 'v1', title: 'Title', content: 'Notice' }
    const view = await mount(t, React.createElement(AnnouncementPopup, { popup }))
    assert.equal(view.root.findByType('dialog').props.open, true)
    await act(async () => view.root.findByType('button').props.onClick())
    assert.equal(view.root.findByType('dialog').props.open, false)
    await act(async () => view.update(React.createElement(AnnouncementPopup, { popup, key: 'remount' })))
    assert.equal(view.root.findByType('dialog').props.open, false)
    await act(async () => view.update(React.createElement(AnnouncementPopup, { popup: { ...popup, signature: 'v2' }, key: 'remount' })))
    assert.equal(view.root.findByType('dialog').props.open, true)
    await act(async () => { f.storage.setItem('announcement-popup:dismissed-signature', 'v2'); f.window.dispatchEvent(new Event('storage')) })
    assert.equal(view.root.findByType('dialog').props.open, false)
})

test('announcement remains dismissible with storage disabled and stays closed during SSR', async t => {
    const f = setup(t)
    f.storage.readable = false
    f.storage.writable = false
    const { AnnouncementPopup } = f.load('components/announcement-popup')
    const popup = { signature: 'v1', title: null, content: 'Notice' }
    assert.doesNotMatch(renderToString(React.createElement(AnnouncementPopup, { popup })), /<dialog open/)
    const view = await mount(t, React.createElement(AnnouncementPopup, { popup }))
    await act(async () => view.root.findByType('dialog').props.onOpenChange(false))
    assert.equal(view.root.findByType('dialog').props.open, false)
    await act(async () => view.update(React.createElement(AnnouncementPopup, { popup: { ...popup, signature: 'v2' } })))
    assert.equal(view.root.findByType('dialog').props.open, true)
})

test('automatic purchase dialog loads points once in StrictMode and blocks checkout until points resolve', async t => {
    let resolvePoints
    const points = new Promise(resolve => { resolvePoints = resolve })
    let loads = 0
    const orders = []
    const f = setup(t, {
        '@/actions/points': { getUserPoints: () => { loads++; return points } },
        '@/actions/checkout': { createOrder: async (...args) => { orders.push(args); return { success: false, error: 'test' } } },
    })
    const { BuyButton } = f.load('components/buy-button')
    const props = { productId: 'product', productName: 'Product', price: '5', autoOpen: true }
    const element = () => React.createElement(React.StrictMode, null, React.createElement(BuyButton, props))
    const view = await mount(t, element())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) })
    assert.equal(loads, 1)
    assert.equal(view.root.findByType('dialog').props.open, true)
    const confirm = () => view.root.findAllByType('button').at(-1)
    assert.equal(confirm().props.disabled, true)
    await act(async () => confirm().props.onClick())
    assert.equal(orders.length, 0)
    await act(async () => resolvePoints(10))
    assert.equal(confirm().props.disabled, undefined)
    assert.equal(view.root.findByProps({ id: 'use-points' }).props.checked, true)
    await act(async () => view.update(element()))
    assert.equal(loads, 1)
    await act(async () => confirm().props.onClick())
    assert.equal(orders.length, 1)
    assert.equal(orders[0][3], true)
})

test('check-in initialization uses the latest callbacks without refetching on parent renders', async t => {
    let resolvePoints
    let loads = 0
    const points = new Promise(resolve => { resolvePoints = resolve })
    const f = setup(t, { '@/actions/points': {
        getUserPoints: () => { loads++; return points },
        getCheckinStatus: async () => ({ checkedIn: false }),
        checkIn: async () => ({ success: true, points: 2 }),
    } })
    const { CheckInButton } = f.load('components/checkin-button')
    const old = [], latest = [], status = []
    const view = await mount(t, React.createElement(CheckInButton, { onPointsChange: value => old.push(value) }))
    await act(async () => view.update(React.createElement(CheckInButton, { onPointsChange: value => latest.push(value), onCheckedInChange: value => status.push(value) })))
    await act(async () => resolvePoints(5))
    assert.equal(loads, 1)
    assert.deepEqual(old, [])
    assert.deepEqual(latest, [5])
    await act(async () => view.root.findByType('button').props.onClick())
    assert.deepEqual(latest, [5, 7])
    assert.deepEqual(status, [false, true])
})

test('product form resets on product navigation and ignores stale fetches while clearing removed questions', async t => {
    const pending = new Map()
    const f = setup(t, { '@/actions/admin': {
        getProductForAdminAction: id => new Promise(resolve => pending.set(id, resolve)),
        saveProduct: async () => {},
    } })
    const ProductForm = f.load('components/admin/product-form').default
    const first = { id: 'first', name: 'First', price: '1', image: null, purchaseQuestions: '[{"q":"First?","a":"yes"}]' }
    const second = { ...first, id: 'second', name: 'Second', price: '2', purchaseQuestions: '[{"q":"Second?","a":"no"}]' }
    const view = await mount(t, React.createElement(ProductForm, { product: first }))
    assert.equal(view.root.findByProps({ id: 'showQuestions', type: 'checkbox' }).props.checked, true)
    await act(async () => view.update(React.createElement(ProductForm, { product: second })))
    assert.equal(view.root.findByProps({ name: 'name', id: 'name' }).props.defaultValue, 'Second')
    assert.equal(JSON.parse(view.root.findByProps({ name: 'purchaseQuestions' }).props.value)[0].q, 'Second?')
    await act(async () => pending.get('first')({ ...first, name: 'Stale result' }))
    assert.equal(view.root.findByProps({ name: 'name', id: 'name' }).props.defaultValue, 'Second')
    await act(async () => pending.get('second')({ ...second, name: 'Latest second', purchaseQuestions: null }))
    assert.equal(view.root.findByProps({ name: 'name', id: 'name' }).props.defaultValue, 'Latest second')
    assert.equal(view.root.findByProps({ id: 'showQuestions', type: 'checkbox' }).props.checked, false)
    await act(async () => view.update(React.createElement(ProductForm, {})))
    assert.equal(view.root.findByProps({ name: 'name', id: 'name' }).props.defaultValue, '')
})

test('supplier form keeps drafts disabled, reports missing URLs locally and prevents repeated enable clicks', async t => {
    const calls = [], errors = [], messages = []
    let finishEnable
    const f = setup(t, {
        '@/actions/admin': {
            saveCardsApiConfig: async (...args) => { calls.push(['save', ...args]); return { success: true, enabled: args[3], mode: args[4], autoPulled: false } },
            setCardsApiEnabled: (...args) => { calls.push(['toggle', ...args]); return new Promise(resolve => { finishEnable = () => resolve({ success: true, enabled: args[1], mode: args[4], autoPulled: false }) }) },
        },
        '@/actions/inventory': { updateCardsExpiry: async () => {} },
        sonner: { toast: { success: message => messages.push(message), error: message => errors.push(message) } },
    })
    const { CardsContent } = f.load('components/admin/cards-content')
    const view = await mount(t, React.createElement(CardsContent, {
        productId: 'product', productName: 'Product', snapshotAt: Date.now(), unusedCards: [],
        apiConfig: { enabled: false, url: '', token: '', mode: 'on_demand' },
    }))
    const button = label => view.root.findAllByType('button').find(node => buttonName(node) === label)
    await act(async () => button('Save').props.onClick())
    assert.equal(calls.length, 1)
    assert.equal(calls[0][4], false)
    assert.ok(messages.some(message => message.includes('disabled')))
    await act(async () => button('Enable').props.onClick())
    assert.equal(calls.length, 1)
    assert.match(view.root.findByProps({ role: 'alert' }).children.join(''), /supplier URL/)
    assert.ok(errors.some(message => message.includes('supplier URL')))
    await act(async () => view.root.findByProps({ id: 'supplier-api-url', type: 'url' }).props.onChange({ target: { value: 'https://supplier.example/cards' } }))
    let first, second
    await act(async () => { first = button('Enable').props.onClick(); second = button('Enable').props.onClick() })
    assert.equal(calls.filter(call => call[0] === 'toggle').length, 1)
    await act(async () => { finishEnable(); await Promise.all([first, second]) })
    assert.ok(button('Disable'))
})

test('supplier form shows server validation errors without marking the feature enabled', async t => {
    const errors = []
    const f = setup(t, {
        '@/actions/admin': { setCardsApiEnabled: async () => ({ success: false, error: 'admin.cards.apiSharedUnsupported' }) },
        '@/actions/inventory': { updateCardsExpiry: async () => {} },
        sonner: { toast: { success() { assert.fail('Validation must not be reported as success') }, error: message => errors.push(message) } },
    })
    const { CardsContent } = f.load('components/admin/cards-content')
    const view = await mount(t, React.createElement(CardsContent, {
        productId: 'product', productName: 'Product', snapshotAt: Date.now(), unusedCards: [],
        apiConfig: { enabled: false, url: 'https://supplier.example/cards', token: '', mode: 'on_demand' },
    }))
    const button = () => view.root.findAllByType('button').find(node => buttonName(node) === 'Enable')
    await act(async () => button().props.onClick())
    assert.ok(button())
    assert.match(view.root.findByProps({ role: 'alert' }).children.join(''), /Shared-card/)
    assert.equal(errors.length, 1)
})

test('key list supports view, clipboard fallback and reset without deleting its configuration', async t => {
    const errors = [], resets = []
    const f = setup(t, { '@/actions/inventory': {
        viewInventoryKey: async () => ({ success: true, token: 'VISIBLE-TEST-KEY' }),
        resetInventoryKey: async id => { resets.push(id); return { success: true, token: 'RESET-TEST-KEY' } },
    }, sonner: { toast: { success() {}, error: message => errors.push(message) } } }, {
        navigator: { clipboard: { writeText: async () => { throw new Error('Clipboard denied') } } },
    })
    const { InventoryApiContent } = f.load('components/admin/inventory-api-content')
    const view = await mount(t, React.createElement(InventoryApiContent, {
        keysData: [{ id: 'key', name: 'Tool', prefix: 'ldc_inv_test', productIds: '[]', canRead: true, canWrite: true, enabled: true, expiresAt: null, lastUsedAt: null, recoverable: true }],
        products: [], logs: [], page: 1, hasNext: false, keyFilter: '', statusFilter: '', alertMinutes: 60,
    }))
    const button = label => view.root.findAllByType('button').find(node => buttonName(node) === label)
    const field = () => view.root.findByProps({ 'aria-label': 'Restock key', readOnly: true })
    await act(async () => button('View').props.onClick())
    assert.equal(field().props.value, 'VISIBLE-TEST-KEY')
    await act(async () => button('Copy').props.onClick())
    assert.match(errors.at(-1), /copy it manually/)
    assert.equal(field().props.value, 'VISIBLE-TEST-KEY')
    await act(async () => button('Reset').props.onClick())
    assert.deepEqual(resets, [])
    await act(async () => button('Confirm').props.onClick())
    assert.deepEqual(resets, ['key'])
    assert.equal(field().props.value, 'RESET-TEST-KEY')
})

test('key deletion requires confirmation, shows failures and blocks duplicate clicks while clearing its log filter', async t => {
    const errors = [], deleted = [], navigated = []
    let release, fail = true
    const f = setup(t, {
        '@/actions/inventory': { deleteInventoryKey: async id => {
            deleted.push(id)
            if (fail) return { success: false, error: 'inventory.keyDeleteFailed' }
            return new Promise(resolve => { release = resolve })
        } },
        'next/navigation': { useRouter: () => ({ refresh() {}, replace: url => navigated.push(url) }) },
        sonner: { toast: { success() {}, error: message => errors.push(message) } },
    })
    const { InventoryApiContent } = f.load('components/admin/inventory-api-content')
    const view = await mount(t, React.createElement(InventoryApiContent, {
        keysData: [{ id: 'key', name: 'Tool', prefix: 'ldc_inv_test', productIds: '[]', canRead: true, canWrite: true, enabled: true, expiresAt: null, lastUsedAt: null, recoverable: true }],
        products: [], logs: [], page: 3, hasNext: false, keyFilter: 'key', statusFilter: 'error', alertMinutes: 60,
    }))
    const open = () => view.root.findAllByType('button').find(node => buttonName(node) === 'Delete').props.onClick()
    const active = () => view.root.findAllByType('dialog').find(node => node.props.open)
    const button = label => active().findAllByType('button').find(node => buttonName(node) === label)
    await act(async () => open())
    assert.deepEqual(deleted, [])
    await act(async () => button('Cancel').props.onClick())
    assert.equal(active(), undefined)
    assert.deepEqual(deleted, [])
    await act(async () => open())
    await act(async () => button('Confirm').props.onClick())
    assert.deepEqual(deleted, ['key'])
    assert.match(errors.at(-1), /Could not delete/)
    assert.ok(active())
    fail = false
    await act(async () => button('Confirm').props.onClick())
    assert.equal(button('Confirm').props.disabled, true)
    await act(async () => button('Confirm').props.onClick())
    assert.deepEqual(deleted, ['key', 'key'])
    await act(async () => release({ success: true }))
    assert.equal(active(), undefined)
    const url = new URL(navigated[0], 'https://shop.example')
    assert.equal(url.searchParams.get('key'), '')
    assert.equal(url.searchParams.get('status'), 'error')
    assert.equal(url.searchParams.get('page'), '1')
})

test('manual restocking shows provider failure messages without a success toast', async t => {
    const errors = []
    const f = setup(t, {
        '@/actions/admin': { pullCardFromApi: async () => ({ success: false, error: 'api_request_failed_520' }) },
        '@/actions/inventory': { updateCardsExpiry: async () => {} },
        sonner: { toast: { success() { assert.fail('A failed pull must not show success') }, error: message => errors.push(message) } },
    })
    const { CardsContent } = f.load('components/admin/cards-content')
    const view = await mount(t, React.createElement(CardsContent, {
        productId: 'product', productName: 'Product', snapshotAt: Date.now(), unusedCards: [],
        apiConfig: { enabled: true, url: 'https://supplier.example/cards', token: '', mode: 'stock' },
    }))
    await act(async () => view.root.findAllByType('button').find(node => buttonName(node) === 'Pull 1 Card').props.onClick())
    assert.match(errors.at(-1), /HTTP 520/)
})

test('delivery retries display the actual supplier result, refresh the list and prevent duplicate clicks', async t => {
    const errors = [], information = [], successes = []
    let release, calls = 0, refreshes = 0
    const f = setup(t, {
        '@/actions/inventory': { retryOrderDelivery: async () => { calls++; return new Promise(resolve => { release = resolve }) } },
        '@/actions/admin-orders': {},
        'next/navigation': { useRouter: () => ({ refresh() { refreshes++ } }) },
        sonner: { toast: { success: message => successes.push(message), error: message => errors.push(message), info: message => information.push(message) } },
    })
    const { AdminOrderActions } = f.load('components/admin/order-actions')
    const view = await mount(t, React.createElement(AdminOrderActions, { order: { orderId: 'retry', productId: 'product', status: 'paid', cardKey: null } }))
    const button = () => view.root.findAllByType('button').find(node => buttonName(node) === 'Retry delivery')
    for (const error of ['supplier_http_401', 'supplier_http_521', 'supplier_processing', null]) {
        await act(async () => { button().props.onClick() })
        assert.equal(button().props.disabled, true)
        await act(async () => { button().props.onClick() })
        await act(async () => release({ delivered: false, supplierError: error }))
        assert.equal(button().props.disabled, false)
    }
    assert.equal(calls, 4)
    assert.equal(refreshes, 4)
    assert.match(errors[0], /HTTP 401/)
    assert.match(errors[1], /HTTP 521/)
    assert.match(information[0], /processing/)
    assert.match(information[1], /Restock/)
    assert.deepEqual(successes, [])
    await act(async () => { button().props.onClick() })
    await act(async () => release({ delivered: true, supplierError: null }))
    assert.equal(successes.length, 1)
    assert.equal(refreshes, 5)
})

test('supplier URL recovery requires confirmation, preserves the reviewed URL and blocks duplicate submissions', async t => {
    const calls = [], successes = [], errors = []
    let release, refreshes = 0
    const info = { orderId: 'order', currentUrl: 'https://new.example/cards', previousUrls: ['https://old.example/cards'], requestIds: ['preserved-id'] }
    const f = setup(t, {
        '@/actions/inventory': {
            getSupplierRecoveryInfo: async () => ({ success: true, info }),
            resumeSupplierOrder: async (...args) => { calls.push(args); return new Promise(resolve => { release = resolve }) },
        },
        'next/navigation': { useRouter: () => ({ refresh() { refreshes++ } }) },
        sonner: { toast: { success: message => successes.push(message), error: message => errors.push(message), info() {} } },
    })
    const { SupplierRecoveryButton } = f.load('components/admin/supplier-recovery-button')
    const view = await mount(t, React.createElement(SupplierRecoveryButton, { orderId: 'order' }))
    const button = label => view.root.findAllByType('button').find(node => buttonName(node) === label)
    await act(async () => button('Update supplier URL').props.onClick())
    assert.equal(button('Update and retry').props.disabled, true)
    await act(async () => { button('Update and retry').props.onClick() })
    assert.deepEqual(calls, [])
    await act(async () => view.root.findByType('input').props.onCheckedChange(true))
    await act(async () => { button('Update and retry').props.onClick() })
    assert.equal(button('Update and retry').props.disabled, true)
    await act(async () => { button('Update and retry').props.onClick() })
    assert.deepEqual(calls, [['order', info.currentUrl, true]])
    await act(async () => release({ success: true, delivered: true }))
    assert.equal(successes.length, 1)
    assert.equal(errors.length, 0)
    assert.equal(refreshes, 1)
    assert.equal(view.root.findByType('dialog').props.open, false)
})

test('order detail retries show the actual failure and refund success refreshes the pending list', async t => {
    const errors = []
    let refreshes = 0, refunds = 0, release
    const f = setup(t, {
        '@/actions/inventory': { retryOrderDelivery: async () => ({ delivered: false, supplierError: 'supplier_http_401' }) },
        '@/actions/admin-orders': {},
        '@/actions/refund': { proxyRefund: async () => { refunds++; return new Promise(resolve => { release = resolve }) } },
        '@/components/copy-button': { CopyButton: () => null },
        '@/components/client-date': { ClientDate: () => null },
        'next/navigation': { useRouter: () => ({ refresh() { refreshes++ } }) },
        sonner: { toast: { success() {}, error: value => errors.push(value), info() {} } },
    }, { confirm: () => true })
    const order = { orderId: 'paid-order', productId: 'product', productName: 'Product', amount: '3', status: 'paid', cardKey: null, tradeNo: 'test-trade', username: 'buyer' }
    const { AdminOrderDetailContent } = f.load('components/admin/order-detail-content')
    const view = await mount(t, React.createElement(AdminOrderDetailContent, { order }))
    await act(async () => view.root.findAllByType('button').find(node => buttonName(node) === 'Retry delivery').props.onClick())
    assert.match(errors[0], /HTTP 401/)
    assert.equal(refreshes, 1)
    const { RefundButton } = f.load('components/admin/refund-button')
    const button = () => view.root.findByType(RefundButton).findAllByType('button')[1]
    await act(async () => { button().props.onClick() })
    await act(async () => { button().props.onClick() })
    assert.equal(refunds, 1)
    await act(async () => release({ processed: true }))
    assert.equal(refreshes, 2)
})

test('refund buttons translate uncertainty, verify before retry and require the reviewed confirmation', async t => {
    const errors = [], confirmations = [], submitted = [], successes = []
    let marked = 0, verified = 0
    const f = setup(t, {
        '@/actions/admin-orders': { verifyOrderRefundStatus: async () => { verified++; return { success: true, status: 1, canRetry: true, needsReview: true } } },
        '@/actions/refund': {
            proxyRefund: async (id, confirmed) => {
                submitted.push({ id, confirmed })
                return submitted.length === 1
                    ? { processed: false, needsVerification: true, message: 'Raw internal message', messageKey: 'admin.orders.refundNeedsVerification' }
                    : { processed: true }
            },
            markOrderRefunded: async () => { marked++ },
        },
        sonner: { toast: { success: value => successes.push(value), error: value => errors.push(value), info() {} } },
    }, { confirm: message => { confirmations.push(message); return true } })
    const { RefundButton } = f.load('components/admin/refund-button')
    const view = await mount(t, React.createElement(RefundButton, { order: { orderId: 'refund-order', amount: '3', status: 'paid', tradeNo: 'trade' } }))
    const buttons = () => view.root.findAllByType('button')
    await act(async () => buttons()[1].props.onClick())
    assert.match(errors[0], /refund result is uncertain/i)
    assert.ok(!errors[0].includes('Raw internal message'))
    assert.equal(buttons()[1].props.disabled, true)
    assert.equal(buttons().length, 3)
    await act(async () => buttons()[0].props.onClick())
    assert.equal(verified, 1)
    assert.equal(buttons()[1].props.disabled, false)
    assert.equal(buttons().length, 2)
    await act(async () => buttons()[1].props.onClick())
    assert.match(confirmations[1], /previous request has stopped without refunding/i)
    assert.deepEqual(submitted, [{ id: 'refund-order', confirmed: false }, { id: 'refund-order', confirmed: true }])
    assert.equal(marked, 0)
    assert.equal(successes.length, 1)
})

test('a rejected or active refund keeps the compact controls and never suggests a manual completed refund', async t => {
    const messages = []
    let response = { processed: false, inProgress: true, messageKey: 'admin.orders.refundInProgress' }
    const f = setup(t, {
        '@/actions/admin-orders': {},
        '@/actions/refund': { proxyRefund: async () => response },
        sonner: { toast: { success() {}, error: value => messages.push(value), info() {} } },
    }, { confirm: () => true })
    const { RefundButton } = f.load('components/admin/refund-button')
    const view = await mount(t, React.createElement(RefundButton, { compact: true, order: { orderId: 'refund-order', amount: '3', status: 'paid', tradeNo: 'trade' } }))
    const buttons = () => view.root.findAllByType('button')
    await act(async () => buttons()[1].props.onClick())
    assert.equal(buttons().length, 2)
    assert.match(messages[0], /in progress/i)
    response = { processed: false, messageKey: 'admin.orders.refundRejected' }
    await act(async () => buttons()[1].props.onClick())
    assert.equal(buttons().length, 2)
    assert.equal(buttons()[1].props.disabled, false)
    assert.match(messages[1], /rejected the refund/i)
})

const emptyBuyMeta = { reviews: [], averageRating: 0, reviewCount: 0, canReview: false, emailConfigured: false }
const questionProduct = { id: 'product', name: 'Product', price: '1', description: null, image: null, category: null,
    purchaseQuestions: JSON.stringify([{ q: 'Question?' }]) }

function questionClient(t, verifyPurchaseAnswers) {
    return setup(t, {
        '@/lib/auth': { auth: async () => null },
        '@/actions/buy': { getBuyPageMeta: async () => emptyBuyMeta, verifyPurchaseAnswers },
        '@/actions/points': { getUserPoints: async () => 0 },
        '@/actions/checkout': { createOrder: async () => ({ success: false, error: 'buy.questionsWrong' }) },
        '@/components/ui/dialog': { ...dialog, DialogTrigger: host('span') },
    }, { window: { location: { href: 'https://shop.example/buy/product', pathname: '/buy/product', search: '' } } })
}

test('purchase questions wait for the server, prevent duplicate verification and reopen after checkout rejection', async t => {
    let release
    const calls = []
    const f = questionClient(t, async (id, answers) => { calls.push({ id, answers: Array.from(answers) }); return new Promise(resolve => { release = resolve }) })
    const { BuyContent } = f.load('components/buy-content')
    const { BuyButton } = f.load('components/buy-button')
    const view = await mount(t, React.createElement(BuyContent, { product: questionProduct, stockCount: 1, isLoggedIn: true }))
    const answer = () => view.root.findAllByType('input').find(node => node.props.placeholder === 'Enter your answer')
    const verify = () => view.root.findAllByType('button').find(node => buttonName(node) === 'Verify Answers')
    await act(async () => answer().props.onChange({ target: { value: 'My answer' } }))
    await act(async () => { verify().props.onClick(); verify().props.onClick() })
    assert.deepEqual(calls, [{ id: 'product', answers: ['My answer'] }])
    assert.equal(verify().props.disabled, true)
    assert.equal(answer().props.disabled, true)
    assert.equal(view.root.findAllByType(BuyButton).length, 0)
    await act(async () => release({ success: false, error: 'buy.questionsWrong' }))
    assert.equal(verify().props.disabled, false)
    await act(async () => { verify().props.onClick() })
    await act(async () => release({ success: true }))
    const buy = view.root.findByType(BuyButton)
    await act(async () => buy.findAllByType('button')[0].props.onClick())
    await act(async () => buy.findAllByType('button').find(node => buttonName(node) === 'Proceed to Payment').props.onClick())
    assert.equal(view.root.findAllByType(BuyButton).length, 0)
    assert.equal(answer().props.disabled, false)
    assert.equal(answer().props.value, 'My answer')
})

test('verification for an old variant cannot unlock the newly selected variant', async t => {
    let release
    const f = questionClient(t, async () => new Promise(resolve => { release = resolve }))
    const { BuyContent } = f.load('components/buy-content')
    const { BuyButton } = f.load('components/buy-button')
    const variants = [
        { ...questionProduct, variantLabel: 'First', stockCount: 1, lockedCount: 0 },
        { ...questionProduct, id: 'second', name: 'Second', variantLabel: 'Second', stockCount: 1, lockedCount: 0 },
    ]
    const view = await mount(t, React.createElement(BuyContent, { product: questionProduct, variants, stockCount: 1, isLoggedIn: true }))
    const answer = () => view.root.findAllByType('input').find(node => node.props.placeholder === 'Enter your answer')
    await act(async () => answer().props.onChange({ target: { value: 'First answer' } }))
    await act(async () => { view.root.findAllByType('button').find(node => buttonName(node) === 'Verify Answers').props.onClick() })
    await act(async () => view.root.findAllByType('button').find(node => buttonName(node) === 'Second').props.onClick())
    await act(async () => release({ success: true }))
    assert.equal(view.root.findAllByType(BuyButton).length, 0)
    assert.equal(answer().props.value, '')
    assert.equal(answer().props.disabled, false)
})
