import type { NextConfig } from "next";

const config: NextConfig = {
  // Native / Node-only packages must not be bundled.
  serverExternalPackages: [
    "@duckdb/node-api",
    "@duckdb/node-bindings",
    "@duckdb/node-bindings-win32-x64",
    "pg",
    "mysql2",
    "xlsx",
    "kafkajs",
  ],
  experimental: {
    // Uploads pass through src/proxy.ts, which would otherwise cap bodies at 10 MB.
    proxyClientMaxBodySize: "250mb",
  },
};

export default config;
