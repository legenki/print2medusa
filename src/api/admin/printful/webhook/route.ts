import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"
import { PRINTFUL_WEBHOOK_TYPES } from "../../../../utils/webhook-events"

/**
 * Printful returns the webhook URL we registered, which embeds our secret
 * token as its last path segment (see POST below). The GET here is
 * admin-authenticated, so returning the URL at all is defensible — the whole
 * point of this endpoint is to show the current config before an admin
 * overwrites it. But the secret is a bearer credential (anyone who has it can
 * forge webhook deliveries prior to the timing-safe check even being
 * relevant, since it's compared as-is), and this endpoint is polled on every
 * widget mount, so there is no reason to put it on the wire repeatedly. Mask
 * everything after the last path segment so the UI can still show host+path
 * shape and confirm "yes, a Printful webhook is registered here" without
 * re-exposing the live token on every page load.
 */
function maskSecretInUrl(url: string | null): string | null {
  if (!url) {
    return url
  }
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split("/").filter(Boolean)
    if (segments.length > 0) {
      segments[segments.length - 1] = "••••••••"
      parsed.pathname = `/${segments.join("/")}`
    }
    return parsed.toString()
  } catch {
    return url
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const client = await printful.getClient()
  const options = await printful.getOptions()

  const current = await client.getWebhookConfig()

  res.status(200).json({
    current: {
      ...current,
      url: maskSecretInUrl(current.url),
    },
    configured_types: PRINTFUL_WEBHOOK_TYPES,
    secret_set: Boolean(options.webhookSecret),
  })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const client = await printful.getClient()
  const options = await printful.getOptions()

  if (!options.webhookSecret) {
    res.status(400).json({
      message: "Set the webhookSecret plugin option before registering a webhook",
    })
    return
  }

  const body = (req.body ?? {}) as { base_url?: string }
  if (!body.base_url) {
    res.status(400).json({ message: "base_url is required" })
    return
  }

  const url = `${body.base_url.replace(/\/$/, "")}/hooks/printful/${options.webhookSecret}`

  // Printful keeps one config per store, so this replaces the whole allowlist.
  const updated = await client.setWebhookConfig(url, [...PRINTFUL_WEBHOOK_TYPES])

  res.status(200).json({
    current: {
      ...updated,
      url: maskSecretInUrl(updated.url),
    },
  })
}
