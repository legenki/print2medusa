import { defineConfig } from "eslint/config"
import medusa from "@medusajs/eslint-plugin"

/**
 * The suite runs at **0 errors and 11 warnings**, and those warnings are
 * deliberate. Recorded here so each review does not re-litigate them:
 *
 * - `use-medusa-error-not-generic-error` (4). The rule exists so an error maps
 *   to the right HTTP status. All four throws are off the request path — a
 *   missing `apiToken` at client construction, a payload-depth guard, and two
 *   inside a background order workflow. No API route throws a generic `Error`;
 *   routes set their status explicitly.
 *
 * - `workflow-id-matches-export-or-filename` / `step-id-kebab-case` (6).
 *   Medusa persists `workflow_id` in its workflow-execution table, so renaming
 *   an id strands executions already running under the old one — a real cost
 *   for a cosmetic gain. The ids are also namespaced (`printful-…`), which is
 *   what stops them colliding with a host app's own workflows.
 *
 * - `prefer-container-registration-keys` (1) in `subscribers/order-placed.ts`.
 *   Worth fixing whenever that file is next touched for another reason.
 */
export default defineConfig([
  // Agent worktrees hold full copies of the source, so linting them reports
  // every finding several times over.
  { ignores: [".claude/**", ".medusa/**"] },
  ...medusa.configs.recommended,
])
