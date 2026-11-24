import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  // Cache Components are unreliable on Workers (dummy cache + setTimeout warnings)
  cacheComponents: false,
  // Product images are admin-supplied URLs loaded directly by the browser.
  // With the optimizer enabled, /_next/image would let any visitor make this
  // server request arbitrary (including internal) addresses.
  images: { unoptimized: true },
  // The shop never needs to be framed, and uploads are never scripts.
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
      ],
    }]
  },
  async rewrites() {
    return [
      {
        source: '/authcallback',
        destination: '/api/auth/callback/linuxdo',
      },
      {
        source: '/favicon.ico',
        destination: '/favicon',
      },
    ]
  },
};

export default nextConfig;
