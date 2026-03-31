// @ts-nocheck — OpenTUI JSX types don't match standard React IntrinsicAttributes
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useState } from "react"
import path from "node:path"

// ─── Types ───────────────────────────────────────────────────────────────────

interface FieldDef {
  number: number
  size: number
  baseTypeId: number
  typeName: string
  name: string
}

interface DevFieldDef {
  number: number
  size: number
  devDataIndex: number
}

interface ExampleField {
  fieldNumber: number
  rawBytes: number[]
  rawValue: number | string
  name: string
  typeName: string
}

interface Definition {
  localMsgNum: number
  globalMsgNum: number
  globalMsgName: string
  isLittleEndian: boolean
  fields: FieldDef[]
  devFields: DevFieldDef[]
  dataCount: number
  compressedCount: number
  exampleFields: ExampleField[] | null
  definedAt: number
}

interface FileHeader {
  headerSize: number
  protocolVersion: string
  profileVersion: string
  dataSize: number
  signature: string
  hasCrc: boolean
}

// ─── FIT Protocol Constants ───────────────────────────────────────────────────

const BASE_TYPES: Record<number, { name: string; size: number }> = {
  0x00: { name: "enum",    size: 1 },
  0x01: { name: "sint8",   size: 1 },
  0x02: { name: "uint8",   size: 1 },
  0x83: { name: "sint16",  size: 2 },
  0x84: { name: "uint16",  size: 2 },
  0x85: { name: "sint32",  size: 4 },
  0x86: { name: "uint32",  size: 4 },
  0x07: { name: "string",  size: 1 },
  0x88: { name: "float32", size: 4 },
  0x89: { name: "float64", size: 8 },
  0x0A: { name: "uint8z",  size: 1 },
  0x8B: { name: "uint16z", size: 2 },
  0x8C: { name: "uint32z", size: 4 },
  0x0D: { name: "byte",    size: 1 },
  0x8E: { name: "sint64",  size: 8 },
  0x8F: { name: "uint64",  size: 8 },
  0x90: { name: "uint64z", size: 8 },
}

const GLOBAL_MSGS: Record<number, string> = {
  0:   "file_id",
  1:   "capabilities",
  2:   "device_settings",
  3:   "user_profile",
  6:   "bike_profile",
  12:  "sport",
  18:  "session",
  19:  "lap",
  20:  "record",
  21:  "event",
  23:  "device_info",
  34:  "activity",
  49:  "file_creator",
  101: "length",
  206: "developer_data_id",
  207: "field_description",
  227: "stress_level",
  258: "aod_profile",
  259: "jump",
  264: "split",
  268: "split_summary",
  285: "climb_pro",
}

const FIELD_NAMES: Record<number, Record<number, string>> = {
  0: {
    0: "type", 1: "manufacturer", 2: "product", 3: "serial_number",
    4: "time_created", 5: "number", 8: "product_name",
  },
  18: {
    253: "timestamp", 2: "start_time", 7: "total_elapsed_time",
    8: "total_timer_time", 9: "total_distance", 11: "total_calories",
    14: "avg_speed", 15: "max_speed", 16: "avg_heart_rate",
    17: "max_heart_rate", 18: "avg_cadence", 19: "max_cadence",
    20: "avg_power", 21: "max_power", 22: "total_ascent",
    23: "total_descent", 25: "sport", 29: "first_lap_index",
    30: "num_laps",
  },
  19: {
    253: "timestamp", 0: "start_time", 7: "total_elapsed_time",
    8: "total_timer_time", 9: "total_distance", 11: "total_calories",
    13: "avg_speed", 14: "max_speed", 15: "avg_heart_rate",
    16: "max_heart_rate", 17: "avg_cadence", 18: "max_cadence",
    19: "avg_power", 20: "max_power", 21: "total_ascent",
    22: "total_descent", 23: "sport",
  },
  20: {
    253: "timestamp", 0: "position_lat", 1: "position_long",
    2: "altitude", 3: "heart_rate", 4: "cadence", 5: "distance",
    6: "speed", 7: "power", 13: "temperature", 29: "accumulated_power",
    39: "vertical_oscillation", 40: "stance_time_percent",
    41: "stance_time", 42: "activity_type", 63: "fractional_cadence",
    78: "enhanced_altitude", 81: "device_index", 82: "left_pco",
    87: "right_power_phase_peak", 91: "enhanced_speed",
  },
  21: {
    253: "timestamp", 0: "event", 1: "event_type", 3: "data",
    4: "event_group",
  },
  23: {
    253: "timestamp", 0: "device_index", 1: "device_type",
    2: "manufacturer", 3: "serial_number", 4: "product",
    5: "software_version", 6: "hardware_version", 10: "battery_voltage",
    11: "battery_status",
  },
  34: {
    253: "timestamp", 0: "total_timer_time", 1: "num_sessions",
    2: "type", 3: "event", 4: "event_type", 5: "local_timestamp",
  },
}

