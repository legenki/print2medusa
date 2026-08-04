# Storefront guide: Printful availability metadata

Medusa does **not** block checkout when a single Printful size or color is out
of stock. Printful variants are synced with `manage_inventory: false` — POD has
no warehouse quantity to zero out — so the storefront must read plugin metadata
if you want sold-out variants hidden or disabled.

## What the plugin writes

| Location               | Key                            | Values                                                                                                                         |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Variant** `metadata` | `printful_availability_status` | Printful’s status string, e.g. `active`, `out_of_stock`, `temporary_out_of_stock`, `discontinued`                              |
| **Product** `metadata` | `printful_stock_status`        | `"unavailable"` only when the **plugin** unpublished the product (all variants unavailable, or removed from Printful)          |
| **Product** `metadata` | `printful_discontinued`        | `true` if any variant is discontinued (unless `onDiscontinued: "ignore"`)                                                      |
| **Product** `metadata` | `printful_removed`             | `true` if the product vanished from the Printful catalogue and was unpublished (`onRemovedFromPrintful: "unpublish"`, default) |
| **Product** `status`   | Medusa field                   | `draft` when all variants are unavailable (plugin-owned) or when removed; otherwise left alone for merchant drafts             |

Unknown or missing `availability_status` is treated as **available** so a new
Printful enum value does not hide the whole catalogue.

## Product-level vs variant-level

- **All variants unavailable** (or product removed from Printful) → product
  `status` becomes `draft` (when the plugin owns that unpublish). Store API
  product lists that only return `published` products hide it automatically.
- **Some variants unavailable** → product stays `published`. The sold-out
  variant remains orderable in Medusa cart APIs unless **you** filter on
  `printful_availability_status`.

## Recommended storefront behaviour

### 1. Filter or disable sold-out variants

When rendering a product:

```ts
const UNAVAILABLE = new Set([
  "out_of_stock",
  "temporary_out_of_stock",
  "discontinued",
])

function isVariantOrderable(variant: {
  metadata?: Record<string, unknown> | null
}): boolean {
  const status = variant.metadata?.printful_availability_status
  if (status == null || status === "") {
    return true // fail open — same rule as the plugin
  }
  return !UNAVAILABLE.has(String(status))
}

// Product detail: only offer orderable options
const options = product.variants.filter(isVariantOrderable)

// Or keep the option visible but disabled
const disabled = !isVariantOrderable(selectedVariant)
```

### 2. Optional: block add-to-cart

If your storefront can intercept add-to-cart:

```ts
if (!isVariantOrderable(variant)) {
  throw new Error("This size/color is currently unavailable")
}
```

Medusa Admin and default store APIs will **not** do this for you.

### 3. Labels for UX

| Status                   | Suggested copy            |
| ------------------------ | ------------------------- |
| `active`                 | (none)                    |
| `out_of_stock`           | “Out of stock”            |
| `temporary_out_of_stock` | “Temporarily unavailable” |
| `discontinued`           | “Discontinued”            |

### 4. Product-level draft

If `product.status === "draft"` because of Printful stock/removal, the product
normally will not appear in store listings. You do not need extra checks for
that case. Check `printful_removed` in Admin if you need to distinguish
“sold out” from “deleted in Printful”.

## Sync options that affect this

```ts
plugins: [
  {
    resolve: "@legenki/print2medusa",
    options: {
      apiToken: process.env.PRINTFUL_API_TOKEN,
      // Default "flag" — sets printful_discontinued on the product
      onDiscontinued: "flag", // or "ignore"
      // Default "unpublish" — draft products missing from a full Printful list
      onRemovedFromPrintful: "unpublish", // or "ignore"
    },
  },
]
```

- **`onRemovedFromPrintful` only runs on a full sync** (no `limit`). A partial
  sync never treats the rest of the catalogue as deleted.
- Re-adding a product in Printful and syncing again clears `printful_removed`
  and can republish if stock allows and the plugin still owns the draft.

## What this is not

- Not real-time stock (Printful v1 stock webhooks are limited; full real-time is
  a later / v2 topic).
- Not Medusa inventory levels — do not expect `inventory_quantity` to move.
- Not a guarantee that Admin “add to order” flows honor metadata; that is
  Admin/storefront responsibility.

## Related keys (for debugging)

| Key                           | Meaning                               |
| ----------------------------- | ------------------------------------- |
| `printful_sync_variant_id`    | Id used when creating Printful orders |
| `printful_catalog_variant_id` | Catalog blank used for shipping rates |
| `printful_sync_product_id`    | Printful sync product id              |
