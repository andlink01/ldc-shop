"use server"

import { APP_VERSION } from '@/lib/version'
import { checkRepositoryForUpdates, type UpdateCheckResult } from '@/lib/update-check'

export async function checkForUpdates(): Promise<UpdateCheckResult> {
    return checkRepositoryForUpdates(APP_VERSION)
}

export async function getCurrentVersion(): Promise<string> {
    return APP_VERSION
}
