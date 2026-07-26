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
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  plugins: [
    {
      resolve: "@legenki/print2medusa",
      options: {
        apiToken: process.env.PRINTFUL_API_TOKEN,
        storeId: process.env.PRINTFUL_STORE_ID,
        // autoSubmitOrders: true,
        // createOnOrderPlaced: false,
        // allowPartialOrders: false,
        // markupPercent: 30,
        // defaultCurrency: "USD",
      },
    },
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/fulfillment",
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
            },
          },
        ],
      },
    },
  ],
})

// silence unused import when copying
void Modules
