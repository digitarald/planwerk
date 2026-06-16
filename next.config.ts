import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@microsoft/agent-host-protocol"],
};

export default nextConfig;
