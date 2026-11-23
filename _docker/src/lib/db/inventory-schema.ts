import { dbExecRaw, dbRun } from './index'
import { sql } from 'drizzle-orm'
import { getErrorText } from '@/lib/errors'
import { INVENTORY_FEATURE_SCHEMA } from './inventory-schema-definition'

export { INVENTORY_FEATURE_SCHEMA } from './inventory-schema-definition'

export async function ensureInventoryFeatureTables() {
    await dbExecRaw(INVENTORY_FEATURE_SCHEMA)
    const columns = await dbRun<{ name: string }>(sql`PRAGMA table_info(inventory_api_keys)`)
    if (!columns.results.some(column => column.name === 'token_encrypted')) {
        try { await dbExecRaw('ALTER TABLE inventory_api_keys ADD COLUMN token_encrypted TEXT;') }
        catch (error) { if (!getErrorText(error).toLowerCase().includes('duplicate column')) throw error }
    }
}
