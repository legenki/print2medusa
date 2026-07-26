import { Module } from "@medusajs/framework/utils"
import PrintfulModuleService from "./service"

export const PRINTFUL_MODULE = "printful"

export default Module(PRINTFUL_MODULE, {
  service: PrintfulModuleService,
})
