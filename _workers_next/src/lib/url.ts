export function getAppBaseUrl(): string {
    const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || ''
    if (!configured) return ''
    try {
        const url = new URL(configured)
        return ['http:', 'https:'].includes(url.protocol) ? url.origin : ''
    } catch {
        return ''
    }
}

function parseTrustedOrigin(hostHeader: string | null, protocolHeader: string | null): string {
    const host = (hostHeader || '').split(',')[0].trim()
    const protocol = (protocolHeader || '').split(',')[0].trim().toLowerCase()
    if (!host || !['http', 'https'].includes(protocol)) return ''
    try {
        const url = new URL(`${protocol}://${host}`)
        if (!url.username && !url.password && url.host === host) return url.origin
    } catch { /* ignore invalid host/protocol */ }
    return ''
}

export function getBaseUrlFromHeaders(
    headerList: { get(name: string): string | null },
    fallback = ''
): string {
    const configured = getAppBaseUrl()
    if (configured) return configured

    // Proxy headers are used only when the deployment explicitly trusts its proxy.
    if (process.env.AUTH_TRUST_HOST === 'true') {
        const forwarded = parseTrustedOrigin(
            headerList.get('x-forwarded-host') || headerList.get('host'),
            headerList.get('x-forwarded-proto') || 'https'
        )
        if (forwarded) return forwarded
    }

    const host = (headerList.get('host') || '').split(',')[0].trim()
    if (host) {
        const defaultProto =
            process.env.NODE_ENV === 'development' || /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)
                ? 'http'
                : 'https'
        const direct = parseTrustedOrigin(host, defaultProto)
        if (direct) return direct
    }

    return fallback
}

export function getRequestBaseUrl(request: Request): string {
    const configured = getAppBaseUrl()
    if (configured) return configured

    // Proxy headers are used only when the deployment explicitly trusts its proxy.
    if (process.env.AUTH_TRUST_HOST === 'true') {
        const forwarded = parseTrustedOrigin(
            request.headers.get('x-forwarded-host') || request.headers.get('host'),
            request.headers.get('x-forwarded-proto') || 'https'
        )
        if (forwarded) return forwarded
    }
    return new URL(request.url).origin
}