// ─── Parser ──────────────────────────────────────────────────────────────────

function readValue(view: DataView, offset: number, baseTypeId: number, size: number, isLE: boolean): number | string {
  switch (baseTypeId) {
    case 0x00: case 0x02: case 0x0A: return view.getUint8(offset)
    case 0x01: return view.getInt8(offset)
    case 0x84: return view.getUint16(offset, isLE)
    case 0x83: return view.getInt16(offset, isLE)
    case 0x86: case 0x8C: return view.getUint32(offset, isLE)
    case 0x85: return view.getInt32(offset, isLE)
    case 0x88: return view.getFloat32(offset, isLE)
    case 0x89: return view.getFloat64(offset, isLE)
    case 0x07: {
      const chars: string[] = []
      for (let i = 0; i < size; i++) {
        const c = view.getUint8(offset + i)
        if (c === 0) break
        chars.push(String.fromCharCode(c))
      }
      return chars.join("")
    }
    default: return view.getUint8(offset)
  }
}

function parseFitProtocol(buffer: ArrayBuffer): {
  header: FileHeader
  definitions: Definition[]
} {
  const view = new DataView(buffer)
  const headerSize = view.getUint8(0)
  const protocolRaw = view.getUint8(1)
  const profileRaw = view.getUint16(2, true)
  const dataSize = view.getUint32(4, true)
  const sig = String.fromCharCode(
    view.getUint8(8), view.getUint8(9),
    view.getUint8(10), view.getUint8(11)
  )

  const header: FileHeader = {
    headerSize,
    protocolVersion: `${protocolRaw >> 4}.${protocolRaw & 0x0F}`,
    profileVersion: `${Math.floor(profileRaw / 100)}.${(profileRaw % 100).toString().padStart(2, "0")}`,
    dataSize,
    signature: sig,
    hasCrc: headerSize >= 14,
  }

  const activeDefinitions = new Map<number, Definition>()
  const definitionList: Definition[] = []

  let offset = headerSize
  const end = headerSize + dataSize

  while (offset < end) {
    if (offset >= buffer.byteLength) break
    const recordHeader = view.getUint8(offset++)

    // Compressed timestamp header (bit 7 = 1)
    if (recordHeader & 0x80) {
      const localMsgNum = (recordHeader >> 5) & 0x03
      const def = activeDefinitions.get(localMsgNum)
      if (def) {
        def.compressedCount++
        def.dataCount++
        const devSize = def.devFields.reduce((s, f) => s + f.size, 0)
        const totalSize = def.fields.reduce((s, f) => s + f.size, 0) + devSize
        const hasTimestamp = def.fields.some(f => f.number === 253)
        offset += hasTimestamp ? totalSize - 4 : totalSize
      }
      continue
    }

    const isDefinition = !!(recordHeader & 0x40)
    const isDeveloperData = !!(recordHeader & 0x20)
    const localMsgNum = recordHeader & 0x0F

    if (isDefinition) {
      offset++ // reserved
      const arch = view.getUint8(offset++)
      const isLE = arch === 0
      const globalMsgNum = isLE
        ? view.getUint16(offset, true)
        : view.getUint16(offset, false)
      offset += 2
      const fieldCount = view.getUint8(offset++)

      const fields: FieldDef[] = []
      for (let i = 0; i < fieldCount; i++) {
        const num = view.getUint8(offset++)
        const size = view.getUint8(offset++)
        const baseTypeId = view.getUint8(offset++)
        const typeName = BASE_TYPES[baseTypeId]?.name ?? `0x${baseTypeId.toString(16).padStart(2, "0")}`
        const name = FIELD_NAMES[globalMsgNum]?.[num] ?? `field_${num}`
        fields.push({ number: num, size, baseTypeId, typeName, name })
      }

      const devFields: DevFieldDef[] = []
      if (isDeveloperData) {
        const devFieldCount = view.getUint8(offset++)
        for (let i = 0; i < devFieldCount; i++) {
          const num = view.getUint8(offset++)
          const size = view.getUint8(offset++)
          const devIdx = view.getUint8(offset++)
          devFields.push({ number: num, size, devDataIndex: devIdx })
        }
      }

      const existing = activeDefinitions.get(localMsgNum)
      const def: Definition = {
        localMsgNum,
        globalMsgNum,
        globalMsgName: GLOBAL_MSGS[globalMsgNum] ?? `msg_${globalMsgNum}`,
        isLittleEndian: isLE,
        fields,
        devFields,
        dataCount: existing?.dataCount ?? 0,
        compressedCount: existing?.compressedCount ?? 0,
        exampleFields: existing?.exampleFields ?? null,
        definedAt: offset,
      }
      activeDefinitions.set(localMsgNum, def)
      if (!existing) {
        definitionList.push(def)
      } else {
        // Replace stale reference so the list tracks the current definition
        const idx = definitionList.findIndex(d => d === existing)
        if (idx >= 0) definitionList[idx] = def
      }
    } else {
      // Data message
      const def = activeDefinitions.get(localMsgNum)
      if (!def) break

      def.dataCount++

      if (!def.exampleFields) {
        const exampleFields: ExampleField[] = []
        for (const field of def.fields) {
          const rawBytes: number[] = []
          for (let i = 0; i < field.size; i++) {
            rawBytes.push(view.getUint8(offset + i))
          }
          const rawValue = readValue(view, offset, field.baseTypeId, field.size, def.isLittleEndian)
          exampleFields.push({
            fieldNumber: field.number,
            rawBytes,
            rawValue,
            name: field.name,
            typeName: field.typeName,
          })
          offset += field.size
        }
        for (const df of def.devFields) offset += df.size
        def.exampleFields = exampleFields
      } else {
        const totalSize = def.fields.reduce((s, f) => s + f.size, 0)
          + def.devFields.reduce((s, f) => s + f.size, 0)
        offset += totalSize
      }
    }
  }

  return { header, definitions: definitionList.sort((a, b) => b.dataCount - a.dataCount) }
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
  // Protocol-specific colors
  defColor: "#ffa657",     // definition message rows
  typeColor: "#d2a8ff",    // type names (uint32, sint32 etc)
  rawColor: "#79c0ff",     // raw byte values
  hexColor: "#58a6ff",     // hex representation
  fieldNumColor: "#8b949e", // dim field numbers
  count: "#7ee787",        // data count
  globalNum: "#e6edf3",    // global message number
  archColor: "#56d364",    // architecture indicator
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtHex(id: number): string {
  return `0x${id.toString(16).padStart(2, "0").toUpperCase()}`
}

function fmtBytes(bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 1) + "…" : str
}

