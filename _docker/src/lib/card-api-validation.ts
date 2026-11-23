export type CardApiMode = 'stock' | 'on_demand'
export type CardApiConfigErrorCode =
    | 'admin.cards.apiUrlRequired'
    | 'admin.cards.apiUrlInvalid'
    | 'admin.cards.apiUrlTooLong'
    | 'admin.cards.apiUrlQueryUnsupported'
    | 'admin.cards.apiTokenInvalid'
    | 'admin.cards.apiTokenTooLong'
    | 'admin.cards.apiModeInvalid'
    | 'admin.cards.apiProductMissing'
    | 'admin.cards.apiSharedUnsupported'

export class CardApiConfigError extends Error {
    constructor(readonly code: CardApiConfigErrorCode) {
        super(code)
        this.name = 'CardApiConfigError'
    }
}

// Share input validation between the form and server; disabled drafts may omit the URL.
export function validateCardApiConfig(input: { enabled: boolean; url: string; token: string; mode: string }): CardApiConfigErrorCode | null {
    const url = input.url.trim(), token = input.token.trim()
    if (input.mode !== 'stock' && input.mode !== 'on_demand') return 'admin.cards.apiModeInvalid'
    if (input.enabled && !url) return 'admin.cards.apiUrlRequired'
    if (url.length > 1000) return 'admin.cards.apiUrlTooLong'
    if (token.length > 1000) return 'admin.cards.apiTokenTooLong'
    if (/[\r\n\0]/.test(token)) return 'admin.cards.apiTokenInvalid'
    if (url) {
        try {
            const parsed = new URL(url)
            if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return 'admin.cards.apiUrlInvalid'
            if (input.mode === 'on_demand' && (parsed.search || parsed.hash)) return 'admin.cards.apiUrlQueryUnsupported'
        } catch { return 'admin.cards.apiUrlInvalid' }
    }
    return null
}
