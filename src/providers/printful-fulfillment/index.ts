import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import PrintfulFulfillmentProviderService from "./service"

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [PrintfulFulfillmentProviderService],
})
