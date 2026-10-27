import { ok } from "node:assert/strict"
import { readdirSync } from "node:fs"
import { join } from "node:path"

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "src",
  "modules",
  "printful",
  "migrations"
)

type MigrationInstance = {
  addSql: (sql: string) => void
  up: () => Promise<void>
}

/**
 * Apply every migration the module ships, oldest first — the order
 * `medusa db:migrate` applies them — straight to Postgres.
 *
 * Read from the directory, never listed by hand. Hand-kept lists went stale:
 * Migration20261023000000 added `warning_message`, the tests still passed
 * against a long-lived local database that already had the column, and only
 * CI's fresh one failed — with "column does not exist" in an unrelated
 * assertion. Reading the directory makes the schema under test the schema
 * that ships.
 *
 * Each migration's SQL is collected without a MikroORM driver, then run.
 */
export async function runAllMigrations(pg: {
  raw: (sql: string) => PromiseLike<unknown>
}): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^Migration\d+\.ts$/.test(file))
    .sort()

  ok(files.length > 0, `No migrations found in ${MIGRATIONS_DIR}`)

  for (const file of files) {
    const name = file.replace(/\.ts$/, "")
    const mod = (await import(join(MIGRATIONS_DIR, file))) as Record<
      string,
      { prototype: MigrationInstance }
    >
    const MigrationClass = mod[name]
    ok(MigrationClass, `${file} does not export a class named ${name}`)

    const statements: string[] = []
    const migration = Object.create(
      MigrationClass.prototype
    ) as MigrationInstance
    migration.addSql = (sql: string) => {
      statements.push(sql)
    }
    await migration.up()
    for (const sql of statements) {
      await pg.raw(sql)
    }
  }
}
