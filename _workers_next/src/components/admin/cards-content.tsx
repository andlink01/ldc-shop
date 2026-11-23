'use client'

import { getErrorMessage } from '@/lib/errors'

import { useI18n } from "@/lib/i18n/context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { addCards, deleteCard, deleteCards, pullCardFromApi, saveCardsApiConfig, setCardsApiEnabled } from "@/actions/admin"
import { updateCardsExpiry } from '@/actions/inventory'
import { Checkbox } from "@/components/ui/checkbox"
import { useRef, useState, useEffect } from "react"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { CopyButton } from "@/components/copy-button"
import { ClientDate } from '@/components/client-date'
import { Trash2 } from "lucide-react"
import { useRouter } from "next/navigation"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

interface CardData {
    id: number
    cardKey: string
    expiresAt: number | null
    createdAt: number | null
    locked: boolean
}

interface CardsContentProps {
    productId: string
    productName: string
    snapshotAt: number
    unusedCards: CardData[]
    apiConfig: {
        enabled: boolean
        url: string
        token: string
        mode: 'stock' | 'on_demand'
    }
}

export function CardsContent({ productId, productName, unusedCards, apiConfig, snapshotAt }: CardsContentProps) {
    const { t } = useI18n()
    const router = useRouter()
    const [selectedIds, setSelectedIds] = useState<number[]>([])
    const [submitting, setSubmitting] = useState(false)
    const [batchDeleting, setBatchDeleting] = useState(false)
    const [deletingId, setDeletingId] = useState<number | null>(null)
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [pendingCount, setPendingCount] = useState(0)
    const [pendingHasExpiry, setPendingHasExpiry] = useState(false)
    const [apiMode, setApiMode] = useState(apiConfig.mode)
    const [apiEnabled, setApiEnabled] = useState(apiConfig.enabled)
    const [apiUrl, setApiUrl] = useState(apiConfig.url)
    const [apiToken, setApiToken] = useState(apiConfig.token)
    const [savingApi, setSavingApi] = useState(false)
    const [togglingApiEnabled, setTogglingApiEnabled] = useState(false)
    const [pullingApi, setPullingApi] = useState(false)
    const submitLock = useRef(false)
    const batchDeleteLock = useRef(false)
    const deleteLock = useRef<number | null>(null)
    const formRef = useRef<HTMLFormElement | null>(null)
    const pendingFormRef = useRef<FormData | null>(null)

    const [now, setNow] = useState(snapshotAt)
    const [expiryValue, setExpiryValue] = useState(''), [expiryBusy, setExpiryBusy] = useState(false)
    const expiryLock = useRef(false)
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])
    const selectable = unusedCards.filter(c => !c.locked).slice(0, 500)
    const availableCount = unusedCards.filter(c => !c.locked && (!c.expiresAt || c.expiresAt > now)).length
    const changeExpiry = async (permanent: boolean) => {
        if (expiryLock.current || !selectedIds.length || (!permanent && !expiryValue)) return
        expiryLock.current = true; setExpiryBusy(true)
        try {
            await updateCardsExpiry(productId, selectedIds, permanent ? null : new Date(expiryValue).toISOString())
            toast.success(t('common.success')); setSelectedIds([]); router.refresh()
        } catch (e) { toast.error(e instanceof Error ? getErrorMessage(e) : t('common.error')) }
        finally { expiryLock.current = false; setExpiryBusy(false) }
    }
    const toggleSelectAll = () => {
        if (selectedIds.length === selectable.length) {
            setSelectedIds([])
        } else {
            setSelectedIds(selectable.slice(0, 500).map(c => c.id))
        }
    }

    const toggleSelect = (id: number) => {
        setSelectedIds(prev =>
            prev.includes(id)
                ? prev.filter(pid => pid !== id)
                : [...prev, id].slice(0, 500)
        )
    }

    const handleBatchDelete = async () => {
        if (!selectedIds.length || batchDeleteLock.current) return

        if (confirm(t('admin.cards.confirmBatchDelete', { count: selectedIds.length }))) {
            batchDeleteLock.current = true
            setBatchDeleting(true)
            try {
                await deleteCards(selectedIds)
                toast.success(t('common.success'))
                setSelectedIds([])
                router.refresh()
            } catch (e) {
                toast.error(e instanceof Error ? getErrorMessage(e) : t('common.error'))
            } finally {
                setBatchDeleting(false)
                batchDeleteLock.current = false
            }
        }
    }

    const handleSubmit = async (formData: FormData) => {
        if (submitLock.current) return
        submitLock.current = true
        setSubmitting(true)
        try {
            const result = await addCards(formData)
            if (result && result.success === false) {
                toast.error(t(result.error || 'common.error'))
                return
            }
            toast.success(t('common.success'))
            router.refresh()
            formRef.current?.reset()
            setPendingCount(0)
        } catch (e) {
            toast.error(e instanceof Error ? getErrorMessage(e) : t('common.error'))
        } finally {
            setSubmitting(false)
            submitLock.current = false
        }
    }

    const handleConfirmSubmit = async () => {
        const formData = pendingFormRef.current
        if (!formData) {
            setConfirmOpen(false)
            setPendingHasExpiry(false)
            return
        }
        setConfirmOpen(false)
        pendingFormRef.current = null
        await handleSubmit(formData)
    }

    const handleOpenConfirm = (formData: FormData) => {
        const raw = String(formData.get('cards') || '')
        const hoursRaw = String(formData.get('expires_hours') || '').trim()
        const minutesRaw = String(formData.get('expires_minutes') || '').trim()
        const count = raw
            .split(/\r?\n|,/)
            .map((item) => item.trim())
            .filter(Boolean).length
        const hours = hoursRaw === '' ? 0 : Number(hoursRaw)
        const minutes = minutesRaw === '' ? 0 : Number(minutesRaw)
        const hasExpiry =
            Number.isInteger(hours) &&
            Number.isInteger(minutes) &&
            hours >= 0 &&
            minutes >= 0 &&
            minutes <= 59 &&
            hours * 60 + minutes > 0
        setPendingCount(count)
        setPendingHasExpiry(hasExpiry)
        pendingFormRef.current = formData
        setConfirmOpen(true)
    }

    const handleSaveApiConfig = async () => {
        if (savingApi) return
        setSavingApi(true)
        try {
            const result = await saveCardsApiConfig(productId, apiUrl, apiToken, apiEnabled, apiMode)
            toast.success(t('common.success'))
            if (result.autoPulled) {
                toast.success(t('admin.cards.apiAutoPulled'))
            } else if (result.autoPullError) {
                toast.error(`${t('admin.cards.apiAutoPullFailed')}: ${result.autoPullError}`)
            }
            router.refresh()
        } catch (e) {
            toast.error(e instanceof Error ? getErrorMessage(e) : t('common.error'))
        } finally {
            setSavingApi(false)
        }
    }

    const handleToggleApiEnabled = async () => {
        if (togglingApiEnabled || savingApi || pullingApi) return
        const nextEnabled = !apiEnabled
        setTogglingApiEnabled(true)
        try {
            const result = await setCardsApiEnabled(productId, nextEnabled, apiUrl, apiToken, apiMode)
            setApiEnabled(nextEnabled)
            toast.success(t('common.success'))
            if (result.autoPulled) {
                toast.success(t('admin.cards.apiAutoPulled'))
            } else if (result.autoPullError) {
                toast.error(`${t('admin.cards.apiAutoPullFailed')}: ${result.autoPullError}`)
            }
            router.refresh()
        } catch (e) {
            toast.error(e instanceof Error ? getErrorMessage(e) : t('common.error'))
        } finally {
            setTogglingApiEnabled(false)
        }
    }

    const handlePullOneCard = async () => {
        if (pullingApi) return
        setPullingApi(true)
        try {
            await pullCardFromApi(productId)
            toast.success(t('admin.cards.apiPullSuccess'))
            router.refresh()
        } catch (e) {
            toast.error(`${t('admin.cards.apiPullFailed')}: ${e instanceof Error ? getErrorMessage(e) : ''}`)
        } finally {
            setPullingApi(false)
        }
    }

    return (
        <div className="space-y-8 max-w-4xl mx-auto">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">{t('admin.cards.title')}: {productName}</h1>
                </div>
                <div className="text-right">
                    <div className="text-2xl font-bold">{availableCount}</div>
                    <div className="text-xs text-muted-foreground">{t('admin.cards.available')}</div>
                </div>
            </div>

            <div className="grid md:grid-cols-2 gap-8">
                <div className="space-y-8">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t('admin.cards.addCards')}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <form
                                ref={formRef}
                                onSubmit={(event) => {
                                    event.preventDefault()
                                    if (submitting) return
                                    const formData = new FormData(event.currentTarget)
                                    handleOpenConfirm(formData)
                                }}
                                className="space-y-4"
                            >
                                <input type="hidden" name="product_id" value={productId} />
                                <Textarea name="cards" placeholder={t('admin.cards.placeholder')} rows={10} className="font-mono text-sm" required disabled={submitting} />
                                <div className="space-y-2">
                                    <label className="text-sm font-medium">{t('admin.cards.expiryLabel')}</label>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <label className="text-xs text-muted-foreground">{t('admin.cards.expiryHours')}</label>
                                            <Input
                                                name="expires_hours"
                                                type="number"
                                                min="0"
                                                step="1"
                                                onWheel={(event) => event.currentTarget.blur()}
                                                disabled={submitting}
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-xs text-muted-foreground">{t('admin.cards.expiryMinutes')}</label>
                                            <Input
                                                name="expires_minutes"
                                                type="number"
                                                min="0"
                                                max="59"
                                                step="1"
                                                onWheel={(event) => event.currentTarget.blur()}
                                                disabled={submitting}
                                            />
                                        </div>
                                    </div>
                                    <p className="text-xs text-muted-foreground">{t('admin.cards.expiryHint')}</p>
                                </div>
                                <Button type="submit" className="w-full" disabled={submitting}>
                                    {submitting ? t('common.processing') : t('common.add')}
                                </Button>
                            </form>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>{t('admin.cards.apiTitle')}</CardTitle>
                            <CardDescription>{t(apiMode === 'on_demand' ? 'inventory.onDemandHint' : 'admin.cards.apiHint')}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <label className="block text-sm">{t('inventory.deliveryMode')}
                                <select value={apiMode} onChange={e => setApiMode(e.target.value as 'stock' | 'on_demand')} disabled={savingApi || pullingApi || togglingApiEnabled} className="block w-full border rounded p-2 mt-1">
                                    <option value="stock">{t('inventory.stockMode')}</option><option value="on_demand">{t('inventory.onDemandMode')}</option>
                                </select>
                            </label>
                            <div className="grid gap-2">
                                <label className="text-sm font-medium">{t('admin.cards.apiUrl')}</label>
                                <Input
                                    value={apiUrl}
                                    onChange={(e) => setApiUrl(e.target.value)}
                                    placeholder="https://example.com/api/card"
                                    disabled={savingApi || pullingApi}
                                />
                            </div>
                            <div className="grid gap-2">
                                <label className="text-sm font-medium">{t('admin.cards.apiToken')}</label>
                                <Input
                                    type="password"
                                    value={apiToken}
                                    onChange={(e) => setApiToken(e.target.value)}
                                    placeholder={t('admin.cards.apiTokenPlaceholder')}
                                    disabled={savingApi || pullingApi}
                                />
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <Button
                                    variant={apiEnabled ? "default" : "outline"}
                                    size="sm"
                                    onClick={handleToggleApiEnabled}
                                    disabled={savingApi || pullingApi || togglingApiEnabled}
                                >
                                    {apiEnabled ? t('admin.cards.apiEnabled') : t('admin.cards.apiDisabled')}
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={handleSaveApiConfig}
                                    disabled={savingApi || pullingApi || togglingApiEnabled}
                                >
                                    {savingApi ? t('common.processing') : t('common.save')}
                                </Button>
                                <Button
                                    onClick={handlePullOneCard}
                                    disabled={pullingApi || savingApi || togglingApiEnabled || !apiEnabled || apiMode === 'on_demand'}
                                >
                                    {pullingApi ? t('common.processing') : t('admin.cards.apiPullOne')}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                <Card>
                    <CardHeader>
                        <CardTitle>{t('admin.cards.available')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <p className="text-xs text-muted-foreground">{t('inventory.expiryHint')}</p>
                        <label className="block text-sm">{t('inventory.batchExpiry')}<Input type="datetime-local" value={expiryValue} onChange={e => setExpiryValue(e.target.value)} disabled={expiryBusy} /></label>
                        <div className="flex flex-wrap gap-2">
                            <Button size="sm" disabled={expiryBusy || !selectedIds.length || !expiryValue} onClick={() => void changeExpiry(false)}>{t('inventory.batchExpiry')}</Button>
                            <Button size="sm" variant="outline" disabled={expiryBusy || !selectedIds.length} onClick={() => void changeExpiry(true)}>{t('inventory.setPermanent')}</Button>
                        </div>
                        <div className="max-h-[500px] overflow-y-auto space-y-2">
                        {unusedCards.length > 0 && (
                            <div className="flex items-center justify-between pb-2 mb-2 border-b sticky top-0 bg-background z-10">
                                <div className="flex items-center gap-2">
                                    <Checkbox
                                        checked={selectedIds.length === selectable.length && unusedCards.length > 0}
                                        onCheckedChange={toggleSelectAll}
                                        id="select-all"
                                    />
                                    <label htmlFor="select-all" className="text-sm cursor-pointer select-none">
                                        {t('admin.cards.selectAll')}
                                        {selectedIds.length > 0 && <span className="ml-2 text-muted-foreground text-xs">({t('admin.cards.selectedCount', { count: selectedIds.length })})</span>}
                                    </label>
                                </div>
                                {selectedIds.length > 0 && (
                                    <Button
                                        variant="destructive"
                                        size="sm"
                                        className="h-7 text-xs"
                                        onClick={handleBatchDelete}
                                        disabled={batchDeleting}
                                    >
                                        {t('admin.cards.batchDelete')}
                                    </Button>
                                )}
                            </div>
                        )}
                        {unusedCards.length === 0 ? (
                            <div className="text-center py-10 text-muted-foreground text-sm">{t('admin.cards.noCards')}</div>
                        ) : (
                            unusedCards.map(c => (
                                <div key={c.id} className="flex items-center justify-between p-2 rounded bg-muted/40 text-sm font-mono gap-2 animate-in fade-in transition-colors hover:bg-muted/60">
                                    <div className="flex items-center gap-3">
                                        <Checkbox
                                            disabled={c.locked || expiryBusy}
                                            checked={selectedIds.includes(c.id)}
                                            onCheckedChange={() => toggleSelect(c.id)}
                                        />
                                        <div>
                                            <CopyButton text={c.cardKey} truncate maxLength={30} />
                                            <div className="text-xs text-muted-foreground font-sans mt-1">
                                                {c.locked && <Badge variant="outline" className="mr-1">{t('inventory.locked')}</Badge>}
                                                {!c.expiresAt ? t('inventory.permanent') : <>
                                                    <span>{t('inventory.expiresAt')}: <ClientDate value={new Date(c.expiresAt)} format="dateTime" /></span>
                                                    {now && <span className="ml-2">{c.expiresAt <= now ? t('inventory.expired') : t('inventory.remaining', { minutes: Math.ceil((c.expiresAt - now) / 60000) })}</span>}
                                                </>}
                                            </div>
                                        </div>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                                        onClick={async () => {
                                            if (deleteLock.current === c.id) return
                                            if (confirm(t('common.confirm') + '?')) {
                                                deleteLock.current = c.id
                                                setDeletingId(c.id)
                                                try {
                                                    await deleteCard(c.id)
                                                    setSelectedIds(prev => prev.filter(id => id !== c.id))
                                                    toast.success(t('common.success'))
                                                    router.refresh()
                                                } catch (e) {
                                                    toast.error(e instanceof Error ? getErrorMessage(e) : t('common.error'))
                                                } finally {
                                                    setDeletingId(null)
                                                    deleteLock.current = null
                                                }
                                            }
                                        }}
                                        disabled={deletingId === c.id || c.locked || expiryBusy}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            ))
                        )}
                        </div>
                    </CardContent>
                </Card>
            </div>

            <Dialog
                open={confirmOpen}
                onOpenChange={(open) => {
                    setConfirmOpen(open)
                    if (!open) {
                        pendingFormRef.current = null
                        setPendingHasExpiry(false)
                    }
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('admin.cards.confirmAddTitle')}</DialogTitle>
                        <DialogDescription>
                            {t('admin.cards.confirmAddDescription', { count: pendingCount })}
                        </DialogDescription>
                        {pendingHasExpiry ? (
                            <p className="text-sm text-amber-600 dark:text-amber-400">
                                {t('admin.cards.confirmAddExpiryNotice')}
                            </p>
                        ) : null}
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button onClick={handleConfirmSubmit} disabled={submitting}>
                            {t('common.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
