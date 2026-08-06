import { defineRouteConfig } from "@medusajs/admin-sdk"
import {
  Badge,
  Button,
  Container,
  Copy,
  Heading,
  Input,
  Prompt,
  Select,
  Table,
  Text,
  toast,
} from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"

type SyncRow = {
  id: string
  status: string
  started_at?: string | null
  finished_at?: string | null
  heartbeat_at?: string | null
  products_created?: number
  products_updated?: number
  products_failed?: number
  products_processed?: number
  products_total?: number
  error_message?: string | null
}

type Health = {
  total: number
  received: number
  deferred: number
  failed: number
  processed: number
  last_event_at?: string | null
  ever_received: boolean
  registered: boolean
  secret_set: boolean
  window: number
}

/** Only the fields this page renders; the route returns more. */
type Stats = {
  currency?: string
  profit?: { value?: number; relative_difference?: number }
  total_paid_orders?: { value?: number; relative_difference?: number }
  average_fulfillment_time?: { value?: number; relative_difference?: number }
}

type PromptRow = {
  product_id: string
  title: string
  product_class: string
  prompts: Array<{ text: string; label: string; placement: string }>
}

type DesignRow = {
  product_id: string
  title: string
  product_class: string
  technique?: string
  techniques: string[]
  core_placements: string[]
  placements: string[]
  brand?: string
  model?: string
  material?: string
  dimensions?: string
  colors: Array<{ name: string; hex?: string }>
  sizes: string[]
}

/**
 * The class decides what a design even is on this product: ink on fabric,
 * thread, or a printed sheet. Labelled rather than shown raw, because
 * "embroidery" on its own reads as a technique rather than a product kind.
 */
const CLASS_LABEL: Record<string, string> = {
  apparel: "Apparel",
  embroidery: "Embroidered",
  print_media: "Print media",
}

const CLASS_COLOUR: Record<string, "green" | "orange" | "blue" | "grey"> = {
  apparel: "blue",
  embroidery: "orange",
  print_media: "green",
}

const STATUS_COLOUR: Record<string, "green" | "orange" | "red" | "grey"> = {
  success: "green",
  running: "orange",
  partial: "orange",
  failed: "red",
}

/**
 * A sync whose heartbeat stopped is not necessarily dead — it may be between
 * beats. This only decides whether to *offer* the clear button; the server
 * checks the heartbeat again and refuses if the sync is alive, so a wrong
 * guess here costs a 409 rather than a killed sync.
 */
const looksStuck = (
  row: SyncRow | undefined,
  staleMinutes: number
): boolean => {
  if (!row || row.status !== "running") {
    return false
  }
  const beat = row.heartbeat_at ?? row.started_at
  if (!beat) {
    return true
  }
  return Date.now() - new Date(beat).getTime() > staleMinutes * 60_000
}

const minutesSince = (iso?: string | null): number | null => {
  if (!iso) {
    return null
  }
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
}

