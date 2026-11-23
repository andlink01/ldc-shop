type TokenErrorCode = 'inventory.keyLegacyUnavailable' | 'inventory.keyDecryptFailed' | 'inventory.keySecretMissing' | 'inventory.keyNotFound'
    | 'inventory.keyInvalidSettings' | 'inventory.keyProductMissing' | 'inventory.keyExpiryInvalid'

export class InventoryTokenError extends Error {
    constructor(readonly code: TokenErrorCode) { super(code); this.name = 'InventoryTokenError' }
}

async function encryptionKey() {
    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || process.env.OAUTH_CLIENT_SECRET
    if (!secret) throw new InventoryTokenError('inventory.keySecretMissing')
    const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ldc:inventory-token:v1:${secret}`))
    return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)) }
function decode(value: string) { return Uint8Array.from(atob(value), character => character.charCodeAt(0)) }

export async function encryptInventoryToken(token: string, id: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) },
        await encryptionKey(), new TextEncoder().encode(token))
    return `v1.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`
}

export async function decryptInventoryToken(value: string, id: string) {
    try {
        const [version, iv, ciphertext, extra] = value.split('.')
        if (version !== 'v1' || !iv || !ciphertext || extra !== undefined) throw new Error('Invalid encrypted token')
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: new TextEncoder().encode(id) },
            await encryptionKey(), decode(ciphertext))
        return new TextDecoder().decode(plaintext)
    } catch (error) {
        if (error instanceof InventoryTokenError) throw error
        throw new InventoryTokenError('inventory.keyDecryptFailed')
    }
}
