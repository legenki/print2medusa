import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260731000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "printful_webhook_event" (
        "id" text not null,
        "event_id" text not null,
        "type" text not null,
        "printful_order_id" text not null,
        "printful_shipment_id" text null,
        "payload" jsonb not null default '{}'::jsonb,
        "status" text not null default 'received',
        "attempts" integer not null default 0,
        "next_retry_at" timestamptz null,
        "processed_at" timestamptz null,
        "error_message" text null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "printful_webhook_event_pkey" primary key ("id")
      );
    `)
    this.addSql(`
      create unique index if not exists "IDX_printful_webhook_event_event_id"
      on "printful_webhook_event" ("event_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_printful_webhook_event_order"
      on "printful_webhook_event" ("printful_order_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_printful_webhook_event_shipment"
      on "printful_webhook_event" ("printful_shipment_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_printful_webhook_event_retry"
      on "printful_webhook_event" ("status", "next_retry_at")
      where deleted_at is null;
    `)

    // Webhooks arrive knowing only the Printful order id, so this lookup must
    // not be a sequential scan. The sentinel written by claimOrderLink is
    // excluded: without that exclusion, two concurrent claims would collide
    // here instead of on medusa_order_id, breaking insert-first protection.
    this.addSql(`
      create unique index if not exists "IDX_printful_order_link_printful"
      on "printful_order_link" ("printful_order_id")
      where deleted_at is null and "printful_order_id" <> 'pending';
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_printful_order_link_printful";`)
    this.addSql(`drop table if exists "printful_webhook_event" cascade;`)
  }
}
