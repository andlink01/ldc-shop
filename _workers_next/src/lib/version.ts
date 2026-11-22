import packageJson from "../../package.json"

export const APP_VERSION = packageJson.version
export const APP_DIRECTORY = packageJson.name === 'ldc-shop-docker' ? '_docker' : '_workers_next'
