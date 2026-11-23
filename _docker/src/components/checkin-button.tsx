'use client'

import { useState, useEffect, useEffectEvent } from 'react';
import { Button } from "@/components/ui/button";
import { checkIn, getUserPoints, getCheckinStatus } from "@/actions/points";
import { toast } from "sonner";
import { Gift, Coins } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/context";

export function CheckInButton({
    enabled = true,
    showPoints = true,
    showCheckedInLabel = false,
    className,
    onPointsChange,
    onCheckedInChange,
}: {
    enabled?: boolean
    showPoints?: boolean
    showCheckedInLabel?: boolean
    className?: string
    onPointsChange?: (points: number) => void
    onCheckedInChange?: (checkedIn: boolean) => void
}) {
    const { t } = useI18n()
    const [points, setPoints] = useState(0)
    const [checkedIn, setCheckedIn] = useState(false)
    const [loading, setLoading] = useState(true)
    const [checkingIn, setCheckingIn] = useState(false)
    const notifyInitialStatus = useEffectEvent((points: number, checkedIn: boolean) => {
        onPointsChange?.(points)
        onCheckedInChange?.(checkedIn)
    })

    useEffect(() => {
        let cancelled = false
        const init = async () => {
            try {
                const [p, s] = await Promise.all([getUserPoints(), getCheckinStatus()])
                if (cancelled) return
                setPoints(p)
                setCheckedIn(s.checkedIn)
                notifyInitialStatus(p, s.checkedIn)
            } catch (e) {
                console.error(e)
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        init()
        return () => { cancelled = true }
    }, [])

    const handleCheckIn = async () => {
        setCheckingIn(true)
        try {
            const res = await checkIn()
            if (res.success) {
                toast.success(t('checkin.success', { points: res.points || 0 }))
                const nextPoints = points + (res.points || 0)
                setPoints(nextPoints)
                onPointsChange?.(nextPoints)
                setCheckedIn(true)
                onCheckedInChange?.(true)
            } else {
                if (res.error === "Already checked in today") {
                    setCheckedIn(true)
                    onCheckedInChange?.(true)
                    toast.info(t('checkin.alreadyCheckedIn'))
                } else {
                    toast.error(res.error ? t(`checkin.${res.error}`) : t('checkin.failed'))
                }
            }
        } catch {
            toast.error(t('checkin.networkError'))
        } finally {
            setCheckingIn(false)
        }
    }

    if (loading) return null

    return (
        <div className={cn("flex items-center gap-2", className)}>
            {showPoints && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/50 rounded-full text-sm font-medium">
                    <Coins className="w-4 h-4 text-yellow-500" />
                    <span>{points}</span>
                </div>
            )}

            {enabled && !checkedIn && (
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2 bg-gradient-to-r from-amber-500/10 to-orange-500/10 hover:from-amber-500/20 hover:to-orange-500/20 border-amber-500/20 text-amber-600 dark:text-amber-400"
                    onClick={handleCheckIn}
                    disabled={checkingIn}
                >
                    <Gift className={cn("w-4 h-4", checkingIn && "animate-pulse")} />
                    {t('checkin.button')}
                </Button>
            )}

            {enabled && checkedIn && showCheckedInLabel && (
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-muted-foreground"
                    disabled
                >
                    {t('checkin.checkedIn')}
                </Button>
            )}
        </div>
    )
}
