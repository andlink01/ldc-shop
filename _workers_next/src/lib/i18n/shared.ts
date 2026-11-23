export type Locale = "en" | "zh";

export function getNestedTranslation(obj: unknown, path: string): string {
    let current: unknown = obj
    for (const part of path.split('.')) {
        if (current === null || typeof current !== 'object') return path
        current = (current as Record<string, unknown>)[part]
    }
    return typeof current === 'string' ? current : path
}

export function isLocale(value: unknown): value is Locale {
    return value === "en" || value === "zh";
}

export function detectLocaleFromAcceptLanguage(headerValue?: string | null): Locale {
    const normalized = (headerValue || "").toLowerCase();
    return normalized.includes("zh") ? "zh" : "en";
}
