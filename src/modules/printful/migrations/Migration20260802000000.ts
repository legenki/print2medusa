import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260802000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "printful_sync_log"
        add column if not exists "heartbeat_at" timestamptz null,
        add column if not exists "products_processed" integer not null default 0,
        add column if not exists "products_total" integer not null default 0;
    `)

    // At most one running sync, whatever the state of finished ones. Indexing
    // the constant `true` under a status predicate is what makes the claim
    // atomic: a second concurrent claim collides here rather than racing
    // between a read and a write.
    this.addSql(`
      create unique index if not exists "IDX_printful_sync_log_one_running"
      on "printful_sync_log" ((true))
      where status = 'running' and deleted_at is null;
    `)

    this.addSql(`
      create index if not exists "IDX_printful_sync_log_heartbeat"
      on "printful_sync_log" ("heartbeat_at")
      where status = 'running' and deleted_at is null;
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_printful_sync_log_heartbeat";`)
    this.addSql(`drop index if exists "IDX_printful_sync_log_one_running";`)
    this.addSql(`
      alter table "printful_sync_log"
        drop column if exists "products_total",
        drop column if exists "products_processed",
        drop column if exists "heartbeat_at";
    `)
  }
}
