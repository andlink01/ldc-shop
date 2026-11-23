type IssueKey = 'stock' | 'processing' | 'waiting' | 'disabled' | 'url' | 'endpointChanged' |
    'invalidResponse' | 'duplicateCard' | 'requestFailed' | 'unauthorized' | 'rateLimited' | 'unavailable' | 'redirect' | 'http'

const KNOWN_ISSUES: Record<string, IssueKey> = {
    supplier_processing: 'processing', supplier_request_in_progress: 'processing',
    supplier_waiting_for_cards: 'waiting', supplier_disabled: 'disabled',
    supplier_url_invalid: 'url', supplier_endpoint_changed: 'endpointChanged',
    supplier_invalid_response: 'invalidResponse', supplier_duplicate_card: 'duplicateCard',
    supplier_request_failed: 'requestFailed', inventory_event_failed: 'requestFailed',
}

export function getDeliveryIssue(error: string | null | undefined, onDemand = false) {
    let key: IssueKey = error ? (Object.hasOwn(KNOWN_ISSUES, error) ? KNOWN_ISSUES[error] : 'requestFailed') : onDemand ? 'waiting' : 'stock'
    const http = /^supplier_http_([1-5]\d{2})$/.exec(error || '')
    const status = http ? Number(http[1]) : undefined
    if (status) {
        key = status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'rateLimited' :
            status >= 500 ? 'unavailable' : status >= 300 && status < 400 ? 'redirect' : 'http'
    }
    return {
        key, status,
        severity: key === 'processing' ? 'processing' as const :
            key === 'stock' || key === 'waiting' ? 'waiting' as const : 'attention' as const,
        // Arbitrary supplier text can contain secrets. Render only known internal codes.
        code: error && (http || Object.hasOwn(KNOWN_ISSUES, error)) ? error : undefined,
    }
}
