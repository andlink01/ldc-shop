import { NextResponse } from "next/server";
import { getSetting } from "@/lib/db/queries";
import { buildDefaultLogoSvg } from "@/lib/default-logo";
import { resolveEffectiveShopLogo } from "@/lib/shop-logo";
import {
  decodeSafeImageDataUrl,
  isSafeSvgContent,
  normalizeImageMimeType,
  safeInternalPath,
  safeOutboundHttpUrl,
} from "@/lib/safe-url";

const MAX_FAVICON_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 2;

let cached: {
  url: string;
  body: ArrayBuffer | string;
  contentType: string;
  expiresAt: number;
} | null = null;

function withCacheHeaders(body: ArrayBuffer | string, contentType: string) {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
    "X-Content-Type-Options": "nosniff",
  };
  if (contentType === "image/svg+xml") {
    headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }
  return new NextResponse(body, {
    status: 200,
    headers,
  });
}

function renderGeneratedLogo(seed: string, cacheKey: string) {
  const now = Date.now();
  if (cached && cached.url === cacheKey && cached.expiresAt > now) {
    return withCacheHeaders(cached.body, cached.contentType);
  }

  const body = buildDefaultLogoSvg(seed);
  cached = {
    url: cacheKey,
    body,
    contentType: "image/svg+xml",
    expiresAt: now + 6 * 60 * 60 * 1000,
  };
  return withCacheHeaders(body, "image/svg+xml");
}

async function readResponseWithLimit(res: Response, maxBytes: number): Promise<ArrayBuffer> {
  const contentLengthHeader = res.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error("favicon_too_large");
    }
  }

  if (!res.body) {
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error("favicon_too_large");
    return buffer;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("favicon_too_large");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

async function fetchSafeFavicon(initialUrl: string, requestOrigin: string, allowSameOrigin: boolean) {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(currentUrl, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || hop === MAX_REDIRECTS) {
        throw new Error("favicon_redirect_blocked");
      }
      const nextUrl = new URL(location, currentUrl);
      const isSameOriginInternal =
        allowSameOrigin &&
        nextUrl.origin === requestOrigin &&
        nextUrl.pathname !== "/favicon" &&
        nextUrl.pathname !== "/favicon.ico";
      if (!isSameOriginInternal && !safeOutboundHttpUrl(nextUrl.toString())) {
        throw new Error("favicon_redirect_unsafe");
      }
      currentUrl = nextUrl.toString();
      continue;
    }

    if (!res.ok) throw new Error("fetch_failed");

    const mime = normalizeImageMimeType(res.headers.get("content-type"));
    if (!mime) throw new Error("favicon_invalid_type");

    const buffer = await readResponseWithLimit(res, MAX_FAVICON_BYTES);
    if (mime === "image/svg+xml") {
      const svgText = new TextDecoder().decode(buffer);
      if (!isSafeSvgContent(svgText)) {
        throw new Error("favicon_unsafe_svg");
      }
    }

    return { body: buffer, contentType: mime };
  }

  throw new Error("fetch_failed");
}

export async function GET(request: Request) {
  let target = "";
  let logoUpdatedAt: string | null = null;
  let shopName = "";
  let instanceId = "";
  try {
    const [logo, logoSource, updatedAt, name, registryInstanceId] = await Promise.all([
      getSetting("shop_logo"),
      getSetting("shop_logo_source"),
      getSetting("shop_logo_updated_at"),
      getSetting("shop_name"),
      getSetting("registry_instance_id"),
    ]);
    target = resolveEffectiveShopLogo(logo, logoSource).effectiveLogo;
    logoUpdatedAt = updatedAt;
    shopName = (name || "").trim();
    instanceId = (registryInstanceId || "").trim();
  } catch {
    // best effort
  }

  const requestUrl = new URL(request.url);
  const requestHost = requestUrl.host;
  const generatedSeed = [instanceId, shopName, requestHost].filter(Boolean).join("|") || "ldc-shop";
  const generatedKey = `generated:${generatedSeed}`;

  if (!target) {
    return renderGeneratedLogo(generatedSeed, generatedKey);
  }

  if (target.toLowerCase().startsWith("data:")) {
    const cacheKey = logoUpdatedAt ? `${target}#${logoUpdatedAt}` : target;
    const now = Date.now();
    if (cached && cached.url === cacheKey && cached.expiresAt > now) {
      return withCacheHeaders(cached.body, cached.contentType);
    }

    const decoded = decodeSafeImageDataUrl(target);
    if (!decoded) {
      return renderGeneratedLogo(generatedSeed, generatedKey);
    }

    cached = {
      url: cacheKey,
      body: decoded.body,
      contentType: decoded.contentType,
      expiresAt: now + 6 * 60 * 60 * 1000,
    };
    return withCacheHeaders(decoded.body, decoded.contentType);
  }

  const internalPath = safeInternalPath(target);
  const isInternal = Boolean(internalPath && internalPath !== "/favicon" && internalPath !== "/favicon.ico");
  const safeRemote = isInternal ? null : safeOutboundHttpUrl(target);
  if (!isInternal && !safeRemote) {
    return renderGeneratedLogo(generatedSeed, generatedKey);
  }

  const baseUrl = isInternal
    ? new URL(internalPath!, requestUrl.origin).toString()
    : safeRemote!;
  const url = (() => {
    if (!logoUpdatedAt) return baseUrl;
    try {
      const u = new URL(baseUrl);
      u.searchParams.set("v", logoUpdatedAt);
      return u.toString();
    } catch {
      return baseUrl;
    }
  })();

  try {
    const now = Date.now();
    if (cached && cached.url === url && cached.expiresAt > now) {
      return withCacheHeaders(cached.body, cached.contentType);
    }

    const { body, contentType } = await fetchSafeFavicon(url, requestUrl.origin, isInternal);
    cached = {
      url,
      body,
      contentType,
      expiresAt: now + 6 * 60 * 60 * 1000,
    };
    return withCacheHeaders(body, contentType);
  } catch {
    return renderGeneratedLogo(generatedSeed, generatedKey);
  }
}
