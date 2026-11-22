import { checkRepositoryForUpdates, type UpdateCheckResult } from '@/lib/update-check'

export type ClientUpdateCheckResult = UpdateCheckResult

export async function checkForUpdatesClient(currentVersion: string): Promise<ClientUpdateCheckResult> {
    return checkRepositoryForUpdates(currentVersion)
}
