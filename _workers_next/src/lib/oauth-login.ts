export type LoginProvider = 'linuxdo' | 'github'

export class LoginRequestError extends Error {
    constructor(readonly code: string) { super(code) }
}

export function loginErrorMessage(error: string | null): string | null {
    if (!error) return null
    if (error === 'Configuration') return 'login.configurationFailed'
    if (error === 'AccessDenied') return 'login.accessDenied'
    if (error === 'MissingCSRF' || error === 'InvalidCheck') return 'login.sessionCheckFailed'
    return 'login.authorizationFailed'
}

async function requestJson(path: string, init: RequestInit, retry: boolean): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 8000)
        try {
            const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: controller.signal })
            if (response.status === 401 || response.status === 403) throw new LoginRequestError('login.requestBlocked')
            if (!response.ok) throw new LoginRequestError('login.requestFailed')
            const body: unknown = await response.json()
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LoginRequestError('login.invalidResponse')
            return body as Record<string, unknown>
        } catch (error) {
            if (error instanceof LoginRequestError && error.code === 'login.requestBlocked') throw error
            if (!retry || attempt >= 1) {
                if (controller.signal.aborted) throw new LoginRequestError('login.timedOut')
                if (error instanceof LoginRequestError) throw error
                throw new LoginRequestError('login.requestFailed')
            }
        } finally { clearTimeout(timeout) }
        // Only retry the read-only CSRF request; never repeat a sign-in POST automatically.
        await new Promise(resolve => setTimeout(resolve, 300))
    }
}

export async function startOAuthLogin(provider: LoginProvider, callbackUrl: string, origin: string): Promise<string> {
    const base = new URL(origin)
    let returnTo = '/'
    try {
        const target = new URL(callbackUrl, base)
        if (target.origin === base.origin) returnTo = `${target.pathname}${target.search}${target.hash}`
    } catch { /* Use the shop home for invalid return addresses. */ }
    const csrf = await requestJson('/api/auth/csrf', { method: 'GET' }, true)
    if (typeof csrf.csrfToken !== 'string' || !csrf.csrfToken) throw new LoginRequestError('login.sessionCheckFailed')
    // These are Auth.js's normal CSRF-protected OAuth endpoints. No provider-list request is needed.
    const result = await requestJson(`/api/auth/signin/${provider}`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' },
        body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: returnTo }),
    }, false)
    if (typeof result.url !== 'string') throw new LoginRequestError('login.invalidResponse')
    let authorization: URL
    try { authorization = new URL(result.url, base) } catch { throw new LoginRequestError('login.invalidResponse') }
    if (authorization.origin === base.origin) {
        throw new LoginRequestError(loginErrorMessage(authorization.searchParams.get('error')) || 'login.authorizationFailed')
    }
    const expected = provider === 'linuxdo' ? 'https://connect.linux.do/oauth2/authorize' : 'https://github.com/login/oauth/authorize'
    if (`${authorization.origin}${authorization.pathname}` !== expected || authorization.username || authorization.password) {
        throw new LoginRequestError('login.invalidResponse')
    }
    return authorization.toString()
}
