// Runs an idempotent setup step (such as CREATE TABLE IF NOT EXISTS) once per
// server instance rather than on every request. A failed run is retried.
export function oncePerIsolate(task: () => Promise<void>) {
    let ready: Promise<void> | null = null
    return () => ready ??= task().catch((error) => {
        ready = null
        throw error
    })
}
