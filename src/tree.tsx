import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useState, useMemo } from "react"
import FitParser from "fit-file-parser"
import path from "node:path"

// ─── Types ───────────────────────────────────────────────────────────────────

interface TreeNode {
  id: string
  label: string
  value?: string
  depth: number
  expandable: boolean
  expanded: boolean
  isLastSibling: boolean
  ancestorHasMore: boolean[]
  dataType: "array" | "object" | "string" | "number" | "boolean" | "null"
  childCount?: number
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
  // data type colors
  string: "#7ee787",
  number: "#79c0ff",
  boolean: "#d2a8ff",
  null: "#8b949e",
  array: "#ffa657",
  object: "#58a6ff",
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtLeaf(val: unknown): string {
  if (val === null || val === undefined) return "null"
  if (typeof val === "boolean") return String(val)
  if (typeof val === "number") return String(val)
  if (typeof val === "string") {
    const s = JSON.stringify(val)
    return s.length > 50 ? s.slice(0, 47) + '\u2026"' : s
  }
  return String(val)
}

function getDataType(val: unknown): TreeNode["dataType"] {
  if (val === null || val === undefined) return "null"
  if (Array.isArray(val)) return "array"
  if (typeof val === "object") return "object"
  return typeof val as "string" | "number" | "boolean"
}

function typeColor(dt: TreeNode["dataType"]): string {
  switch (dt) {
    case "string":  return C.string
    case "number":  return C.number
    case "boolean": return C.boolean
    case "null":    return C.null
    case "array":   return C.array
    case "object":  return C.object
  }
}

function childCount(val: unknown): number {
  if (Array.isArray(val)) return val.length
  if (val !== null && typeof val === "object") return Object.keys(val as object).length
  return 0
}

// ─── Tree building ────────────────────────────────────────────────────────────

function buildVisibleNodes(
  data: unknown,
  label: string,
  depth: number,
  isLast: boolean,
  ancestorHasMore: boolean[],
  idPrefix: string,
  nodes: TreeNode[],
  expandedIds: Set<string>
): void {
  const dt = getDataType(data)
  const isExpandable = dt === "array" || dt === "object"
  const id = idPrefix
  const expanded = isExpandable && expandedIds.has(id)
  const count = isExpandable ? childCount(data) : undefined

  const node: TreeNode = {
    id,
    label,
    depth,
    expandable: isExpandable,
    expanded,
    isLastSibling: isLast,
    ancestorHasMore: ancestorHasMore.slice(),
    dataType: dt,
    childCount: count,
    value: isExpandable ? undefined : fmtLeaf(data),
  }
  nodes.push(node)

  if (!expanded) return

  // Recurse into children
  if (Array.isArray(data)) {
    const entries = data
    const lastIdx = entries.length - 1
    // For ancestors, propagate whether this node still has siblings after it
    const nextAncestorHasMore = [...ancestorHasMore, !isLast]
    entries.forEach((item, i) => {
      buildVisibleNodes(
        item,
        `item #${i}`,
        depth + 1,
        i === lastIdx,
        nextAncestorHasMore,
        `${id}[${i}]`,
        nodes,
        expandedIds
      )
    })
  } else if (data !== null && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>)
    const lastIdx = entries.length - 1
    const nextAncestorHasMore = [...ancestorHasMore, !isLast]
    entries.forEach(([key, val], i) => {
      buildVisibleNodes(
        val,
        key,
        depth + 1,
        i === lastIdx,
        nextAncestorHasMore,
        `${id}.${key}`,
        nodes,
        expandedIds
      )
    })
  }
}

function buildAllNodes(
  fitData: Record<string, unknown>,
  expandedIds: Set<string>
): TreeNode[] {
  const nodes: TreeNode[] = []
  const entries = Object.entries(fitData)
  const lastIdx = entries.length - 1
  entries.forEach(([key, val], i) => {
    buildVisibleNodes(
      val,
      key,
      0,
      i === lastIdx,
      [],
      key,
      nodes,
      expandedIds
    )
  })
  return nodes
}

// ─── Initial expand state ─────────────────────────────────────────────────────

