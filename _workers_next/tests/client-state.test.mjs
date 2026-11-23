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

function setup(t, mocks = {}) {
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
        globals: { window, localStorage: storage, document, Event },
        mocks: {
            react: React,
            'next/link': host('a'),
            'next/navigation': { useRouter: () => ({ push: url => pushed.push(url) }) },
            'react-markdown': host('article'),
            '@/components/ui/button': { Button: host('button') },
            '@/components/ui/input': { Input: host('input') },
            '@/components/ui/label': { Label: host('label') },
            '@/components/ui/dialog': dialog,
            '@/components/ui/card': Object.fromEntries(['Card', 'CardContent', 'CardFooter', 'CardHeader', 'CardTitle'].map(name => [name, host('div')])),
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
