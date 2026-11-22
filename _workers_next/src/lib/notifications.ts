import { db } from "./db"
import { settings } from "./db/schema"
import { inArray } from "drizzle-orm"
import { resolveEffectiveShopLogo } from "@/lib/shop-logo"
import { getAppBaseUrl } from "@/lib/url"

async function getSettingsUncached(keys: string[]): Promise<Record<string, string>> {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value })
            .from(settings)
            .where(inArray(settings.key, keys))

        const map: Record<string, string> = {}
        for (const row of rows) {
            map[row.key] = row.value || ""
        }
        return map
    } catch (error: any) {
        const text = `${error?.message || ""}${JSON.stringify(error || {})}`.toLowerCase()
        if (text.includes("no such table") && text.includes("settings")) {
            return {}
        }
        throw error
    }
}

function toAbsoluteUrl(input: string, baseUrl: string) {
    const raw = (input || "").trim()
    if (!raw) return ""
    try {
        const url = new URL(raw)
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : ''
    } catch {
        if (!baseUrl) return ""
        try {
            const url = new URL(raw, baseUrl)
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : ''
        } catch {
            return ""
        }
    }
}

function escapeHtml(value: string) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

export async function getNotificationSettings() {
    const values = await getSettingsUncached([
        'telegram_bot_token',
        'telegram_chat_id',
        'telegram_language',
        'telegram_enabled',
        'bark_enabled',
        'bark_server_url',
        'bark_device_key',
        'shop_logo',
        'shop_logo_source',
        'shop_logo_updated_at',
    ])

    const token = (values.telegram_bot_token || '').trim()
    const chatId = (values.telegram_chat_id || '').trim()
    const language = values.telegram_language || 'zh' // 默认中文
    // Backward compatible: if explicit switch not set, treat configured token+chat as enabled.
    const telegramEnabledRaw = values.telegram_enabled
    const telegramEnabled =
        telegramEnabledRaw === 'true' ||
        (telegramEnabledRaw !== 'false' && !!token && !!chatId)
    const barkEnabled = values.bark_enabled === 'true'
    const barkServerUrl = (values.bark_server_url || 'https://api.day.app').trim() || 'https://api.day.app'
    const barkDeviceKey = (values.bark_device_key || '').trim()
    const appBaseUrl = getAppBaseUrl()
    const shopLogo = resolveEffectiveShopLogo(values.shop_logo || "", values.shop_logo_source || "").effectiveLogo
    const shopLogoUpdatedAt = (values.shop_logo_updated_at || "").trim()
    const logoUrl = toAbsoluteUrl(shopLogo, appBaseUrl)
    const barkIconUrl = logoUrl && logoUrl.length <= 2048 ? logoUrl
        : (appBaseUrl ? `${appBaseUrl}/favicon${shopLogoUpdatedAt ? `?v=${encodeURIComponent(shopLogoUpdatedAt.slice(0, 100))}` : ""}` : "")

    return {
        token,
        chatId,
        language,
        telegramEnabled,
        barkEnabled,
        barkServerUrl,
        barkDeviceKey,
        barkIconUrl,
    }
}

export async function sendTelegramMessage(text: string) {
    try {
        const { telegramEnabled, token, chatId } = await getNotificationSettings()

        if (!telegramEnabled) {
            console.log('[Notification] Telegram skipped: disabled')
            return { success: false, error: 'Telegram disabled' }
        }

        if (!token || !chatId) {
            console.log('[Notification] Skipped: Missing token or chat_id')
            return { success: false, error: 'Missing configuration' }
        }

        const url = `https://api.telegram.org/bot${token}/sendMessage`
        const body = {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body), signal: AbortSignal.timeout(15_000), redirect: 'error',
        })

        if (!response.ok) {
            const error = await response.text()
            console.error('[Notification] Telegram API Error:', error)
            return { success: false, error }
        }

        return { success: true }
    } catch (e: any) {
        console.error('[Notification] Send Error:', e)
        return { success: false, error: e.message }
    }
}

function normalizeBarkServerUrl(raw: string) {
    const trimmed = (raw || "").trim()
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const parsed = new URL(withProtocol)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid Bark server address')
    const pathname = parsed.pathname.replace(/\/+$/, "")
    return `${parsed.origin}${pathname}`
}

function truncatePushText(value: string, maxBytes: number) {
    const encoder = new TextEncoder()
    let bytes = 0, result = ''
    for (const character of value) {
        const size = encoder.encode(character).length
        if (bytes + size > maxBytes) break
        bytes += size
        result += character
    }
    return result
}

