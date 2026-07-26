import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260726000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "printful_product_link" (
        "id" text not null,
        "printful_store_id" text not null,
        "printful_sync_product_id" text not null,
        "medusa_product_id" text not null,
        "last_synced_at" timestamptz null,
        "sync_hash" text null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "printful_product_link_pkey" primary key ("id")
      );
    `)
    this.addSql(`
      create unique index if not exists "IDX_printful_product_link_store_sync"
      on "printful_product_link" ("printful_store_id", "printful_sync_product_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_printful_product_link_medusa"
      on "printful_product_link" ("medusa_product_id")
      where deleted_at is null;
    `)

    this.addSql(`
      create table if not exists "printful_variant_link" (
        "id" text not null,
        "printful_store_id" text not null,
        "printful_sync_product_id" text not null,
        "printful_sync_variant_id" text not null,
        "medusa_variant_id" text not null,
        "last_synced_at" timestamptz null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "printful_variant_link_pkey" primary key ("id")
      );
    `)
    this.addSql(`
      create unique index if not exists "IDX_printful_variant_link_store_sync"
      on "printful_variant_link" ("printful_store_id", "printful_sync_variant_id")
      where deleted_at is null;
    `)
    this.addSql(`
      create index if not exists "IDX_printful_variant_link_medusa"
      on "printful_variant_link" ("medusa_variant_id")
      where deleted_at is null;
    `)

    this.addSql(`
      create table if not exists "printful_sync_log" (
        "id" text not null,
        "status" text not null default 'running',
        "started_at" timestamptz not null,
        "finished_at" timestamptz null,
        "products_created" integer not null default 0,
        "products_updated" integer not null default 0,
        "products_failed" integer not null default 0,
        "error_message" text null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "printful_sync_log_pkey" primary key ("id")
      );
    `)
    this.addSql(`
      create index if not exists "IDX_printful_sync_log_started"
      on "printful_sync_log" ("started_at")
      where deleted_at is null;
    `)

    this.addSql(`
      create table if not exists "printful_order_link" (
        "id" text not null,
        "medusa_order_id" text not null,
        "printful_order_id" text not null,
        "external_id" text not null,
        "status" text not null default 'created',
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "printful_order_link_pkey" primary key ("id")
      );
    `)
    this.addSql(`
      create unique index if not exists "IDX_printful_order_link_medusa"
      on "printful_order_link" ("medusa_order_id")
      where deleted_at is null;
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "printful_order_link" cascade;`)
    this.addSql(`drop table if exists "printful_sync_log" cascade;`)
    this.addSql(`drop table if exists "printful_variant_link" cascade;`)
    this.addSql(`drop table if exists "printful_product_link" cascade;`)
  }
}