const PrintfulPage = () => {
  const [syncs, setSyncs] = useState<SyncRow[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [designs, setDesigns] = useState<DesignRow[]>([])
  const [promptProducts, setPromptProducts] = useState<PromptRow[]>([])
  const [styles, setStyles] = useState<Array<{ id: string; label: string }>>([])
  const [style, setStyle] = useState("editorial")
  // What the artwork is. Optional — a prompt without it still describes the
  // product truthfully, which is the part the plugin can actually vouch for.
  const [artwork, setArtwork] = useState("")
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)

  const load = useCallback(async () => {
    // Each panel is fetched independently and failures are swallowed per
    // panel: this is the screen an owner opens *because* something is wrong,
    // so one dead endpoint must not blank the other two.
    const [h, w, s, d] = await Promise.allSettled([
      fetch("/admin/printful/history", { credentials: "include" }),
      fetch("/admin/printful/health", { credentials: "include" }),
      fetch("/admin/printful/statistics", { credentials: "include" }),
      fetch("/admin/printful/design", { credentials: "include" }),
    ])

    if (h.status === "fulfilled" && h.value.ok) {
      const body = await h.value.json()
      setSyncs(body.syncs ?? [])
    }
    if (w.status === "fulfilled" && w.value.ok) {
      setHealth(await w.value.json())
    }
    if (s.status === "fulfilled" && s.value.ok) {
      const body = await s.value.json()
      setStats(body.statistics?.[0] ?? null)
    }
    if (d.status === "fulfilled" && d.value.ok) {
      const body = await d.value.json()
      setDesigns(body.designs ?? [])
    }
    setLoading(false)
  }, [])

  const loadPrompts = useCallback(async () => {
    const params = new URLSearchParams({ style })
    if (artwork.trim()) {
      params.set("artwork", artwork.trim())
    }
    try {
      const res = await fetch(`/admin/printful/prompts?${params}`, {
        credentials: "include",
      })
      if (!res.ok) {
        return
      }
      const body = await res.json()
      setPromptProducts(body.products ?? [])
      setStyles(body.styles ?? [])
    } catch {
      // Same rule as the other panels: a dead endpoint leaves this section
      // empty rather than blanking the page.
    }
  }, [style, artwork])

  useEffect(() => {
    void load()
  }, [load])

  // Separate from `load` on purpose. Prompts depend on the style and artwork
  // the admin is typing, and the sync poll runs every three seconds — sharing
  // a fetch would rebuild the list under the cursor.
  useEffect(() => {
    void loadPrompts()
  }, [loadPrompts])

  const latest = syncs[0]
  const running = latest?.status === "running"

  // Poll only while a sync is running, so an idle page costs nothing.
  useEffect(() => {
    if (!running) {
      return
    }
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [running, load])

  const clearStuck = async () => {
    setClearing(true)
    try {
      const res = await fetch("/admin/printful/sync/clear", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "clear-stuck-sync" }),
      })
      const body = await res.json().catch(() => ({}))

      if (res.ok) {
        toast.success("Cleared the stuck sync", {
          description: body.error_message,
        })
      } else if (res.status === 409) {
        // The server saw a heartbeat we did not. Not a failure — the sync is
        // alive, which is better news than the button implied.
        toast.info("The sync is still alive", {
          description: "It checked in while you were looking. Nothing cleared.",
        })
      } else {
        toast.error("Could not clear the sync", { description: body.message })
      }
      await load()
    } catch (err) {
      toast.error("Could not clear the sync", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setClearing(false)
    }
  }

  const stuck = looksStuck(latest, health?.window ?? 60)
  const silentFor = minutesSince(latest?.heartbeat_at ?? latest?.started_at)

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h1">Printful</Heading>
        <Button
          size="small"
          variant="secondary"
          onClick={() => void load()}
          disabled={loading}
        >
          Refresh
        </Button>
      </div>

      {stuck && (
        <div className="px-6 py-4 flex flex-col gap-2">
          <Text size="small" weight="plus">
            This sync looks stuck
          </Text>
          <Text size="small" className="text-ui-fg-subtle">
            It has not checked in
            {silentFor != null ? ` for ${silentFor} minutes` : ""}. Until it is
            cleared or reclaimed, no other sync can start.
          </Text>
          <Prompt>
            <Prompt.Trigger asChild>
              <Button size="small" variant="danger" disabled={clearing}>
                Clear it
              </Button>
            </Prompt.Trigger>
            <Prompt.Content>
              <Prompt.Header>
                <Prompt.Title>Clear the stuck sync?</Prompt.Title>
                <Prompt.Description>
                  This marks the run as failed so a new sync can start. If it
                  turns out to be alive, nothing is cleared. Products already
                  imported are not touched.
                </Prompt.Description>
              </Prompt.Header>
              <Prompt.Footer>
                <Prompt.Cancel>Cancel</Prompt.Cancel>
                <Prompt.Action onClick={() => void clearStuck()}>
                  Clear
                </Prompt.Action>
              </Prompt.Footer>
            </Prompt.Content>
          </Prompt>
        </div>
      )}

      <div className="px-6 py-4 flex flex-col gap-2">
        <Text size="small" weight="plus">
          Sales
        </Text>
        {stats ? (
          <>
            <Text size="small" className="text-ui-fg-subtle">
              Paid orders: {stats.total_paid_orders?.value ?? "—"}
            </Text>
            <Text size="small" className="text-ui-fg-subtle">
              Profit: {stats.profit?.value ?? "—"}{" "}
              {stats.currency?.toUpperCase() ?? ""}
            </Text>
          </>
        ) : (
          <Text size="small" className="text-ui-fg-subtle">
            {loading ? "Loading…" : "Printful reported no statistics."}
          </Text>
        )}
      </div>

      <div className="px-6 py-4 flex flex-col gap-2">
        <Text size="small" weight="plus">
          Webhooks
        </Text>
        {health && !health.ever_received && (
          // The state a misconfigured webhook leaves behind, and the reason
          // this panel exists: a store can look fine and never hear back.
          <Text size="small" className="text-ui-fg-subtle">
            {health.secret_set
              ? "A secret is configured, but nothing has arrived yet."
              : "No webhook secret is configured."}
          </Text>
        )}
        {health && health.ever_received && (
          <>
            <Text size="small" className="text-ui-fg-subtle">
              Last event:{" "}
              {health.last_event_at
                ? new Date(health.last_event_at).toLocaleString()
                : "—"}
            </Text>
            <Text size="small" className="text-ui-fg-subtle">
              {health.processed} processed · {health.deferred} waiting ·{" "}
              {health.failed} failed
            </Text>
          </>
        )}
      </div>

      <div className="px-6 py-4 flex flex-col gap-3">
        <Text size="small" weight="plus">
          Design parameters
        </Text>
        {designs.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">
            {loading
              ? "Loading…"
              : "No products carry design parameters yet. Run a sync."}
          </Text>
        ) : (
          designs.map((d) => (
            <div key={d.product_id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Text size="small" weight="plus">
                  {d.title}
                </Text>
                <Badge color={CLASS_COLOUR[d.product_class] ?? "grey"}>
                  {CLASS_LABEL[d.product_class] ?? d.product_class}
                </Badge>
              </div>

              <Text size="small" className="text-ui-fg-subtle">
                {/* Technique first: it is what decides whether a design is ink
                    or thread, and a prompt that gets it wrong describes the
                    wrong object entirely. */}
                {d.technique ?? "—"}
                {d.brand ? ` · ${d.brand}${d.model ? ` ${d.model}` : ""}` : ""}
                {d.material ? ` · ${d.material}` : ""}
              </Text>

              <Text size="small" className="text-ui-fg-subtle">
                Design goes on: {d.core_placements.join(", ") || "—"}
                {d.placements.length > d.core_placements.length
                  ? ` (${d.placements.length - d.core_placements.length} more available)`
                  : ""}
              </Text>

              {d.colors.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <Text size="small" className="text-ui-fg-subtle">
                    Base colours:
                  </Text>
                  {d.colors.slice(0, 12).map((c) => (
                    <span
                      key={c.name}
                      title={`${c.name}${c.hex ? ` ${c.hex}` : ""}`}
                      className="inline-block h-4 w-4 rounded border border-ui-border-base"
                      // Only a real hex paints a swatch. A missing one would
                      // otherwise render as black and claim a colour Printful
                      // never reported.
                      style={c.hex ? { backgroundColor: c.hex } : undefined}
                    />
                  ))}
                  {d.colors.length > 12 && (
                    <Text size="small" className="text-ui-fg-subtle">
                      +{d.colors.length - 12}
                    </Text>
                  )}
                </div>
              )}

              {d.sizes.length > 0 && (
                <Text size="small" className="text-ui-fg-subtle">
                  {d.product_class === "print_media" ? "Sizes" : "Sizes"}:{" "}
                  {d.sizes.slice(0, 8).join(", ")}
                  {d.sizes.length > 8 ? ` +${d.sizes.length - 8}` : ""}
                </Text>
              )}
            </div>
          ))
        )}
      </div>

      <div className="px-6 py-4 flex flex-col gap-3">
        <Text size="small" weight="plus">
          Mockup prompts
        </Text>
        <Text size="small" className="text-ui-fg-subtle">
          Paste these into an image model. Printful&rsquo;s own generator
          renders a product on a plain background &mdash; right for a catalogue
          thumbnail, not for an editorial mockup.
        </Text>

        <div className="flex items-center gap-2 flex-wrap">
          <Select value={style} onValueChange={setStyle}>
            <Select.Trigger className="w-40">
              <Select.Value placeholder="Style" />
            </Select.Trigger>
            <Select.Content>
              {styles.map((s) => (
                <Select.Item key={s.id} value={s.id}>
                  {s.label}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
          <Input
            className="flex-1 min-w-64"
            placeholder="What is the artwork? (optional)"
            value={artwork}
            onChange={(e) => setArtwork(e.target.value)}
          />
        </div>

        {promptProducts.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">
            {loading
              ? "Loading\u2026"
              : "No prompts yet. Run a sync so products carry design parameters."}
          </Text>
        ) : (
          promptProducts.map((p) => (
            <div key={p.product_id} className="flex flex-col gap-2">
              <Text size="small" weight="plus">
                {p.title}
              </Text>
              {p.prompts.map((prompt, i) => (
                <div
                  key={`${p.product_id}-${i}`}
                  className="flex items-start gap-2 rounded-md border border-ui-border-base p-2"
                >
                  <div className="flex flex-col gap-1 flex-1">
                    <Text size="xsmall" className="text-ui-fg-muted">
                      {prompt.label}
                    </Text>
                    <Text size="small" className="text-ui-fg-subtle">
                      {prompt.text}
                    </Text>
                  </div>
                  {/* Copy rather than a select-all: the prompt is long enough
                      that hand-selecting it is the slow step in a workflow
                      repeated seven times a fortnight. */}
                  <Copy content={prompt.text} />
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      <div className="px-6 py-4 flex flex-col gap-2">
        <Text size="small" weight="plus">
          Recent syncs
        </Text>
        {syncs.length === 0 ? (
          <Text size="small" className="text-ui-fg-subtle">
            {loading ? "Loading…" : "No syncs yet."}
          </Text>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Started</Table.HeaderCell>
                <Table.HeaderCell>Status</Table.HeaderCell>
                <Table.HeaderCell>Result</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {syncs.map((row) => (
                <Table.Row key={row.id}>
                  <Table.Cell>
                    {row.started_at
                      ? new Date(row.started_at).toLocaleString()
                      : "—"}
                  </Table.Cell>
                  <Table.Cell>
                    <Badge color={STATUS_COLOUR[row.status] ?? "grey"}>
                      {row.status}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    {row.status === "running"
                      ? `${row.products_processed ?? 0} of ${row.products_total ?? "?"}`
                      : `${row.products_created ?? 0} created · ${row.products_updated ?? 0} updated · ${row.products_failed ?? 0} failed`}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Printful",
})

export default PrintfulPage
