import { defineConfig } from "eslint/config"
import medusa from "@medusajs/eslint-plugin"

export default defineConfig([
  // Agent worktrees hold full copies of the source, so linting them reports
  // every finding several times over.
  { ignores: [".claude/**", ".medusa/**"] },
  ...medusa.configs.recommended,
])
