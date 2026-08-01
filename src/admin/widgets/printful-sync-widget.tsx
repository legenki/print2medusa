import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"

type SyncStatus = {
  store_id?: string
  running?: boolean
  latest_sync?: {
    id: string
    status: string
    started_at: string
    finished_at?: string | null
    products_created?: number
    products_updated?: number
    products_failed?: number
    error_message?: string | null
  } | null
}

type WebhookConfig = {
  url: string | null
  types: string[]
}

type WebhookStatus = {
  current: WebhookConfig
  configured_types: readonly string[]
  secret_set: boolean
}

const PrintfulSyncWidget = () => {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const [webhook, setWebhook] = useState<WebhookStatus | null>(null)
  const [webhookLoading, setWebhookLoading] = useState(false)
  const [registering, setRegistering] = useState(false)

  const loadStatus = async () => {
    setLoading(true)
    try {
      const res = await fetch("/admin/printful/status", {
        credentials: "include",
      })
      if (!res.ok) {
        throw new Error(`Status ${res.status}`)
      }
      const data = (await res.json()) as SyncStatus
      setStatus(data)
    } catch (e) {
      // Widget may load before routes are registered
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  const loadWebhook = async () => {
    setWebhookLoading(true)
    try {
      const res = await fetch("/admin/printful/webhook", {
        credentials: "include",
      })
      if (!res.ok) {
        throw new Error(`Status ${res.status}`)
      }
      const data = (await res.json()) as WebhookStatus
      setWebhook(data)
    } catch (e) {
      // Widget may load before routes are registered
      console.error(e)
    } finally {
      setWebhookLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
    void loadWebhook()
  }, [])

  const onRegisterWebhook = async () => {
    setRegistering(true)
    try {
      const res = await fetch("/admin/printful/webhook", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: window.location.origin }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `Registration failed (${res.status})`)
      }
      toast.success("Printful webhook registered", {
        description:
          "The new configuration replaced any previous Printful webhook.",
      })
      await loadWebhook()
    } catch (e) {
      toast.error("Failed to register webhook", {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRegistering(false)
    }
  }

  const onSync = async () => {
    setSyncing(true)
    try {
      const res = await fetch("/admin/printful/sync", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `Sync failed (${res.status})`)
      }
      const data = await res.json()
      toast.success("Printful sync finished", {
        description: `Created ${data.counters?.created ?? 0}, updated ${
          data.counters?.updated ?? 0
        }, failed ${data.counters?.failed ?? 0}`,
      })
      await loadStatus()
    } catch (e) {
      toast.error("Printful sync failed", {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setSyncing(false)
    }
  }

  const latest = status?.latest_sync

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Printful</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Sync store products from Printful into Medusa
          </Text>
        </div>
        <Button
          size="small"
          onClick={() => void onSync()}
          isLoading={syncing}
          disabled={loading || syncing}
        >
          Sync Now
        </Button>
      </div>
      <div className="px-6 py-4 flex flex-col gap-1">
        {loading && !latest ? (
          <Text size="small">Loading status…</Text>
        ) : latest ? (
          <>
            <Text size="small">
              Last status: <strong>{latest.status}</strong>
            </Text>
            <Text size="small" className="text-ui-fg-subtle">
              Started: {new Date(latest.started_at).toLocaleString()}
              {latest.finished_at
                ? ` · Finished: ${new Date(latest.finished_at).toLocaleString()}`
                : ""}
            </Text>
            <Text size="small" className="text-ui-fg-subtle">
              Created {latest.products_created ?? 0} · Updated{" "}
              {latest.products_updated ?? 0} · Failed{" "}
              {latest.products_failed ?? 0}
            </Text>
            {latest.error_message ? (
              <Text size="small" className="text-ui-fg-error">
                {latest.error_message.slice(0, 300)}
              </Text>
            ) : null}
          </>
        ) : (
          <Text size="small" className="text-ui-fg-subtle">
            No sync runs yet.
          </Text>
        )}
      </div>
      <div className="px-6 py-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Heading level="h3">Webhook</Heading>
          <Button
            size="small"
            variant="secondary"
            onClick={() => void onRegisterWebhook()}
            isLoading={registering}
            disabled={webhookLoading || registering || !webhook?.secret_set}
          >
            Register webhook
          </Button>
        </div>
        <Text size="small" className="text-ui-fg-subtle">
          Printful allows only one webhook configuration per store. Registering
          replaces any existing Printful webhook URL and event list — including
          one set up by another integration or a previous install of this
          plugin.
        </Text>
        {webhookLoading && !webhook ? (
          <Text size="small">Loading webhook configuration…</Text>
        ) : webhook ? (
          <>
            <Text size="small">
              Current URL:{" "}
              <strong>{webhook.current.url ?? "Not configured"}</strong>
            </Text>
            <Text size="small" className="text-ui-fg-subtle">
              Current events:{" "}
              {webhook.current.types.length > 0
                ? webhook.current.types.join(", ")
                : "None"}
            </Text>
            <Text size="small" className="text-ui-fg-subtle">
              Will register: {webhook.configured_types.join(", ")}
            </Text>
            {!webhook.secret_set ? (
              <Text size="small" className="text-ui-fg-error">
                Set the webhookSecret plugin option before registering a
                webhook.
              </Text>
            ) : null}
          </>
        ) : (
          <Text size="small" className="text-ui-fg-subtle">
            Unable to load webhook configuration.
          </Text>
        )}
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.list.before",
})

export default PrintfulSyncWidget
