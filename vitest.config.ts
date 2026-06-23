import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig "@/*" path alias so tests can import app modules
      // (e.g. middleware.ts) the same way Next.js does.
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // Run DB-touching tests serially within a file; use a single fork so the
    // shared test database isn't hit by parallel writers.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
