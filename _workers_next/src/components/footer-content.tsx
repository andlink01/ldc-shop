'use client'

import { useI18n } from "@/lib/i18n/context";
import { SHOP_REPOSITORY_URL } from '@/lib/update-check';

interface FooterContentProps {
    customFooter: string | null
    version: string
}

export function FooterContent({ customFooter, version }: FooterContentProps) {
    const { t } = useI18n()
    const footerText = customFooter?.trim() || t('footer.disclaimer')

    return (
        <footer className="border-t border-border/50 py-6 pb-20 md:py-0 md:pb-0 bg-gradient-to-t from-muted/30 to-transparent">
            <div className="container flex flex-col items-center justify-between gap-4 md:h-20 md:flex-row">
                <div className="flex flex-col items-center gap-4 px-8 md:flex-row md:gap-2 md:px-0">
                    <p
                        className="text-center text-xs leading-loose text-muted-foreground/80 md:text-left footer-html"
                        dangerouslySetInnerHTML={{ __html: footerText }}
                    />
                </div>
                <a href={SHOP_REPOSITORY_URL} target="_blank" rel="noreferrer" className="text-center text-xs text-muted-foreground/40 hover:text-primary transition-colors duration-300">
                    v{version}
                </a>
            </div>
        </footer>
    )
}
