"use server"

import { APP_VERSION } from '@/lib/version'
import { checkRepositoryForUpdates, type UpdateCheckResult } from '@/lib/update-check'
import { checkAdmin } from '@/actions/admin'

export async function checkForUpdates(): Promise<UpdateCheckResult> {
    await checkAdmin()
    return checkRepositoryForUpdates(APP_VERSION)
}

export async function getCurrentVersion(): Promise<string> {
    return APP_VERSION
}
