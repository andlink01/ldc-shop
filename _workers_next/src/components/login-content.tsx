'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useI18n } from '@/lib/i18n/context'
import { LoginRequestError, loginErrorMessage, startOAuthLogin, type LoginProvider } from '@/lib/oauth-login'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Github, LogIn } from 'lucide-react'

export function LoginContent({ providers }: { providers: Record<LoginProvider, boolean> }) {
    const searchParams = useSearchParams(), { t } = useI18n()
    const [busy, setBusy] = useState<LoginProvider | null>(null), lock = useRef(false)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        const restore = (event: PageTransitionEvent) => {
            if (event.persisted) { lock.current = false; setBusy(null); setError(null) }
        }
        window.addEventListener('pageshow', restore)
        return () => window.removeEventListener('pageshow', restore)
    }, [])
    const message = error || (!busy ? loginErrorMessage(searchParams.get('error')) : null)
    const login = async (provider: LoginProvider) => {
        if (lock.current) return
        lock.current = true; setBusy(provider); setError(null)
        try {
            const url = await startOAuthLogin(provider, searchParams.get('callbackUrl') || '/', window.location.origin)
            window.location.assign(url)
        } catch (error) {
            setError(error instanceof LoginRequestError ? error.code : 'login.requestFailed')
            lock.current = false; setBusy(null)
        }
    }
    return <main className="container py-16 max-w-md">
        <Card className="tech-card overflow-hidden">
            <CardHeader><CardTitle className="text-2xl">{t('common.login')}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
                {message && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{t(message)}</p>}
                {providers.github && <Button size="lg" variant="outline" className="w-full" disabled={Boolean(busy)} onClick={() => void login('github')}>
                    <Github className="mr-2 h-4 w-4" />{t(busy === 'github' ? 'login.connecting' : 'login.github')}
                </Button>}
                {providers.linuxdo && <Button size="lg" className="w-full bg-foreground text-background hover:bg-foreground/90" disabled={Boolean(busy)} onClick={() => void login('linuxdo')}>
                    <LogIn className="mr-2 h-4 w-4" />{t(busy === 'linuxdo' ? 'login.connecting' : 'login.linuxdo')}
                </Button>}
                {!providers.github && !providers.linuxdo && <p role="alert" className="text-sm text-muted-foreground">{t('login.notConfigured')}</p>}
            </CardContent>
        </Card>
    </main>
}
