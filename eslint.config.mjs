import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ESLint is intentionally held at v9. ESLint 10 is blocked by the plugin stack
// that eslint-config-next pulls in transitively — eslint-plugin-import,
// eslint-plugin-react, and eslint-plugin-jsx-a11y cap their peer range at ESLint 9.
// Revisit the ESLint 10 bump on a future eslint-config-next release that ships
// v10-compatible plugin versions. Do not force-install past the peer conflict.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["desktop/watch-server.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-desktop/**",
    "desktop/.hutch/**",
    "desktop/node_modules/**",
    "desktop/build/**",
    "desktop/artifacts/**",
    "desktop/payload/**",
    "desktop/generated/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
