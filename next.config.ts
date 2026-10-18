import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.PLANWERK_DESKTOP_BUILD === "1" ? {
    output: "standalone",
    distDir: ".next-desktop",
    outputFileTracingIncludes: {
      "/*": ["./node_modules/@github/copilot-sdk-*/**/*"],
    },
  } : {}),
  devIndicators: false,
  reactProductionProfiling: process.env.PLANWERK_PROFILE === "1",
  serverExternalPackages: ["better-sqlite3", "@microsoft/agent-host-protocol", "@github/copilot-sdk", "@github/copilot"],
};

export default nextConfig;
