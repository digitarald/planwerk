import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["better-sqlite3", "@microsoft/agent-host-protocol", "@github/copilot-sdk", "@github/copilot"],
};

export default nextConfig;
