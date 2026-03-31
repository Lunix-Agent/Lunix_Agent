// @ts-nocheck — OpenTUI JSX types don't match standard React IntrinsicAttributes
import { readFileBuffer, isMainModule } from "../compat.ts"
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useState, useMemo } from "react"
import FitParser from "fit-file-parser"
import path from "node:path"

// ─── Types ───────────────────────────────────────────────────────────────────

interface MsgType {
  key: string
  items: Record<string, unknown>[]
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

const DISPLAY_LIMIT = 100

// Extract all non-empty message types from a parsed list-mode FIT object
function buildTypes(fitData: Record<string, unknown>): MsgType[] {
  const result: MsgType[] = []
  for (const [key, val] of Object.entries(fitData)) {
    if (val === null || val === undefined) continue
    if (typeof val === "number" || typeof val === "string") continue
    if (Array.isArray(val) && val.length > 0) {
      result.push({ key, items: val as Record<string, unknown>[] })
    } else if (!Array.isArray(val) && typeof val === "object") {
      result.push({ key, items: [val as Record<string, unknown>] })
    }
  }
  return result.sort((a, b) => b.items.length - a.items.length)
}

function fmtValue(val: unknown): string {
  if (val === null || val === undefined) return "—"
  if (typeof val === "boolean") return val ? "true" : "false"
  if (typeof val === "number") return String(val)
  if (typeof val === "string") return val
  if (Array.isArray(val)) return `[${val.join(", ")}]`
  if (typeof val === "object") {
    const str = JSON.stringify(val)
    return str.length > 60 ? str.slice(0, 57) + "…" : str
  }
  return String(val)
}

// Pick a short "label" for a message to show in its header line
function msgLabel(item: Record<string, unknown>): string {
  const hints = ["timestamp", "event", "type", "sport", "manufacturer", "field_name", "name"]
  for (const h of hints) {
    if (item[h] !== undefined && item[h] !== null) {
      const v = fmtValue(item[h])
      return v.length > 30 ? v.slice(0, 28) + "…" : v
    }
  }
  return ""
}

// ─── Colors ──────────────────────────────────────────────────────────────────

const C = {
  bg: "#0d1117",
  panelBg: "#161b22",
  headerBg: "#0d2137",
  selectedBg: "#1f3a5f",
  selectedFocusBg: "#1f6feb",
  border: "#30363d",
  focusBorder: "#58a6ff",
  text: "#e6edf3",
  dim: "#8b949e",
  accent: "#58a6ff",
  key: "#79c0ff",    // field key color
  val: "#e6edf3",    // field value color
  idx: "#8b949e",    // message index color
  label: "#7ee787",  // message label color
  count: "#d2a8ff",  // count color
  sep: "#21262d",    // separator line
}

// ─── Components ──────────────────────────────────────────────────────────────

function TypeRow({ type, index, selected, panelFocused }: {
  type: MsgType
  index: number
  selected: boolean
  panelFocused: boolean
}) {
  const bg = selected
    ? panelFocused ? C.selectedFocusBg : C.selectedBg
    : C.panelBg
  const marker = selected ? "▶" : " "

  // truncate long key names
  const label = type.key.length > 14 ? type.key.slice(0, 13) + "…" : type.key

  return (
    <box backgroundColor={bg} height={1} flexDirection="row" paddingLeft={1}>
      <text fg={selected ? C.accent : C.dim} width={2}>{marker}</text>
      <text fg={selected ? C.text : C.dim} width={3}>{index + 1}</text>
      <text fg={selected ? C.text : C.text} width={16}>{label}</text>
      <text fg={C.count}>{type.items.length}</text>
    </box>
  )
}

function FieldRow({ name, value }: { name: string; value: unknown }) {
  const displayName = name.length > 22 ? name.slice(0, 21) + "…" : name
  const displayVal = fmtValue(value)

  return (
    <box flexDirection="row" height={1} paddingLeft={4}>
      <text fg={C.key} width={24}>{displayName}</text>
      <text fg={C.val}>{displayVal}</text>
    </box>
  )
}

function MsgBlock({ item, index }: { item: Record<string, unknown>; index: number }) {
  const label = msgLabel(item)
  const fields = Object.entries(item)

  return (
    <box flexDirection="column">
      {/* message header */}
      <box flexDirection="row" height={1} paddingLeft={2}>
        <text fg={C.idx}>#{index + 1}</text>
        {label ? <text fg={C.label}>  {label}</text> : null}
      </box>
      {/* fields */}
      {fields.map(([k, v]) => (
        <FieldRow key={k} name={k} value={v} />
      ))}
      {/* separator */}
      <box height={1} />
    </box>
  )
}

function MessagesPanel({ type, focused }: { type: MsgType; focused: boolean }) {
  const shown = type.items.slice(0, DISPLAY_LIMIT)
  const hidden = type.items.length - shown.length
  const hint = focused ? "↑↓ scroll" : "[Tab] to focus"

  return (
    <box
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={focused ? C.focusBorder : C.border}
      title={` ${type.key}  [${type.items.length}]  •  ${hint} `}
      backgroundColor={C.panelBg}
      flexDirection="column"
    >
      {/* field header bar */}
      <box height={1} paddingX={2} backgroundColor={C.headerBg} flexDirection="row">
        <text fg={C.dim} width={6}>#</text>
        <text fg={C.key} width={24}>field</text>
        <text fg={C.val}>value</text>
      </box>

      <scrollbox focused={focused}>
        <box flexDirection="column">
          {shown.map((item, i) => (
            <MsgBlock key={i} item={item} index={i} />
          ))}
          {hidden > 0 && (
            <box paddingLeft={2} paddingY={1}>
              <text fg={C.dim}>… {hidden} more messages not shown</text>
            </box>
          )}
        </box>
      </scrollbox>
    </box>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App({ types, filename, version }: {
  types: MsgType[]
  filename: string
  version: string
}) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [selectedType, setSelectedType] = useState(0)
  const [focus, setFocus] = useState<"types" | "messages">("types")

  useKeyboard((key) => {
    if (key.name === "q") {
      renderer.destroy()
      return
    }
    if (key.name === "tab") {
      setFocus(f => f === "types" ? "messages" : "types")
      return
    }
    if (focus === "types") {
      if (key.name === "up" || key.name === "k") {
        setSelectedType(i => Math.max(0, i - 1))
      } else if (key.name === "down" || key.name === "j") {
        setSelectedType(i => Math.min(types.length - 1, i + 1))
      }
    }
  })

  const current = types[selectedType]!

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={C.bg}>

      {/* Header */}
      <box
        height={3}
        backgroundColor={C.headerBg}
        flexDirection="row"
        alignItems="center"
        paddingX={2}
        gap={1}
        border
        borderStyle="single"
        borderColor={C.border}
      >
        <text fg={C.accent}><strong>FIT Raw Explorer</strong></text>
        <text fg={C.dim}>│</text>
        <text fg={C.text}>{filename}</text>
        <text fg={C.dim}>│</text>
        <text fg={C.dim}>v{version}</text>
        <text fg={C.dim}>│</text>
        <text fg={C.count}>{types.length} types</text>
        <text fg={C.dim}>│</text>
        <text fg={C.dim}>{types.reduce((n, t) => n + t.items.length, 0).toLocaleString()} total messages</text>
      </box>

      {/* Main */}
      <box flexGrow={1} flexDirection="row">

        {/* Left: type list */}
        <box
          width={26}
          border
          borderStyle="rounded"
          borderColor={focus === "types" ? C.focusBorder : C.border}
          title={` Types `}
          backgroundColor={C.panelBg}
          flexDirection="column"
        >
          <box flexDirection="row" height={1} paddingLeft={1} backgroundColor={C.headerBg}>
            <text fg={C.dim} width={5}> #</text>
            <text fg={C.key} width={16}>type</text>
            <text fg={C.count}>count</text>
          </box>
          <scrollbox focused={focus === "types"}>
            <box flexDirection="column">
              {types.map((t, i) => (
                <TypeRow
                  key={t.key}
                  type={t}
                  index={i}
                  selected={i === selectedType}
                  panelFocused={focus === "types"}
                />
              ))}
            </box>
          </scrollbox>
        </box>

        {/* Right: messages */}
        <MessagesPanel type={current} focused={focus === "messages"} />
      </box>

      {/* Footer */}
      <box
        height={1}
        backgroundColor={C.headerBg}
        flexDirection="row"
        alignItems="center"
        paddingX={2}
        gap={1}
      >
        <text fg={C.accent}>[j/k]</text>
        <text fg={C.dim}>Navigate types</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[Tab]</text>
        <text fg={C.dim}>Switch panel</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[↑↓]</text>
        <text fg={C.dim}>Scroll messages</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[q]</text>
        <text fg={C.dim}>Quit</text>
      </box>

    </box>
  )
}

// ─── Render entry point ─────────────────────────────────────────────────────

export async function renderRaw(filePath: string): Promise<void> {
  const resolved = path.resolve(process.cwd(), filePath)
  const buffer = await readFileBuffer(resolved)

  const parser = new FitParser({
    force: true,
    speedUnit: "km/h",
    temperatureUnit: "celsius",
    elapsedRecordField: true,
    mode: "list",
  })

  const fitData = await parser.parseAsync(buffer) as Record<string, unknown>
  const types = buildTypes(fitData)

  if (types.length === 0) {
    throw new Error(`No message data found in: ${resolved}`)
  }

  const version = `${fitData.profileVersion ?? "?"}`
  const filename = path.basename(resolved)

  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(<App types={types} filename={filename} version={version} />)
}

// ─── Standalone entry ───────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error("Usage: bun run src/tui/raw.tsx <file.fit>")
    process.exit(1)
  }
  renderRaw(filePath).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
