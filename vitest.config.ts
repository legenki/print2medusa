import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests need a real Postgres; `npm test` must stay fast and
    // database-free. They run via `npm run test:integration`.
    exclude: ["tests/**/*.integration.test.ts", "node_modules/**"],
  },
})
