import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Planwerk",
    identifier: "dev.planwerk.desktop",
    version: "0.1.0",
    description: "The management surface for agentic software development",
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/main.ts" },
    copy: {
      payload: "backend",
      "generated/tray.png": "tray.png",
    },
    mac: {
      defaultRenderer: "native",
      bundleCEF: false,
      bundleWGPU: false,
      icons: "generated/Planwerk.iconset",
      codesign: false,
      notarize: false,
    },
  },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
