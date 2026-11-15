import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20261115000100 extends Migration {
  override async up(): Promise<void> {
    // Failed create attempts in a row for an order with no Printful order
    // yet. The order sweep backs off on it, so an order that keeps failing
    // (a bad address, a variant Printful no longer has) is retried a few
    // times a day rather than on every sweep. Existing rows start at 0, which
    // is the shortest wait — the cadence they had before.
    this.addSql(`
      alter table "printful_order_link"
        add column if not exists "attempts" integer not null default 0;
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "printful_order_link"
        drop column if exists "attempts";
    `)
  }
}
