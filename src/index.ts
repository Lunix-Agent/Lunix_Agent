// src/index.ts
import { DuckDBConnection } from '@duckdb/node-api'
import FitParser from 'fit-file-parser'

const buffer = await Bun.file('./data/475490951656144900.fit').arrayBuffer()
const parser = new FitParser({
  force: true,
  speedUnit: 'km/h',
  lengthUnit: 'm',
  temperatureUnit: 'celsius',
  elapsedRecordField: true,
  mode: 'both',
})

parser.parse(Buffer.from(buffer), async (error, data) => {
  if (error) throw error

  console.log('=== Message Types ===')
  Object.entries(data ?? {}).forEach(([key, value]) => {
    if (Array.isArray(value) && value.length > 0) {
      console.log(`${key}: ${value.length}`)
    }
  })

  console.log('\n=== First Record (raw) ===')
  console.log(data?.records?.[0])

  await Bun.write('./data/records.json', JSON.stringify(data?.records))

  const conn = await DuckDBConnection.create()

  await conn.run(`
    CREATE TABLE records AS
    SELECT * FROM read_json_auto('./data/records.json')
  `)

  await conn.run(`
    CREATE TABLE laps AS
    SELECT * FROM read_json_auto('./data/laps.json')
  `)

//   const summary = await conn.runAndReadAll(`
//     SELECT
//       count(*)                          AS total_records,
//       round(max(distance), 1)           AS total_distance_m,
//       round(max(elapsed_time), 0)       AS elapsed_seconds,
//       round(avg(heart_rate), 1)         AS avg_hr,
//       max(heart_rate)                   AS max_hr,
//       round(avg(speed), 2)              AS avg_speed_kmh,
//       round(avg(cadence), 1)            AS avg_cadence
//     FROM records
//   `)

// console.log('\n=== Activity Summary ===')
// console.table(summary.getRowObjectsJS())

// const splits = await conn.runAndReadAll(`
//     SELECT
//       floor(distance / 1000) + 1                    AS km,
//       count(*)                                       AS seconds,
//       round(avg(heart_rate), 0)                      AS avg_hr,
//       round(60 / avg(speed), 2)                      AS pace_min_per_km,
//       round(avg(cadence), 0)                         AS avg_cadence
//     FROM records
//     WHERE speed > 0
//       AND heart_rate IS NOT NULL
//     GROUP BY 1
//     ORDER BY 1
//   `)

//   console.log('\n=== KM Splits ===')
//   console.table(splits.getRowObjectsJS())

//   await Bun.write('./data/laps.json', JSON.stringify(data?.laps))

//   await conn.run(`
//     CREATE TABLE laps AS
//     SELECT * FROM read_json_auto('./data/laps.json')
//   `)

//   const laps = await conn.runAndReadAll(`
//     SELECT
//       row_number() OVER ()                           AS lap,
//       round(total_distance, 0)                       AS distance_m,
//       round(total_elapsed_time, 0)                   AS duration_s,
//       round(60 / avg_speed, 2)                       AS pace_min_per_km,
//       round(avg_heart_rate, 0)                       AS avg_hr,
//       max_heart_rate                                 AS max_hr,
//       round(avg_cadence, 0)                          AS avg_cadence
//     FROM laps
//     ORDER BY lap
//   `)

//   console.log('\n=== Laps ===')
//   console.table(laps.getRowObjectsJS())

// const reps = await conn.runAndReadAll(`
//     WITH numbered AS (
//       SELECT
//         row_number() OVER ()              AS lap_num,
//         round(total_distance, 0)          AS distance_m,
//         round(total_elapsed_time, 0)      AS duration_s,
//         round(60 / avg_speed, 2)          AS pace_min_per_km,
//         round(avg_heart_rate, 0)          AS avg_hr,
//         max_heart_rate                    AS max_hr,
//         round(avg_cadence, 0)             AS avg_cadence
//       FROM laps
//     ),
//     classified AS (
//       SELECT *,
//         CASE
//           WHEN lap_num BETWEEN 2 AND 11 AND duration_s = 180 THEN 'block_1_hard'
//           WHEN lap_num BETWEEN 2 AND 11 AND duration_s = 60  THEN 'block_1_rest'
//           WHEN lap_num BETWEEN 12 AND 23 AND pace_min_per_km < 4.0 THEN 'block_2_hard'
//           WHEN lap_num BETWEEN 12 AND 23 AND pace_min_per_km >= 4.0 THEN 'block_2_rest'
//         END AS lap_type
//       FROM numbered
//     )
//     SELECT * FROM classified
//     WHERE lap_type IS NOT NULL
//     ORDER BY lap_num
//   `)

//   console.log('\n=== Reps Classified ===')
//   console.table(reps.getRowObjectsJS())

// const blockSummary = await conn.runAndReadAll(`
//     WITH numbered AS (
//       SELECT
//         row_number() OVER ()              AS lap_num,
//         round(total_distance, 0)          AS distance_m,
//         round(total_elapsed_time, 0)      AS duration_s,
//         round(60 / avg_speed, 2)          AS pace_min_per_km,
//         round(avg_heart_rate, 0)          AS avg_hr,
//         max_heart_rate                    AS max_hr,
//         round(avg_cadence, 0)             AS avg_cadence
//       FROM laps
//     ),
//     classified AS (
//       SELECT *,
//         CASE
//           WHEN lap_num BETWEEN 2 AND 11 AND duration_s = 180 THEN 'block_1_hard'
//           WHEN lap_num BETWEEN 2 AND 11 AND duration_s = 60  THEN 'block_1_rest'
//           WHEN lap_num BETWEEN 12 AND 23 AND pace_min_per_km < 4.0 THEN 'block_2_hard'
//           WHEN lap_num BETWEEN 12 AND 23 AND pace_min_per_km >= 4.0 THEN 'block_2_rest'
//         END AS lap_type
//       FROM numbered
//     )
//     SELECT
//       lap_type,
//       count(*)                        AS rep_count,
//       round(avg(distance_m), 0)       AS avg_distance_m,
//       round(avg(pace_min_per_km), 2)  AS avg_pace,
//       round(avg(avg_hr), 0)           AS avg_hr,
//       round(avg(max_hr), 0)           AS avg_max_hr,
//       round(avg(avg_cadence), 0)      AS avg_cadence
//     FROM classified
//     WHERE lap_type IS NOT NULL
//     GROUP BY lap_type
//     ORDER BY lap_type
//   `)

//   console.log('\n=== Block Summary ===')
//   console.table(blockSummary.getRowObjectsJS())

const fiveKSplits = await conn.runAndReadAll(`
SELECT
      ceil(distance / 5000)                                                                AS chunk,
      count(*)                                                                             AS seconds,
      round(max(distance) - min(distance), 0)                                             AS distance_m,
      cast(floor(max(elapsed_time) / 60) as integer) || ':' ||
        lpad(cast(round(max(elapsed_time) % 60) as integer)::varchar, 2, '0')             AS cumulative_time,
      cast(floor(60 / avg(speed)) as integer) || ':' || 
        lpad(cast(round(((60 / avg(speed)) % 1) * 60) as integer)::varchar, 2, '0')       AS avg_pace,
      round(avg(heart_rate), 0)                                                            AS avg_hr,
      round(avg(cadence) * 2, 0)                                                          AS avg_spm
    FROM records
    WHERE speed > 0
      AND heart_rate IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `)

  console.log('\n=== 5km Chunks ===')
  console.table(fiveKSplits.getRowObjectsJS())
})