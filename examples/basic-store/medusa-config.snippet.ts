/**
 * Example snippet — merge into your Medusa app's medusa-config.ts
 */
import { loadEnv, defineConfig, Modules } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      // No fallback: a default secret copied into production lets anyone
      // who knows it forge admin sessions and tokens.
      jwtSecret: process.env.JWT_SECRET!,
      cookieSecret: process.env.COOKIE_SECRET!,
    },
  },
  plugins: [
    {
      resolve: "@legenki/print2medusa",
      options: {
        apiToken: process.env.PRINTFUL_API_TOKEN,
        storeId: process.env.PRINTFUL_STORE_ID,
        // At least 32 characters; generate with `openssl rand -hex 32`.
        webhookSecret: process.env.PRINTFUL_WEBHOOK_SECRET,
        // autoSubmitOrders: true,
        // createOnOrderPlaced: false,
        // allowPartialOrders: false,
        // markupPercent: 30,
        // defaultCurrency: "USD",
        // onDiscontinued: "flag",
        // onRemovedFromPrintful: "unpublish", // or "ignore"
        // Live shipping rates are configured on the provider below, which
        // never sees these plugin options.
      },
    },
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/fulfillment",
      // Required for live rates + shipping method confirmation.
      dependencies: ["query"],
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/fulfillment-manual",
            id: "manual",
          },
          {
            resolve: "@legenki/print2medusa/providers/printful-fulfillment",
            id: "printful",
            options: {
              apiToken: process.env.PRINTFUL_API_TOKEN,
              storeId: process.env.PRINTFUL_STORE_ID,
              // liveShippingRates: true,
              // fallbackShippingRates: { STANDARD: 5 },
            },
          },
        ],
      },
    },
  ],
})

// silence unused import when copying
void Modules