// ─── Components ──────────────────────────────────────────────────────────────

function DefRow({ def, index, selected, panelFocused }: {
  def: Definition
  index: number
  selected: boolean
  panelFocused: boolean
}) {
  const bg = selected
    ? panelFocused ? C.selectedFocusBg : C.selectedBg
    : C.panelBg
  const marker = selected ? "▶" : " "
  const label = truncate(def.globalMsgName, 14)

  return (
    <box backgroundColor={bg} height={1} flexDirection="row" paddingLeft={1}>
      <text fg={selected ? C.accent : C.dim} width={2}>{marker}</text>
      <text fg={selected ? C.defColor : C.dim} width={16}>{label}</text>
      <text fg={C.fieldNumColor} width={5}>[{def.globalMsgNum}]</text>
      <text fg={C.count}>{def.dataCount}</text>
    </box>
  )
}

function DefinitionFieldRow({ field, index }: { field: FieldDef; index: number }) {
  const nameStr = truncate(field.name, 20)
  const typeStr = truncate(field.typeName, 10)
  const hexStr = fmtHex(field.baseTypeId)

  return (
    <box flexDirection="row" height={1} paddingLeft={2}>
      <text fg={C.fieldNumColor} width={4}>{index + 1}</text>
      <text fg={C.text} width={22}>{nameStr}</text>
      <text fg={C.typeColor} width={11}>{typeStr}</text>
      <text fg={C.dim} width={6}>{field.size}</text>
      <text fg={C.hexColor}>{hexStr}</text>
    </box>
  )
}

