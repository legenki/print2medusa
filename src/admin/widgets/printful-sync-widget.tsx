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

const PrintfulSyncWidget = () => {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)

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

  useEffect(() => {
    void loadStatus()
  }, [])

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
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "product.list.before",
})

export default PrintfulSyncWidget
