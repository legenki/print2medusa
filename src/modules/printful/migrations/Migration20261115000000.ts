import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20261115000000 extends Migration {
  override async up(): Promise<void> {
    // Webhook events used to be stored with the whole body, and its `data`
    // holds the Printful order — the recipient's name, address, email and
    // phone. Nothing ever read it back. Reduce every stored row to the same
    // envelope webhookEnvelope() keeps for new ones: the four top-level keys,
    // and only where they are a string or a number.
    //
    // Soft-deleted rows are included on purpose: deleted_at hides a row from
    // the service, not from the table.
    this.addSql(`
      update "printful_webhook_event"
         set "payload" = coalesce(
               (
                 select jsonb_object_agg("key", "value")
                   from jsonb_each(
                          case
                            when jsonb_typeof("payload") = 'object'
                              then "payload"
                            else '{}'::jsonb
                          end
                        )
                  where "key" in ('type', 'created', 'retries', 'store')
                    and jsonb_typeof("value") in ('string', 'number')
               ),
               '{}'::jsonb
             )
       where "payload" <> '{}'::jsonb;
    `)
  }

  override async down(): Promise<void> {
    // Nothing to undo: the removed data was never read, and cannot be
    // restored. The column is unchanged, so earlier releases still run.
  }
}