function buildInitialExpandedIds(fitData: Record<string, unknown>): Set<string> {
  const ids = new Set<string>()

  for (const [key, val] of Object.entries(fitData)) {
    if (val === null || val === undefined) continue
    const dt = getDataType(val)
    if (dt !== "array" && dt !== "object") continue

    // Auto-expand all top-level keys
    ids.add(key)

    // For arrays with <= 5 items, expand each element one level
    if (dt === "array" && Array.isArray(val) && val.length <= 5) {
      val.forEach((_item, i) => {
        ids.add(`${key}[${i}]`)
      })
    }

    // For the activity object, expand one more level (so sessions is visible)
    if (key === "activity" && dt === "object" && val !== null && typeof val === "object") {
      for (const [childKey, childVal] of Object.entries(val as Record<string, unknown>)) {
        if (childVal === null || childVal === undefined) continue
        const childDt = getDataType(childVal)
        if (childDt !== "array" && childDt !== "object") continue
        // Expand child if it's a small array or object
        if (childDt === "array" && Array.isArray(childVal) && childVal.length <= 5) {
          ids.add(`activity.${childKey}`)
        } else if (childDt === "object") {
          ids.add(`activity.${childKey}`)
        }
      }
    }
  }

  return ids
}

// ─── Find parent id ───────────────────────────────────────────────────────────

function findParentId(nodeId: string): string | null {
  // Strip last segment: "a.b.c" -> "a.b", "a.b[2]" -> "a.b", "a[2]" -> "a"
  const dotIdx = nodeId.lastIndexOf(".")
  const bracketIdx = nodeId.lastIndexOf("[")

  if (dotIdx === -1 && bracketIdx === -1) return null

  if (dotIdx > bracketIdx) {
    return nodeId.slice(0, dotIdx)
  }
  return nodeId.slice(0, bracketIdx)
}

// ─── NodeRow component ────────────────────────────────────────────────────────

