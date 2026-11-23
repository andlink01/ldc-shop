import { checkForUpdates } from '@/actions/update-check'
import type { UpdateCheckResult } from '@/lib/update-check'

export type ClientUpdateCheckResult = UpdateCheckResult

export async function checkForUpdatesClient(currentVersion: string): Promise<ClientUpdateCheckResult> {
    try {
        // Query through the shop so the browser does not need access to GitHub's raw-content domain.
        return await checkForUpdates()
    } catch {
        return { hasUpdate: false, currentVersion, latestVersion: null, releaseUrl: null, error: 'update.requestFailed' }
    }
}