function ExampleFieldRow({ ef }: { ef: ExampleField }) {
  const nameStr = truncate(ef.name, 20)
  const bytesStr = truncate(fmtBytes(ef.rawBytes), 20)
  const valStr = String(ef.rawValue)

  return (
    <box flexDirection="row" height={1} paddingLeft={2}>
      <text fg={C.text} width={22}>{nameStr}</text>
      <text fg={C.rawColor} width={22}>{bytesStr}</text>
      <text fg={C.globalNum}>{valStr}</text>
    </box>
  )
}

function DefinitionPanel({ def, focused }: { def: Definition; focused: boolean }) {
  const archLabel = def.isLittleEndian ? "LE" : "BE"
  const hint = focused ? "↑↓ scroll" : "[Tab] to focus"

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={C.border}
      title={` Definition: ${def.globalMsgName} `}
      backgroundColor={C.panelBg}
      height={14}
    >
      {/* Metadata row */}
      <box flexDirection="row" height={1} paddingX={2} paddingTop={1}>
        <text fg={C.dim}>Global: </text>
        <text fg={C.defColor} width={8}>{def.globalMsgNum}</text>
        <text fg={C.dim}>Local: </text>
        <text fg={C.text} width={6}>#{def.localMsgNum}</text>
        <text fg={C.dim}>Arch: </text>
        <text fg={C.archColor} width={6}>{archLabel}</text>
        <text fg={C.dim}>Data msgs: </text>
        <text fg={C.count} width={8}>{def.dataCount}</text>
        <text fg={C.dim}>Fields: </text>
        <text fg={C.text}>{def.fields.length}</text>
        {def.devFields.length > 0 && (
          <>
            <text fg={C.dim}>  Dev fields: </text>
            <text fg={C.typeColor}>{def.devFields.length}</text>
          </>
        )}
      </box>

      {/* Field list header */}
      <box flexDirection="row" height={1} paddingLeft={2} paddingTop={1} backgroundColor={C.headerBg}>
        <text fg={C.fieldNumColor} width={4}>#</text>
        <text fg={C.dim} width={22}>field</text>
        <text fg={C.typeColor} width={11}>type</text>
        <text fg={C.dim} width={6}>size</text>
        <text fg={C.hexColor}>byte</text>
      </box>

      {/* Field definitions — scrollbox not needed for small counts but use one anyway */}
      <scrollbox focused={false}>
        <box flexDirection="column" paddingBottom={1}>
          {def.fields.map((f, i) => (
            <DefinitionFieldRow key={i} field={f} index={i} />
          ))}
        </box>
      </scrollbox>
    </box>
  )
}

