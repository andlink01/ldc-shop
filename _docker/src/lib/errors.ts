function errorRecord(error: unknown): Record<string, unknown> {
    return error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
}

export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
    if (error instanceof Error) return error.message || fallback
    const message = errorRecord(error).message
    return typeof message === 'string' ? message : typeof error === 'string' ? error : fallback
}

export function getErrorCode(error: unknown): string | undefined {
    const code = errorRecord(error).code
    return typeof code === 'string' ? code : undefined
}

export function getErrorCauseMessage(error: unknown): string {
    return getErrorMessage(errorRecord(error).cause, '')
}

export function getErrorText(error: unknown): string {
    let serialized = ''
    try { serialized = JSON.stringify(error) || '' } catch { /* Errors can have circular causes. */ }
    return `${getErrorMessage(error, '')}${getErrorCauseMessage(error)}${serialized}${String(error)}`
}
