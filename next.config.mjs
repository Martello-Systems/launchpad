/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Note: the Content-Security-Policy (frame-ancestors) for the embeddable
  // /embed and /embed.js routes is set at request time in middleware.ts so it
  // can be configured via EMBED_ALLOWED_ORIGINS without a rebuild. See README
  // "Embed on any site".
};

export default nextConfig;