function ExamplePanel({ def, focused }: { def: Definition; focused: boolean }) {
  const hint = focused ? "↑↓ scroll" : "[Tab] to focus"

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={focused ? C.focusBorder : C.border}
      title={` Example Data Message  •  ${hint} `}
      backgroundColor={C.panelBg}
    >
      <box flexDirection="row" height={1} paddingX={2} backgroundColor={C.headerBg}>
        <text fg={C.dim} width={22}>field</text>
        <text fg={C.rawColor} width={22}>raw bytes</text>
        <text fg={C.globalNum}>raw value</text>
      </box>

      <scrollbox focused={focused}>
        <box flexDirection="column">
          {def.exampleFields === null ? (
            <box paddingLeft={2} paddingTop={1}>
              <text fg={C.dim}>No data messages yet</text>
            </box>
          ) : (
            <>
              <box paddingLeft={2} paddingTop={1} paddingBottom={1}>
                <text fg={C.dim}>First occurrence of this definition type</text>
              </box>
              {def.exampleFields.map((ef, i) => (
                <ExampleFieldRow key={i} ef={ef} />
              ))}
            </>
          )}
        </box>
      </scrollbox>
    </box>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App({ header, definitions, filename }: {
  header: FileHeader
  definitions: Definition[]
  filename: string
}) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [selected, setSelected] = useState(0)
  const [focus, setFocus] = useState<"defs" | "detail">("defs")

  useKeyboard((key) => {
    if (key.name === "q") {
      renderer.destroy()
      return
    }
    if (key.name === "tab") {
      setFocus(f => f === "defs" ? "detail" : "defs")
      return
    }
    if (focus === "defs") {
      if (key.name === "up" || key.name === "k")
        setSelected(i => Math.max(0, i - 1))
      if (key.name === "down" || key.name === "j")
        setSelected(i => Math.min(definitions.length - 1, i + 1))
    }
  })

  const current = definitions[selected]!

  const dataSizeKb = (header.dataSize / 1024).toFixed(1)

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={C.bg}>

      {/* Header bar */}
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
        <text fg={C.accent}><strong>FIT Protocol Explorer</strong></text>
        <text fg={C.dim}>│</text>
        <text fg={C.text}>{filename}</text>
        <text fg={C.dim}>│</text>
        <text fg={C.dim}>protocol v{header.protocolVersion}</text>
        <text fg={C.dim}>│</text>
        <text fg={C.dim}>profile v{header.profileVersion}</text>
        <text fg={C.dim}>│</text>
        <text fg={C.dim}>{dataSizeKb} KB</text>
        <text fg={C.dim}>│</text>
        <text fg={C.count}>{definitions.length} definitions</text>
        {header.hasCrc && (
          <>
            <text fg={C.dim}>│</text>
            <text fg={C.archColor}>CRC</text>
          </>
        )}
      </box>

      {/* Main layout */}
      <box flexGrow={1} flexDirection="row">

        {/* Left panel: definition list */}
        <box
          width={30}
          border
          borderStyle="rounded"
          borderColor={focus === "defs" ? C.focusBorder : C.border}
          title={` Definitions `}
          backgroundColor={C.panelBg}
          flexDirection="column"
        >
          <box flexDirection="row" height={1} paddingLeft={1} backgroundColor={C.headerBg}>
            <text fg={C.dim} width={18}>name</text>
            <text fg={C.fieldNumColor} width={6}>num</text>
            <text fg={C.count}>msgs</text>
          </box>
          <scrollbox focused={focus === "defs"}>
            <box flexDirection="column">
              {definitions.map((def, i) => (
                <DefRow
                  key={i}
                  def={def}
                  index={i}
                  selected={i === selected}
                  panelFocused={focus === "defs"}
                />
              ))}
            </box>
          </scrollbox>
        </box>

        {/* Right panel: definition detail + example data */}
        <box flexGrow={1} flexDirection="column">
          <DefinitionPanel def={current} focused={false} />
          <ExamplePanel def={current} focused={focus === "detail"} />
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
        <text fg={C.dim}>Navigate defs</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[Tab]</text>
        <text fg={C.dim}>Switch panel</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[↑↓]</text>
        <text fg={C.dim}>Scroll</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[q]</text>
        <text fg={C.dim}>Quit</text>
      </box>

    </box>
  )
}

// ─── Render entry point ─────────────────────────────────────────────────────

export async function renderProtocol(filePath: string): Promise<void> {
  const resolved = path.resolve(process.cwd(), filePath)
  const buffer = await Bun.file(resolved).arrayBuffer()

  const { header, definitions } = parseFitProtocol(buffer)

  if (definitions.length === 0) {
    throw new Error(`No definition messages found in: ${resolved}`)
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(
    <App header={header} definitions={definitions} filename={path.basename(resolved)} />
  )
}

// ─── Standalone entry ───────────────────────────────────────────────────────

if (import.meta.main) {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error("Usage: bun run src/tui/protocol.tsx <file.fit>")
    process.exit(1)
  }
  renderProtocol(filePath).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
