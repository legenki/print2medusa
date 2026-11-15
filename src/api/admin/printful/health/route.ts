import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRINTFUL_MODULE } from "../../../../modules/printful"
import type PrintfulModuleService from "../../../../modules/printful/service"
import {
  summarizeWebhookHealth,
  WEBHOOK_HEALTH_WINDOW,
  type WebhookHealthRow,
} from "../../../../utils/webhook-health"

/**
 * Webhook delivery health.
 *
 * This route does NOT call Printful. `client.getWebhookConfig()` exists and
 * would report the registered URL authoritatively, but a panel whose entire
 * job is to tell the owner whether Printful is reaching them must not go dark
 * when Printful is down — an outage would turn the one screen you check
 * during an outage into an error. Everything here is answered from local rows
 * and plugin options, so it renders during a Printful outage and, in fact,
 * shows exactly the symptom (no recent events) that an outage produces.
 *
 * `/admin/printful/webhook` still exposes the live config for the moment an
 * admin actually wants to inspect or overwrite the registration, and that
 * route is the right place for a network call because the admin asked for it.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const printful: PrintfulModuleService = req.scope.resolve(PRINTFUL_MODULE)
  const options = await printful.getOptions()

  const rows = (await printful.listPrintfulWebhookEvents(
    {},
    { take: WEBHOOK_HEALTH_WINDOW, order: { created_at: "DESC" } }
  )) as WebhookHealthRow[]

  const summary = summarizeWebhookHealth(rows, {
    secret_set: Boolean(options.webhookSecret),
  })

  res.status(200).json({
    ...summary,
    window: WEBHOOK_HEALTH_WINDOW,
  })
}
