import { fileURLToPath } from "node:url";
export default {
  esbuild: { jsx: "automatic" },
  resolve: { alias: {
    "@": fileURLToPath(new URL("./", import.meta.url)),
    "@ai-company-os/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
  } },
  test: { environment: "node", include: ["lib/**/*.test.{ts,tsx}", "i18n/**/*.test.{ts,tsx}"] },
};
