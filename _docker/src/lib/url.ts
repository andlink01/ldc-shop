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

export function getRequestBaseUrl(request: Request): string {
    const configured = getAppBaseUrl()
    if (configured) return configured

    // Proxy headers are used only when the deployment explicitly trusts its proxy.
    if (process.env.AUTH_TRUST_HOST === 'true') {
        const host = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '').split(',')[0].trim()
        const protocol = (request.headers.get('x-forwarded-proto') || 'https').split(',')[0].trim()
        if (host && ['http', 'https'].includes(protocol)) {
            try {
                const url = new URL(`${protocol}://${host}`)
                if (!url.username && !url.password && url.host === host) return url.origin
            } catch { /* use the request origin */ }
        }
    }
    return new URL(request.url).origin
}
