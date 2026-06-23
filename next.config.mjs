/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The embed route is framed by third-party sites; allow it explicitly.
  async headers() {
    return [
      {
        source: "/embed",
        headers: [
          // Allow embedding the widget anywhere. Tighten to your own domains in production.
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
        ],
      },
    ];
  },
};

export default nextConfig;
