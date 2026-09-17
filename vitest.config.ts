import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests for pure logic. `server-only` (imported by lib/import/spreadsheet.ts
// to hard-fail if bundled into a client) throws outside the Next RSC bundler, so
// it's aliased to an empty stub for Node test runs. The spreadsheet parser itself
// (exceljs + Buffer) runs fine under Node. The `@/` alias mirrors tsconfig paths
// so lib modules that import via the app alias resolve the same way Next resolves
// them.
export default defineConfig({
  resolve: {
    alias: [
      // Exact-match the bare specifier (object-form keys can be missed by Vite
      // when the importer is inside the workspace root).
      {
        find: /^server-only$/,
        replacement: new URL("./test/stubs/server-only.ts", import.meta.url).pathname,
      },
      // Prefix-match the app path alias, mirroring tsconfig paths.
      { find: /^@\//, replacement: fileURLToPath(new URL(".", import.meta.url)) },
    ],
  },
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
});
