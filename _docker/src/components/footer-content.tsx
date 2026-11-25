'use client'

import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import { SHOP_REPOSITORY_URL } from '@/lib/update-check';
import { safeExternalUrl, safeInternalPath } from '@/lib/safe-url';

interface FooterContentProps {
    customFooter: string | null
    version: string
}

function resolveSafeFooterHref(rawHref: string): { href: string; external: boolean } | null {
    const trimmed = rawHref.replace(/&amp;/gi, '&').trim();
    if (!trimmed) return null;

    const internal = safeInternalPath(trimmed);
    if (internal) {
        return { href: internal, external: false };
    }

    if (/^mailto:[^\s?&#<>'"]+@[^\s<>'"]+$/i.test(trimmed)) {
        return { href: trimmed, external: false };
    }

    const external = safeExternalUrl(trimmed);
    if (external !== '#') {
        return { href: external, external: true };
    }

    return null;
}

function extractHrefAttr(attrs: string): string | null {
    const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function renderSafeTextWithBreaks(text: string, keyPrefix: string): ReactNode[] {
    const parts = text.split(/<br\s*\/?>/i);
    const nodes: ReactNode[] = [];
    parts.forEach((part, index) => {
        if (index > 0) nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
        if (part) nodes.push(part);
    });
    return nodes;
}

function renderSafeFooterContent(input: string): ReactNode[] {
    const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    const nodes: ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let keyIndex = 0;

    while ((match = anchorRe.exec(input)) !== null) {
        if (match.index > lastIndex) {
            nodes.push(...renderSafeTextWithBreaks(input.slice(lastIndex, match.index), `t-${keyIndex++}`));
        }

        const rawHref = extractHrefAttr(match[1] || '');
        const label = (match[2] || '').replace(/<[^>]*>/g, '');
        const resolved = rawHref ? resolveSafeFooterHref(rawHref) : null;

        if (resolved && label) {
            nodes.push(
                <a
                    key={`a-${keyIndex++}`}
                    href={resolved.href}
                    target={resolved.external ? "_blank" : undefined}
                    rel={resolved.external ? "noopener noreferrer" : undefined}
                >
                    {label}
                </a>
            );
        } else {
            nodes.push(label || match[0]);
        }

        lastIndex = anchorRe.lastIndex;
    }

    if (lastIndex < input.length) {
        nodes.push(...renderSafeTextWithBreaks(input.slice(lastIndex), `t-${keyIndex++}`));
    }

    return nodes;
}

export function FooterContent({ customFooter, version }: FooterContentProps) {
    const { t } = useI18n()
    const footerText = customFooter?.trim() || t('footer.disclaimer')

    return (
        <footer className="border-t border-border/50 py-6 pb-20 md:py-0 md:pb-0 bg-gradient-to-t from-muted/30 to-transparent">
            <div className="container flex flex-col items-center justify-between gap-4 md:h-20 md:flex-row">
                <div className="flex flex-col items-center gap-4 px-8 md:flex-row md:gap-2 md:px-0">
                    <p className="text-center text-xs leading-loose text-muted-foreground/80 md:text-left footer-html">
                        {renderSafeFooterContent(footerText)}
                    </p>
                </div>
                <a href={SHOP_REPOSITORY_URL} target="_blank" rel="noreferrer" className="text-center text-xs text-muted-foreground/40 hover:text-primary transition-colors duration-300">
                    v{version}
                </a>
            </div>
        </footer>
    )
}
