// @ts-nocheck — OpenTUI JSX types don't match standard React IntrinsicAttributes
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useState } from "react"
import FitParser from "fit-file-parser"
import path from "node:path"

// ─── Types ───────────────────────────────────────────────────────────────────

interface FitRecord {
  activity_type: string
  timestamp: string
  position_lat?: number
  position_long?: number
  distance: number
  heart_rate?: number
  altitude?: number
  speed?: number
  cadence?: number
  power?: number
  elapsed_time: number
  timer_time: number
  step_length?: number
  vertical_oscillation?: number
  vertical_ratio?: number
  stance_time?: number
  "Effort Pace"?: number
}

interface Lap {
  timestamp: string
  start_time: string
  total_timer_time: number
  total_elapsed_time: number
  total_distance: number
  total_calories?: number
  sport: string
  max_heart_rate?: number
  min_heart_rate?: number
  avg_heart_rate?: number
  avg_temperature?: number
  max_speed?: number
  avg_speed?: number
  avg_cadence?: number
  avg_step_length?: number
  max_cadence?: number
  total_descent?: number
  total_ascent?: number
  avg_power?: number
  avg_vertical_oscillation?: number
  avg_vertical_ratio?: number
  "Effort Pace"?: number
  records: FitRecord[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

function fmtPace(speedKmh: number): string {
  if (!speedKmh || speedKmh === 0) return "--:--"
  const paceMin = 60 / speedKmh
  const m = Math.floor(paceMin)
  const s = Math.round((paceMin - m) * 60)
  return `${m}:${s.toString().padStart(2, "0")}/km`
}

function fmtPaceMile(speedKmh: number): string {
  if (!speedKmh || speedKmh === 0) return "--:--"
  const paceMin = 60 / (speedKmh / 1.60934)
  const m = Math.floor(paceMin)
  const s = Math.round((paceMin - m) * 60)
  return `${m}:${s.toString().padStart(2, "0")}/mi`
}

function fmtDist(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)}km`
  return `${Math.round(meters)}m`
}

function fmtNum(val: number | undefined, suffix = "", dec = 0): string {
  if (val === undefined || val === null) return "—"
  return `${val.toFixed(dec)}${suffix}`
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
  hr: "#ff7b72",
  speed: "#79c0ff",
  cadence: "#7ee787",
  power: "#d2a8ff",
  alt: "#ffa657",
  dist: "#56d364",
}

// ─── Components ──────────────────────────────────────────────────────────────

function LapRow({ lap, index, selected, panelFocused }: {
  lap: Lap
  index: number
  selected: boolean
  panelFocused: boolean
}) {
  const bg = selected
    ? panelFocused ? C.selectedFocusBg : C.selectedBg
    : C.panelBg
  const fg = selected ? "#ffffff" : C.text
  const marker = selected ? "▶" : " "

  return (
    <box backgroundColor={bg} height={1} flexDirection="row" paddingLeft={1}>
      <text fg={selected ? C.accent : C.dim} width={2}>{marker}</text>
      <text fg={fg} width={3}>{index + 1}</text>
      <text fg={selected ? C.dist : C.dim} width={8}>{fmtDist(lap.total_distance)}</text>
      <text fg={fg}>{fmtDuration(lap.total_timer_time)}</text>
    </box>
  )
}

function StatPair({ label, value, fg }: { label: string; value: string; fg?: string }) {
  return (
    <box flexDirection="row" height={1} paddingX={1}>
      <text fg={C.dim} width={14}>{label}</text>
      <text fg={fg ?? C.text}>{value}</text>
    </box>
  )
}

function LapStats({ lap, index }: { lap: Lap; index: number }) {
  const date = new Date(lap.start_time).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit",
  })
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={C.border}
      title={` Lap ${index + 1}  •  ${date} `}
      backgroundColor={C.panelBg}
      paddingY={1}
      flexDirection="row"
      height={9}
    >
      <box flexDirection="column" flexGrow={1}>
        <StatPair label="Distance" value={fmtDist(lap.total_distance)} fg={C.dist} />
        <StatPair label="Duration" value={fmtDuration(lap.total_timer_time)} />
        <StatPair label="Avg Pace/km" value={fmtPace(lap.avg_speed ?? 0)} />
        <StatPair label="Avg Pace/mi" value={fmtPaceMile(lap.avg_speed ?? 0)} />
        <StatPair label="Avg Speed" value={fmtNum(lap.avg_speed, " km/h", 1)} fg={C.speed} />
      </box>
      <box flexDirection="column" flexGrow={1}>
        <StatPair label="Avg HR" value={fmtNum(lap.avg_heart_rate, " bpm")} fg={C.hr} />
        <StatPair label="Max HR" value={fmtNum(lap.max_heart_rate, " bpm")} fg={C.hr} />
        <StatPair label="Avg Cadence" value={lap.avg_cadence ? `${lap.avg_cadence * 2} spm` : "—"} fg={C.cadence} />
        <StatPair label="Avg Power" value={fmtNum(lap.avg_power, " W")} fg={C.power} />
      </box>
      <box flexDirection="column" flexGrow={1}>
        <StatPair label="Calories" value={fmtNum(lap.total_calories, " kcal")} />
        <StatPair label="Ascent" value={fmtNum(lap.total_ascent, " m")} fg={C.alt} />
        <StatPair label="Descent" value={fmtNum(lap.total_descent, " m")} />
        <StatPair label="Temp" value={fmtNum(lap.avg_temperature, "°C")} />
      </box>
    </box>
  )
}

function RecordHeader() {
  return (
    <box flexDirection="row" height={1} paddingX={2} backgroundColor={C.headerBg}>
      <text fg={C.dim} width={7}>Time</text>
      <text fg={C.dist} width={8}>Dist</text>
      <text fg={C.hr} width={6}>HR</text>
      <text fg={C.speed} width={8}>Speed</text>
      <text fg={C.cadence} width={7}>Cad</text>
      <text fg={C.power} width={7}>Pwr</text>
      <text fg={C.alt} width={6}>Alt</text>
      <text fg={C.dim} width={9}>Pace/km</text>
      <text fg={C.dim} width={9}>Pace/mi</text>
    </box>
  )
}

function RecordRow({ rec }: { rec: FitRecord }) {
  const hasSpeed = rec.speed !== undefined && rec.speed > 0
  const hasCad = rec.cadence !== undefined && rec.cadence > 0

  return (
    <box flexDirection="row" height={1} paddingX={2}>
      <text fg={C.dim} width={7}>{fmtDuration(rec.elapsed_time)}</text>
      <text fg={C.text} width={8}>{fmtDist(rec.distance)}</text>
      <text fg={rec.heart_rate ? C.hr : C.dim} width={6}>
        {rec.heart_rate ? `${rec.heart_rate}` : "—"}
      </text>
      <text fg={hasSpeed ? C.speed : C.dim} width={8}>
        {hasSpeed ? `${rec.speed!.toFixed(1)}` : "—"}
      </text>
      <text fg={hasCad ? C.cadence : C.dim} width={7}>
        {hasCad ? `${rec.cadence! * 2}` : "—"}
      </text>
      <text fg={rec.power ? C.power : C.dim} width={7}>
        {rec.power ? `${rec.power}` : "—"}
      </text>
      <text fg={rec.altitude !== undefined ? C.alt : C.dim} width={6}>
        {rec.altitude !== undefined ? `${rec.altitude}m` : "—"}
      </text>
      <text fg={hasSpeed ? C.text : C.dim} width={9}>
        {hasSpeed ? fmtPace(rec.speed!) : "—"}
      </text>
      <text fg={hasSpeed ? C.text : C.dim} width={9}>
        {hasSpeed ? fmtPaceMile(rec.speed!) : "—"}
      </text>
    </box>
  )
}

function RecordsPanel({ lap, focused }: { lap: Lap; focused: boolean }) {
  const records = lap.records ?? []
  const hint = focused ? "↑↓ scroll" : "[Tab] to focus"
  return (
    <box
      flexGrow={1}
      border
      borderStyle="rounded"
      borderColor={focused ? C.focusBorder : C.border}
      title={` ${records.length} Records  •  ${hint} `}
      backgroundColor={C.panelBg}
      flexDirection="column"
    >
      <RecordHeader />
      <scrollbox focused={focused}>
        <box flexDirection="column">
          {records.map((rec, i) => (
            <RecordRow key={i} rec={rec} />
          ))}
        </box>
      </scrollbox>
    </box>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App({ laps }: { laps: Lap[] }) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()

  const [selectedLap, setSelectedLap] = useState(0)
  const [focus, setFocus] = useState<"laps" | "records">("laps")

  const totalDist = laps.reduce((s, l) => s + l.total_distance, 0)
  const totalTime = laps.reduce((s, l) => s + l.total_timer_time, 0)
  const activityDate = new Date(laps[0]!.start_time).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  })

  useKeyboard((key) => {
    if (key.name === "q") {
      renderer.destroy()
      return
    }
    if (key.name === "tab") {
      setFocus(f => f === "laps" ? "records" : "laps")
      return
    }
    if (focus === "laps") {
      if (key.name === "up" || key.name === "k") {
        setSelectedLap(i => Math.max(0, i - 1))
      } else if (key.name === "down" || key.name === "j") {
        setSelectedLap(i => Math.min(laps.length - 1, i + 1))
      }
    }
  })

  const currentLap = laps[selectedLap]!

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
        <text fg={C.accent}><strong>FIT Viewer</strong></text>
        <text fg={C.dim}>│</text>
        <text fg={C.text}>Running</text>
        <text fg={C.dim}>│</text>
        <text fg={C.text}>{activityDate}</text>
        <text fg={C.dim}>│</text>
        <text fg={C.dist}>{fmtDist(totalDist)}</text>
        <text fg={C.dim}>in</text>
        <text fg={C.text}>{fmtDuration(totalTime)}</text>
        <text fg={C.dim}>│</text>
        <text fg={C.dim}>{laps.length} laps</text>
      </box>

      {/* Main */}
      <box flexGrow={1} flexDirection="row">

        {/* Lap list */}
        <box
          width={24}
          border
          borderStyle="rounded"
          borderColor={focus === "laps" ? C.focusBorder : C.border}
          title={` Laps `}
          backgroundColor={C.panelBg}
          flexDirection="column"
        >
          <box flexDirection="row" height={1} paddingLeft={1} backgroundColor={C.headerBg}>
            <text fg={C.dim} width={5}> #</text>
            <text fg={C.dist} width={8}>Dist</text>
            <text fg={C.dim}>Time</text>
          </box>
          <scrollbox focused={focus === "laps"}>
            <box flexDirection="column">
              {laps.map((lap, i) => (
                <LapRow
                  key={i}
                  lap={lap}
                  index={i}
                  selected={i === selectedLap}
                  panelFocused={focus === "laps"}
                />
              ))}
            </box>
          </scrollbox>
        </box>

        {/* Right: stats + records */}
        <box flexGrow={1} flexDirection="column">
          <LapStats lap={currentLap} index={selectedLap} />
          <RecordsPanel lap={currentLap} focused={focus === "records"} />
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
        <text fg={C.dim}>Navigate laps</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[Tab]</text>
        <text fg={C.dim}>Switch panel</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[↑↓]</text>
        <text fg={C.dim}>Scroll records</text>
        <text fg={C.dim}>  </text>
        <text fg={C.accent}>[q]</text>
        <text fg={C.dim}>Quit</text>
      </box>

    </box>
  )
}

// ─── Render entry point ─────────────────────────────────────────────────────

export async function renderViewer(filePath: string): Promise<void> {
  const resolved = path.resolve(process.cwd(), filePath)
  const buffer = await Bun.file(resolved).arrayBuffer()

  const parser = new FitParser({
    force: true,
    speedUnit: "km/h",
    temperatureUnit: "celsius",
    elapsedRecordField: true,
    mode: "cascade",
  })

  const fitData = await parser.parseAsync(Buffer.from(buffer))
  const sessions = fitData.activity?.sessions ?? []
  const laps: Lap[] = (sessions.flatMap((s: any) => s.laps ?? [])) as Lap[]

  if (laps.length === 0) {
    throw new Error(`No lap data found in: ${resolved}`)
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(<App laps={laps} />)
}

// ─── Standalone entry ───────────────────────────────────────────────────────

if (import.meta.main) {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error("Usage: bun run src/tui/viewer.tsx <file.fit>")
    process.exit(1)
  }
  renderViewer(filePath).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
