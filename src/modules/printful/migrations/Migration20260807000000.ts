import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260807000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "printful_order_link"
        add column if not exists "error_message" text null,
        add column if not exists "last_attempt_at" timestamptz null;
    `)

    // Rows still holding a claim without a real Printful order id — a create
    // whose outcome could not be determined. They need an operator, so make
    // them cheap to list rather than a scan of every link ever created.
    this.addSql(`
      create index if not exists "IDX_printful_order_link_unresolved"
      on "printful_order_link" ("last_attempt_at")
      where printful_order_id = 'pending' and deleted_at is null;
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_printful_order_link_unresolved";`)
    this.addSql(`
      alter table "printful_order_link"
        drop column if exists "last_attempt_at",
        drop column if exists "error_message";
    `)
  }
}