function NodeRow({ node, selected }: { node: TreeNode; selected: boolean }) {
  const bg = selected ? C.selectedFocusBg : C.panelBg
  const labelFg = selected ? "#ffffff" : C.text

  // Build indent string
  let indent = ""
  for (let i = 0; i < node.depth; i++) {
    if (node.ancestorHasMore[i]) {
      indent += "\u2502  "  // │  (3 chars)
    } else {
      indent += "   "        // 3 spaces
    }
  }

  // Connector
  const connector = node.isLastSibling ? "\u2514\u2500 " : "\u251c\u2500 "  // └─  or ├─

  // Expand marker
  let marker = "  "
  if (node.expandable) {
    marker = node.expanded ? "\u25bc " : "\u25b6 "  // ▼ or ▶
  }

  // Count / value suffix
  let countOrValue: string | null = null
  let countFg = C.dim
  if (node.expandable && node.childCount !== undefined) {
    countOrValue = `[${node.childCount}]`
    countFg = typeColor(node.dataType)
  } else if (!node.expandable && node.value !== undefined) {
    countOrValue = node.value
    countFg = typeColor(node.dataType)
  }

  return (
    <box backgroundColor={bg} height={1} flexDirection="row">
      <text fg={C.dim}>{indent}{connector}</text>
      <text fg={selected ? C.accent : C.dim}>{marker}</text>
      <text fg={labelFg}>{node.label}</text>
      {countOrValue !== null ? (
        <>
          <text fg={C.dim}>{" "}</text>
          <text fg={countFg}>{countOrValue}</text>
        </>
      ) : null}
    </box>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App({ fitData, filename }: {
  fitData: Record<string, unknown>
  filename: string
}) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()

  const initialIds = useMemo(() => buildInitialExpandedIds(fitData), [fitData])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(initialIds)
  const [cursor, setCursor] = useState(0)

  const visibleNodes = useMemo(
    () => buildAllNodes(fitData, expandedIds),
    [fitData, expandedIds]
  )

  const totalTypes = Object.keys(fitData).length

  // Clamp cursor whenever nodes change
  const clampedCursor = Math.min(cursor, Math.max(0, visibleNodes.length - 1))

  useKeyboard((key) => {
    const current = visibleNodes[clampedCursor]

    if (key.name === "q") {
      renderer.destroy()
      return
    }

    if (key.name === "up" || key.name === "k") {
      setCursor(c => Math.max(0, c - 1))
      return
    }

    if (key.name === "down" || key.name === "j") {
      setCursor(c => Math.min(visibleNodes.length - 1, c + 1))
      return
    }

    if (key.name === "pageup") {
      setCursor(c => Math.max(0, c - 10))
      return
    }

    if (key.name === "pagedown") {
      setCursor(c => Math.min(visibleNodes.length - 1, c + 10))
      return
    }

    if (!current) return

    if (key.name === "right" || key.name === "l") {
      if (current.expandable && !current.expanded) {
        setExpandedIds(prev => new Set([...prev, current.id]))
      }
      return
    }

    if (key.name === "left" || key.name === "h") {
      if (current.expandable && current.expanded) {
        // Collapse this node
        setExpandedIds(prev => {
          const next = new Set(prev)
          next.delete(current.id)
          return next
        })
      } else {
        // Collapse parent
        const parentId = findParentId(current.id)
        if (parentId !== null) {
          setExpandedIds(prev => {
            const next = new Set(prev)
            next.delete(parentId)
            return next
          })
          // Move cursor to the parent node
          const parentIdx = visibleNodes.findIndex(n => n.id === parentId)
          if (parentIdx !== -1) {
            setCursor(parentIdx)
          }
        }
      }
      return
    }

    if (key.name === "return") {
      if (current.expandable) {
        setExpandedIds(prev => {
          const next = new Set(prev)
          if (next.has(current.id)) {
            next.delete(current.id)
          } else {
            next.add(current.id)
          }
          return next
        })
      }
      return
    }
  })

  // Virtual scrolling: keep cursor in view, centered when possible
  // Layout: header(3) + panel-border-top(1) + content + panel-border-bottom(1) + footer(1)
  const visibleRows = Math.max(1, height - 6)
  const scrollOffset = Math.max(
    0,
    Math.min(
      clampedCursor - Math.floor(visibleRows / 2),
      Math.max(0, visibleNodes.length - visibleRows)
    )
  )
  const displayedNodes = visibleNodes.slice(scrollOffset, scrollOffset + visibleRows)

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
        <text fg={C.accent}><strong>FIT Tree Explorer</strong></text>
        <text fg={C.dim}>│</text>
        <text fg={C.text}>{filename}</text>
        <text fg={C.dim}>│</text>
        <text fg={C.dim}>v1.0</text>
        <text fg={C.dim}>│</text>
        <text fg={C.array}>{totalTypes} types</text>
        <text fg={C.dim}>│</text>
        <text fg={C.dim}>{clampedCursor + 1}/{visibleNodes.length} nodes</text>
      </box>

      {/* Main tree panel */}
      <box
        flexGrow={1}
        border
        borderStyle="rounded"
        borderColor={C.focusBorder}
        title={" FIT Structure "}
        backgroundColor={C.panelBg}
        flexDirection="column"
      >
        <box flexDirection="column">
          {displayedNodes.map((node, i) => (
            <NodeRow key={node.id} node={node} selected={scrollOffset + i === clampedCursor} />
          ))}
        </box>
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
        <text fg={C.dim}>Navigate</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[←/→]</text>
        <text fg={C.dim}>Collapse/Expand</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[Enter]</text>
        <text fg={C.dim}>Toggle</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[PgUp/PgDn]</text>
        <text fg={C.dim}>Jump 10</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[q]</text>
        <text fg={C.dim}>Quit</text>
      </box>

    </box>
  )
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const filePath = process.argv[2]
if (!filePath) {
  console.error("Usage: bun run src/tree.tsx <file.fit>")
  process.exit(1)
}

const resolved = path.resolve(process.cwd(), filePath)
const buffer = await Bun.file(resolved).arrayBuffer()

const parser = new FitParser({
  force: true,
  speedUnit: "km/h",
  temperatureUnit: "celsius",
  elapsedRecordField: true,
  mode: "cascade",
})

const fitData = await parser.parseAsync(Buffer.from(buffer)) as Record<string, unknown>

const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App fitData={fitData} filename={path.basename(resolved)} />)
