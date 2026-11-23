'use client'

import { createContext, useContext, useState, useEffect, useSyncExternalStore, ReactNode } from 'react'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import { getNestedTranslation, isLocale, type Locale } from './shared'
import { resolveCurrencyUnit } from '@/lib/currency-unit'

type Translations = typeof en

const translations: Record<Locale, Translations> = { en, zh }

interface I18nContextType {
    locale: Locale
    setLocale: (locale: Locale) => void
    t: (key: string, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextType | null>(null)

function readStoredLocale(): Locale | null {
    try { const saved = localStorage.getItem('ldc-locale'); return isLocale(saved) ? saved : null } catch { return null }
}
function subscribeLocale(listener: () => void) {
    window.addEventListener('storage', listener)
    window.addEventListener('ldc:locale-changed', listener)
    return () => { window.removeEventListener('storage', listener); window.removeEventListener('ldc:locale-changed', listener) }
}

function interpolate(text: string, params?: Record<string, string | number>): string {
    if (!params) return text
    return Object.entries(params).reduce((acc, [key, value]) => {
        return acc.replace(new RegExp(`{{${key}}}`, 'g'), String(value))
    }, text)
}

export function I18nProvider({
    children,
    initialLocale = 'en',
    currencyUnit = null,
}: {
    children: ReactNode
    initialLocale?: Locale
    currencyUnit?: string | null
}) {
    const [selection, setLocaleState] = useState<{ source: Locale | null; value: Locale }>({ source: null, value: initialLocale })

    const storedLocale = useSyncExternalStore(subscribeLocale, readStoredLocale, () => null)
    if (selection.source !== storedLocale) {
        setLocaleState({ source: storedLocale, value: storedLocale || initialLocale })
    }
    const locale = selection.source === storedLocale ? selection.value : storedLocale || initialLocale
    useEffect(() => { document.cookie = `ldc-locale=${locale}; path=/; max-age=31536000` }, [locale])
    const setLocale = (newLocale: Locale) => {
        try { localStorage.setItem('ldc-locale', newLocale) } catch { /* Memory state remains usable without storage. */ }
        setLocaleState({ source: readStoredLocale(), value: newLocale })
        window.dispatchEvent(new Event('ldc:locale-changed'))
        document.cookie = `ldc-locale=${newLocale}; path=/; max-age=31536000`
    }

    const t = (key: string, params?: Record<string, string | number>): string => {
        const text = getNestedTranslation(translations[locale], key)
        return interpolate(text, { currencyUnit: resolveCurrencyUnit(locale, currencyUnit), ...params })
    }

    return (
        <I18nContext.Provider value={{ locale, setLocale, t }}>
            {children}
        </I18nContext.Provider>
    )
}

export function useI18n() {
    const context = useContext(I18nContext)
    if (!context) {
        // Return default values for server-side rendering
        return {
            locale: 'en' as Locale,
            setLocale: () => { },
            t: (key: string, params?: Record<string, string | number>) => {
                const text = getNestedTranslation(en, key)
                return interpolate(text, { currencyUnit: resolveCurrencyUnit('en', null), ...params })
            }
        }
    }
    return context
}