export async function sendBarkMessage(title: string, body: string, options?: { url?: string; group?: string }) {
    try {
        const { barkEnabled, barkServerUrl, barkDeviceKey, barkIconUrl } = await getNotificationSettings()
        if (!barkEnabled) return { success: false, error: 'Bark disabled' }
        if (!barkDeviceKey) return { success: false, error: 'Missing Bark device key' }
        const baseUrl = normalizeBarkServerUrl(barkServerUrl || 'https://api.day.app')
        const push = {
            device_key: barkDeviceKey,
            title: truncatePushText((title || 'LDC Shop').trim() || 'LDC Shop', 256),
            body: truncatePushText((body || '-').trim() || '-', 2400),
            ...(options?.group ? { group: truncatePushText(options.group, 100) } : {}),
            ...(options?.url && toAbsoluteUrl(options.url, '').length <= 1000 ? { url: toAbsoluteUrl(options.url, '') } : {}),
            ...(barkIconUrl ? { icon: barkIconUrl } : {}),
        }
        // JSON escaping and optional URLs also consume the APNs payload budget.
        while (new TextEncoder().encode(JSON.stringify(push)).length > 3500 && push.body.length > 1) {
            push.body = Array.from(push.body).slice(0, -100).join('') || '-'
        }
        if (new TextEncoder().encode(JSON.stringify(push)).length > 3500) delete push.icon
        if (new TextEncoder().encode(JSON.stringify(push)).length > 3500) delete push.url
        const response = await fetch(`${baseUrl}/push`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(push),
            cache: 'no-store', signal: AbortSignal.timeout(15_000), redirect: 'error',
        })
        if (!response.ok) {
            console.error('[Notification] Bark HTTP error:', response.status)
            return { success: false, error: `Bark HTTP ${response.status}${response.status >= 500 ? ' (服务暂时不可用，请稍后重试)' : ''}` }
        }
        const payload: unknown = await response.json()
        if (!payload || typeof payload !== 'object' || !('code' in payload) || payload.code !== 200) {
            return { success: false, error: 'Bark rejected the push; check the device key and server address' }
        }
        return { success: true }
    } catch {
        // Never log the request URL, JSON body or device key.
        console.error('[Notification] Bark request failed')
        return { success: false, error: 'Bark network error; check the server address and try again' }
    }
}
// 消息模板
const messages = {
    zh: {
        paymentTitle: '💰 收到新付款！',
        userMessageTitle: '📩 收到用户消息',
        order: '订单号',
        product: '商品',
        amount: '金额',
        title: '标题',
        content: '内容',
        user: '用户',
        tradeNo: '交易号',
        guest: '访客',
        noEmail: '无邮箱',
        refundTitle: '↩️ 收到退款申请',
        reason: '原因',
        noReason: '未提供原因',
        manageRefunds: '管理退款',
        manageMessages: '查看消息'
    },
    en: {
        paymentTitle: '💰 New Payment Received!',
        userMessageTitle: '📩 New User Message',
        order: 'Order',
        product: 'Product',
        amount: 'Amount',
        title: 'Title',
        content: 'Content',
        user: 'User',
        tradeNo: 'Trade No',
        guest: 'Guest',
        noEmail: 'No email',
        refundTitle: '↩️ Refund Requested',
        reason: 'Reason',
        noReason: 'No reason provided',
        manageRefunds: 'Manage Refunds',
        manageMessages: 'View Messages'
    }
}

export async function notifyAdminPaymentSuccess(order: {
    orderId: string,
    productName: string,
    amount: string,
    email?: string | null,
    username?: string | null,
    tradeNo?: string | null
}, channels?: { telegram?: boolean; bark?: boolean }) {
    const { language } = await getNotificationSettings()
    const t = messages[language as keyof typeof messages] || messages.zh

    const telegramText = `
<b>${t.paymentTitle}</b>

<b>${t.order}:</b> <code>${escapeHtml(order.orderId)}</code>
<b>${t.product}:</b> ${escapeHtml(order.productName)}
<b>${t.amount}:</b> ${escapeHtml(order.amount)}
<b>${t.user}:</b> ${escapeHtml(order.username || t.guest)} (${escapeHtml(order.email || t.noEmail)})
<b>${t.tradeNo}:</b> <code>${escapeHtml(order.tradeNo || 'N/A')}</code>
`.trim()

    const barkBody = [
        `${t.order}: ${order.orderId}`,
        `${t.product}: ${order.productName}`,
        `${t.amount}: ${order.amount}`,
        `${t.user}: ${order.username || t.guest} (${order.email || t.noEmail})`,
        `${t.tradeNo}: ${order.tradeNo || 'N/A'}`
    ].join('\n')

    const [telegramResult, barkResult] = await Promise.allSettled([
        channels?.telegram === false ? Promise.resolve({ success: true }) : sendTelegramMessage(telegramText),
        channels?.bark === false ? Promise.resolve({ success: true }) : sendBarkMessage(t.paymentTitle, barkBody, { group: 'LDC Shop' })
    ])

    const success =
        (telegramResult.status === 'fulfilled' && telegramResult.value.success) ||
        (barkResult.status === 'fulfilled' && barkResult.value.success)

    return { success,
        telegram: telegramResult.status === 'fulfilled' && telegramResult.value.success,
        bark: barkResult.status === 'fulfilled' && barkResult.value.success,
    }
}

