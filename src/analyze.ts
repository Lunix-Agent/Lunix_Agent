/**
 * analyze.ts — FIT file structured analysis CLI
 * Usage: bun run src/analyze.ts <file.fit> [--pretty]
 *
 * Outputs JSON to stdout. Pipe to jq for slicing:
 *   bun run src/analyze.ts file.fit | jq '.laps[] | {distance, avgPace, avgHR}'
 */

import FitParser from "fit-file-parser"
import path from "node:path"

// ─── Types ───────────────────────────────────────────────────────────────────

interface FitRecord {
  timestamp: Date | string
  position_lat?: number
  position_long?: number
  distance?: number
  heart_rate?: number
  altitude?: number
  speed?: number
  cadence?: number
  power?: number
  elapsed_time?: number
  timer_time?: number
  step_length?: number
  vertical_oscillation?: number
  vertical_ratio?: number
  stance_time?: number
  "Effort Pace"?: number
  [key: string]: unknown
}

interface FitLap {
  timestamp: Date | string
  start_time: Date | string
  total_timer_time?: number
  total_elapsed_time?: number
  total_distance?: number
  total_calories?: number
  sport?: string
  max_heart_rate?: number
  min_heart_rate?: number
  avg_heart_rate?: number
  avg_temperature?: number
  max_speed?: number
  avg_speed?: number
  avg_cadence?: number
  max_cadence?: number
  total_descent?: number
  total_ascent?: number
  avg_power?: number
  max_power?: number
  normalized_power?: number
  avg_vertical_oscillation?: number
  avg_vertical_ratio?: number
  avg_stance_time?: number
  avg_step_length?: number
  "Effort Pace"?: number
  records?: FitRecord[]
  [key: string]: unknown
}

