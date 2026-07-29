import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    return [
      {
        source: "/api/redact",
        destination: "http://127.0.0.1:5328/api/redact",
      },
    ];
  },
};

export default nextConfig;
