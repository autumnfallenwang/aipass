import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@aipass/shared"],
  poweredByHeader: false,
};

export default config;