interface FitSession {
  timestamp: Date | string
  start_time: Date | string
  sport?: string
  sub_sport?: string
  total_timer_time?: number
  total_elapsed_time?: number
  total_distance?: number
  total_calories?: number
  total_ascent?: number
  total_descent?: number
  max_heart_rate?: number
  min_heart_rate?: number
  avg_heart_rate?: number
  max_speed?: number
  avg_speed?: number
  avg_cadence?: number
  max_cadence?: number
  avg_power?: number
  max_power?: number
  normalized_power?: number
  training_stress_score?: number
  intensity_factor?: number
  avg_vertical_oscillation?: number
  avg_vertical_ratio?: number
  avg_stance_time?: number
  avg_step_length?: number
  total_training_effect?: number
  total_anaerobic_training_effect?: number
  laps?: FitLap[]
  [key: string]: unknown
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPace(speedKmh: number): string {
  if (!speedKmh || speedKmh <= 0) return "--:--"
  const minPerKm = 60 / speedKmh
  const m = Math.floor(minPerKm)
  const s = Math.round((minPerKm - m) * 60)
  return `${m}:${s.toString().padStart(2, "0")} /km`
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
  return `${m}:${s.toString().padStart(2, "0")}`
}

function stats(values: number[]): { min: number; max: number; avg: number; count: number } | null {
  const valid = values.filter(v => v != null && !isNaN(v) && v > 0)
  if (valid.length === 0) return null
  return {
    min: Math.min(...valid),
    max: Math.max(...valid),
    avg: Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10,
    count: valid.length,
  }
}

function speedToKmh(ms: number): number {
  return Math.round(ms * 3.6 * 10) / 10
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const filePath = process.argv[2]
const pretty = process.argv.includes("--pretty")

if (!filePath) {
  console.error("Usage: bun run src/analyze.ts <file.fit> [--pretty]")
  process.exit(1)
}

const buffer = await Bun.file(filePath).arrayBuffer()
const bytes = new Uint8Array(buffer)

const parser = new FitParser({ mode: "cascade", speedUnit: "km/h", lengthUnit: "m" })

parser.parse(Buffer.from(bytes), (err: Error | null, data: { activity?: { sessions?: FitSession[] } }) => {
  if (err) {
    console.error("Parse error:", err.message)
    process.exit(1)
  }

  const session: FitSession = data?.activity?.sessions?.[0] ?? {}
  const laps: FitLap[] = session.laps ?? []

  // ─── Flatten all records from all laps ───────────────────────────────────
  const allRecords: FitRecord[] = laps.flatMap(l => l.records ?? [])

  // ─── Per-record field arrays for global stats ─────────────────────────────
  const hrValues = allRecords.map(r => r.heart_rate).filter(Boolean) as number[]
  const speedValues = allRecords.map(r => r.speed).filter(Boolean) as number[]  // already km/h
  const cadenceValues = allRecords.map(r => (r.cadence ?? 0) > 0 ? (r.cadence! * 2) : 0).filter(Boolean) as number[]
  const powerValues = allRecords.map(r => r.power).filter(Boolean) as number[]
  const altValues = allRecords.map(r => r.altitude).filter(v => v != null) as number[]
  const effortValues = allRecords.map(r => r["Effort Pace"]).filter(Boolean) as number[]

  // ─── GPS track ───────────────────────────────────────────────────────────
  const gpsPoints = allRecords
    .filter(r => r.position_lat != null && r.position_long != null)
    .map(r => ({
      lat: Math.round(r.position_lat! * 1e7) / 1e7,
      lon: Math.round(r.position_long! * 1e7) / 1e7,
      alt: r.altitude,
      hr: r.heart_rate,
      speed: r.speed,
      t: r.timestamp,
    }))

  // ─── Lap summaries ────────────────────────────────────────────────────────
  const lapSummaries = laps.map((lap, i) => {
    const records = lap.records ?? []
    const lapHR = records.map(r => r.heart_rate).filter(Boolean) as number[]
    const lapSpeed = records.map(r => r.speed).filter(Boolean) as number[]
    const lapCadence = records.map(r => (r.cadence ?? 0) > 0 ? r.cadence! * 2 : 0).filter(Boolean) as number[]
    const lapPower = records.map(r => r.power).filter(Boolean) as number[]
    const lapEffort = records.map(r => r["Effort Pace"]).filter(Boolean) as number[]

    const dist = lap.total_distance ?? 0
    const time = lap.total_timer_time ?? 0
    const avgSpeedKmh = lap.avg_speed ?? (dist / time * 3.6)

    return {
      index: i + 1,
      startTime: lap.start_time,
      duration: time,
      durationFmt: fmtDuration(time),
      distanceM: Math.round(dist),
      distanceKm: Math.round(dist / 10) / 100,
      avgPace: fmtPace(avgSpeedKmh),
      avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10,
      maxSpeedKmh: lap.max_speed ? Math.round(lap.max_speed * 10) / 10 : null,
      calories: lap.total_calories ?? null,
      hr: {
        avg: lap.avg_heart_rate ?? (stats(lapHR)?.avg ?? null),
        max: lap.max_heart_rate ?? (stats(lapHR)?.max ?? null),
        min: lap.min_heart_rate ?? (stats(lapHR)?.min ?? null),
      },
      cadenceSpm: {
        avg: lap.avg_cadence ? lap.avg_cadence * 2 : (stats(lapCadence)?.avg ?? null),
        max: lap.max_cadence ? lap.max_cadence * 2 : (stats(lapCadence)?.max ?? null),
      },
      power: lap.avg_power != null ? {
        avg: lap.avg_power,
        max: lap.max_power ?? null,
        normalized: lap.normalized_power ?? null,
      } : (stats(lapPower) ? { avg: stats(lapPower)!.avg, max: stats(lapPower)!.max, normalized: null } : null),
      elevation: {
        ascent: lap.total_ascent ?? null,
        descent: lap.total_descent ?? null,
      },
      runDynamics: {
        verticalOscillationCm: lap.avg_vertical_oscillation ?? null,
        verticalRatioPct: lap.avg_vertical_ratio ?? null,
        stanceTimeMs: lap.avg_stance_time ?? null,
        stepLengthM: lap.avg_step_length ? Math.round(lap.avg_step_length) / 100 : null,
      },
      effortPace: lapEffort.length > 0
        ? Math.round((lapEffort.reduce((a, b) => a + b, 0) / lapEffort.length) * 100) / 100
        : null,
      recordCount: records.length,
    }
  })

  // ─── Session summary ──────────────────────────────────────────────────────
  const totalDist = session.total_distance ?? 0
  const totalTime = session.total_timer_time ?? 0
  const avgSpeedKmh = session.avg_speed ?? (totalDist / totalTime * 3.6)

  const output = {
    file: path.basename(filePath),
    parsedAt: new Date().toISOString(),

    activity: {
      sport: session.sport ?? "unknown",
      subSport: session.sub_sport ?? null,
      startTime: session.start_time,
      endTime: session.timestamp,
      durationTotal: totalTime,
      durationFmt: fmtDuration(totalTime),
      distanceM: Math.round(totalDist),
      distanceKm: Math.round(totalDist / 10) / 100,
      avgPace: fmtPace(avgSpeedKmh),
      avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10,
      maxSpeedKmh: session.max_speed ? Math.round(session.max_speed * 10) / 10 : null,
      totalCalories: session.total_calories ?? null,
      elevation: {
        ascent: session.total_ascent ?? null,
        descent: session.total_descent ?? null,
      },
    },

    fitness: {
      hr: {
        avg: session.avg_heart_rate ?? null,
        max: session.max_heart_rate ?? null,
        min: session.min_heart_rate ?? null,
      },
      cadenceSpm: {
        avg: session.avg_cadence ? session.avg_cadence * 2 : null,
        max: session.max_cadence ? session.max_cadence * 2 : null,
      },
      power: session.avg_power != null ? {
        avg: session.avg_power,
        max: session.max_power ?? null,
        normalized: session.normalized_power ?? null,
      } : null,
      trainingLoad: {
        tss: session.training_stress_score ?? null,
        intensityFactor: session.intensity_factor ?? null,
        aerobicEffect: session.total_training_effect ?? null,
        anaerobicEffect: session.total_anaerobic_training_effect ?? null,
      },
      runDynamics: {
        verticalOscillationCm: session.avg_vertical_oscillation ?? null,
        verticalRatioPct: session.avg_vertical_ratio ?? null,
        stanceTimeMs: session.avg_stance_time ?? null,
        stepLengthM: session.avg_step_length ? Math.round(session.avg_step_length) / 100 : null,
      },
    },

    recordStats: {
      count: allRecords.length,
      heartRate: stats(hrValues),
      speedKmh: stats(speedValues),
      cadenceSpm: stats(cadenceValues),
      power: stats(powerValues),
      altitudeM: altValues.length > 0 ? {
        min: Math.round(Math.min(...altValues) * 10) / 10,
        max: Math.round(Math.max(...altValues) * 10) / 10,
        gain: null, // computed below
      } : null,
      effortPace: stats(effortValues),
      hasGps: gpsPoints.length > 0,
      gpsPointCount: gpsPoints.length,
    },

    laps: lapSummaries,

    // Raw GPS track — omit if no GPS data to keep output small
    ...(gpsPoints.length > 0 ? { gpsTrack: gpsPoints } : {}),
  }

  // Compute elevation gain from altitude series
  if (output.recordStats.altitudeM && altValues.length > 1) {
    let gain = 0
    for (let i = 1; i < altValues.length; i++) {
      const delta = altValues[i] - altValues[i - 1]
      if (delta > 0) gain += delta
    }
    output.recordStats.altitudeM.gain = Math.round(gain * 10) / 10
  }

  console.log(JSON.stringify(output, null, pretty ? 2 : 0))
})