export async function notifyAdminRefundRequest(order: {
    orderId: string,
    productName: string,
    amount: string,
    username?: string | null,
    reason?: string | null
}) {
    const { language } = await getNotificationSettings()
    const t = messages[language as keyof typeof messages] || messages.zh
    const appBaseUrl = getAppBaseUrl()
    const refundsUrl = appBaseUrl ? `${appBaseUrl}/admin/refunds` : ""

    const telegramText = `
<b>${t.refundTitle}</b>

<b>${t.order}:</b> <code>${escapeHtml(order.orderId)}</code>
<b>${t.product}:</b> ${escapeHtml(order.productName)}
<b>${t.amount}:</b> ${escapeHtml(order.amount)}
<b>${t.user}:</b> ${escapeHtml(order.username || t.guest)}
<b>${t.reason}:</b> ${escapeHtml(order.reason || t.noReason)}
${refundsUrl ? `\n<a href="${refundsUrl}">${t.manageRefunds}</a>` : ""}
`.trim()

    const barkBody = [
        `${t.order}: ${order.orderId}`,
        `${t.product}: ${order.productName}`,
        `${t.amount}: ${order.amount}`,
        `${t.user}: ${order.username || t.guest}`,
        `${t.reason}: ${order.reason || t.noReason}`,
        refundsUrl ? `${t.manageRefunds}: ${refundsUrl}` : ""
    ].filter(Boolean).join('\n')

    const [telegramResult, barkResult] = await Promise.allSettled([
        sendTelegramMessage(telegramText),
        sendBarkMessage(t.refundTitle, barkBody, { group: 'LDC Shop', ...(refundsUrl ? { url: refundsUrl } : {}) })
    ])

    const success =
        (telegramResult.status === 'fulfilled' && telegramResult.value.success) ||
        (barkResult.status === 'fulfilled' && barkResult.value.success)

    return { success }
}

export async function notifyAdminUserMessage(params: {
    userId: string
    username?: string | null
    title: string
    body: string
}) {
    const { language } = await getNotificationSettings()
    const t = messages[language as keyof typeof messages] || messages.zh
    const appBaseUrl = getAppBaseUrl()
    const messagesUrl = appBaseUrl ? `${appBaseUrl}/admin/messages` : ""

    const safeUsername = params.username || t.guest
    const safeTitle = (params.title || '').trim()
    const safeBody = (params.body || '').trim()

    const telegramText = `
<b>${t.userMessageTitle}</b>

<b>${t.user}:</b> ${escapeHtml(safeUsername)} (<code>${escapeHtml(params.userId)}</code>)
<b>${t.title}:</b> ${escapeHtml(safeTitle)}
<b>${t.content}:</b>
<pre>${escapeHtml(safeBody)}</pre>
${messagesUrl ? `\n<a href="${messagesUrl}">${t.manageMessages}</a>` : ""}
`.trim()

    const barkBody = [
        `${t.user}: ${safeUsername} (${params.userId})`,
        `${t.title}: ${safeTitle}`,
        `${t.content}: ${safeBody}`,
        messagesUrl ? `${t.manageMessages}: ${messagesUrl}` : ""
    ].filter(Boolean).join('\n')

    const [telegramResult, barkResult] = await Promise.allSettled([
        sendTelegramMessage(telegramText),
        sendBarkMessage(t.userMessageTitle, barkBody, { group: 'LDC Shop', ...(messagesUrl ? { url: messagesUrl } : {}) })
    ])

    const success =
        (telegramResult.status === 'fulfilled' && telegramResult.value.success) ||
        (barkResult.status === 'fulfilled' && barkResult.value.success)

    return { success }
}
