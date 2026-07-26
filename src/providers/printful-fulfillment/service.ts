import {
  AbstractFulfillmentProviderService,
  MedusaError,
} from "@medusajs/framework/utils"
import type {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CreateShippingOptionDTO,
  FulfillmentOption,
  CreateFulfillmentResult,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOrderDTO,
} from "@medusajs/framework/types"
import { PrintfulClient } from "../../utils/printful-client"
import type { PrintfulPluginOptions } from "../../utils/types"

type InjectedDependencies = {
  logger: {
    info: (msg: string) => void
    error: (msg: string) => void
    warn: (msg: string) => void
  }
}

class PrintfulFulfillmentProviderService extends AbstractFulfillmentProviderService {
  static identifier = "printful"

  protected logger_: InjectedDependencies["logger"]
  protected options_: PrintfulPluginOptions
  protected client_: PrintfulClient

  constructor(container: InjectedDependencies, options: PrintfulPluginOptions) {
    super()
    this.logger_ = container.logger
    this.options_ = options || ({} as PrintfulPluginOptions)

    if (!this.options_.apiToken) {
      this.logger_.warn(
        "Printful fulfillment provider: apiToken is missing from options"
      )
    }

    this.client_ = new PrintfulClient({
      apiToken: this.options_.apiToken || "",
      storeId: this.options_.storeId,
    })
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      {
        id: "printful-standard",
        name: "Printful Standard",
      },
      {
        id: "printful-return",
        name: "Printful Return",
        is_return: true,
      },
    ]
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    return typeof data?.id === "string" || data?.id == null
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return {
      ...data,
      printful_option_id: optionData?.id ?? "printful-standard",
    }
  }

  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    // Live rates are Phase 2
    return false
  }

  async calculatePrice(
    _optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    _context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Printful fulfillment does not support calculated prices yet"
    )
  }

  async createFulfillment(
    data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<
      Omit<FulfillmentDTO, "provider_id" | "data" | "items">
    >
  ): Promise<CreateFulfillmentResult> {
    // Prefer order created by payment.captured subscriber; attach id if present.
    const existingId =
      (data?.printful_order_id as string | undefined) ||
      (fulfillment?.metadata?.printful_order_id as string | undefined)

    if (existingId) {
      return {
        data: {
          ...(typeof data === "object" ? data : {}),
          printful_order_id: existingId,
        },
        labels: [],
      }
    }

    // Best-effort: if order has external printful mapping via metadata, reuse.
    // Full auto-create is handled by create-printful-order workflow (subscriber).
    this.logger_.info(
      `Printful fulfillment created for order ${order?.id ?? "unknown"} ` +
        `(items: ${items?.length ?? 0}). Expect Printful order from payment.captured subscriber.`
    )

    return {
      data: {
        ...(typeof data === "object" ? data : {}),
        medusa_order_id: order?.id,
      },
      labels: [],
    }
  }

  async cancelFulfillment(data: Record<string, unknown>): Promise<unknown> {
    const printfulOrderId = data?.printful_order_id as string | undefined
    if (!printfulOrderId) {
      return {}
    }

    try {
      await this.client_.cancelOrder(printfulOrderId)
    } catch (err) {
      this.logger_.error(
        `Failed to cancel Printful order ${printfulOrderId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    return {}
  }

  async createReturnFulfillment(
    fulfillment: Record<string, unknown>
  ): Promise<CreateFulfillmentResult> {
    return {
      data: {
        ...(fulfillment?.data as object),
        is_return: true,
      },
      labels: [],
    }
  }
}

export default PrintfulFulfillmentProviderService
