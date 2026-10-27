import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20261023000000 extends Migration {
  override async up(): Promise<void> {
    // Kept apart from error_message on purpose: a warning describes a sync
    // that succeeded inside a misconfigured store, and must not read as — or
    // be counted as — a failure.
    this.addSql(`
      alter table "printful_sync_log"
        add column if not exists "warning_message" text null;
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "printful_sync_log"
        drop column if exists "warning_message";
    `)
  }
}
