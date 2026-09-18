// lib/timeline.js
// รวม event จาก overtakes / pit / race_control ให้เป็นไทม์ไลน์เดียวเรียงตามเวลา
// พร้อม enrich ด้วยข้อมูลนักขับ (ชื่อ/ทีม/สีทีม) ผ่าน HashTable แบบ O(1) เฉลี่ย

import { getDrivers, getOvertakes, getPit, getRaceControl, getSessionResult } from "./openf1.js";
import { HashTable } from "./HashTable.js";
import { mergeSort, mergePairwise } from "./sort.js";

const byDate = (a, b) => new Date(a.date) - new Date(b.date);

/**
 * หมายเหตุสำคัญที่พบตอนสำรวจ API (เฟส 0): /overtakes ไม่มี field lap_number ติดมาด้วย
 * (มีแค่ overtaking_driver_number, overtaken_driver_number, date, position)
 * แต่ /pit และ /race_control มี lap_number ทั้งคู่ จึงประมาณค่ารอบของ overtake โดยหา
 * lap marker (จาก pit+race_control) ที่ date ล่าสุดก่อนหน้า overtake นั้น แล้วใช้ lap ของมัน
 * เป็นค่าประมาณ (ใกล้เคียงมาก เพราะ marker เหล่านี้กระจายอยู่ทั่วเรซ)
 */
function buildLapMarkers(pitEvents, raceControlEvents) {
  const markers = [];
  for (const p of pitEvents) {
    if (p.lap_number != null) markers.push({ date: p.date, lap: p.lap_number });
  }
  for (const rc of raceControlEvents) {
    if (rc.lap_number != null) markers.push({ date: rc.date, lap: rc.lap_number });
  }
  return mergeSort(markers, byDate);
}

/** หา lap ล่าสุดที่เกิดก่อนหรือพร้อมกับ date ที่ให้มา. Time complexity: O(m) ต่อครั้ง (m = จำนวน marker) */
function estimateLap(sortedMarkers, date) {
  const target = new Date(date).getTime();
  let lap = sortedMarkers.length > 0 ? sortedMarkers[0].lap : null;
  for (const marker of sortedMarkers) {
    if (new Date(marker.date).getTime() <= target) {
      lap = marker.lap;
    } else {
      break;
    }
  }
  return lap;
}

function normalizeOvertakes(overtakes, lapMarkers) {
  return overtakes.map((o, i) => ({
    id: `overtake-${o.session_key}-${i}`,
    type: "overtake",
    date: o.date,
    lap: estimateLap(lapMarkers, o.date),
    lapIsEstimated: true,
    driverNumbers: [o.overtaking_driver_number, o.overtaken_driver_number],
    position: o.position,
    message: null, // สร้างข้อความจริงตอน enrich (ต้องรู้ชื่อนักขับก่อน)
  }));
}

function normalizePit(pitStops) {
  return pitStops.map((p, i) => ({
    id: `pit-${p.session_key}-${i}`,
    type: "pit",
    date: p.date,
    lap: p.lap_number ?? null,
    lapIsEstimated: false,
    driverNumbers: [p.driver_number],
    pitDuration: p.pit_duration ?? null,
    message: null,
  }));
}

const FLAG_CATEGORY_TO_TYPE = {
  Flag: "flag",
  SafetyCar: "safety_car",
  Drs: "drs",
};

function normalizeRaceControl(raceControlEvents) {
  return raceControlEvents
    .filter((rc) => rc.category !== "Other") // ตัดข้อความบริหารทั่วไปที่ไม่เกี่ยวกับ event ในสนาม
    .map((rc, i) => ({
      id: `rc-${rc.session_key}-${i}`,
      type: FLAG_CATEGORY_TO_TYPE[rc.category] ?? "other_control",
      date: rc.date,
      lap: rc.lap_number ?? null,
      lapIsEstimated: false,
      driverNumbers: rc.driver_number != null ? [rc.driver_number] : [],
      flag: rc.flag ?? null,
      scope: rc.scope ?? null,
      message: rc.message ?? null,
    }));
}

function buildDriverLookup(drivers) {
  const table = new HashTable(32);
  for (const d of drivers) {
    table.set(d.driver_number, {
      driverNumber: d.driver_number,
      fullName: d.full_name,
      acronym: d.name_acronym,
      teamName: d.team_name,
      // team_colour ไม่คงที่ตัวใหญ่/เล็กระหว่างปี (พบตอนเฟส 0) -> normalize เป็นตัวเล็กเสมอ
      teamColour: (d.team_colour ?? "888888").toLowerCase(),
    });
  }
  return table;
}

function driverLabel(driverLookup, driverNumber) {
  const d = driverLookup.get(driverNumber);
  return d ? `${d.acronym} (#${driverNumber})` : `#${driverNumber}`;
}

function attachMessages(events, driverLookup) {
  for (const e of events) {
    if (e.message) continue; // race_control มีข้อความจาก API อยู่แล้ว
    if (e.type === "overtake") {
      const [byNum, overNum] = e.driverNumbers;
      e.message = `${driverLabel(driverLookup, byNum)} แซง ${driverLabel(driverLookup, overNum)}`;
    } else if (e.type === "pit") {
      const [num] = e.driverNumbers;
      const duration = e.pitDuration != null ? `${e.pitDuration.toFixed(1)}s` : "ไม่ทราบเวลา";
      e.message = `${driverLabel(driverLookup, num)} เข้าพิท (${duration})`;
    }
  }
  return events;
}

function enrichWithDriverInfo(events, driverLookup) {
  for (const e of events) {
    e.drivers = e.driverNumbers.map((num) => driverLookup.get(num) ?? { driverNumber: num, fullName: `#${num}`, teamColour: "888888" });
  }
  return events;
}

function computeSummary(sessionResult, overtakeCount, pitCount, driverLookup) {
  if (sessionResult.length === 0) {
    return { winner: null, totalLaps: null, overtakeCount, pitCount };
  }
  let winnerRow = sessionResult[0];
  for (const row of sessionResult) {
    if (row.position != null && (winnerRow.position == null || row.position < winnerRow.position)) {
      winnerRow = row;
    }
  }
  let totalLaps = 0;
  for (const row of sessionResult) {
    if (row.number_of_laps != null && row.number_of_laps > totalLaps) totalLaps = row.number_of_laps;
  }
  const winnerDriver = driverLookup.get(winnerRow.driver_number);
  return {
    winner: winnerDriver
      ? { driverNumber: winnerRow.driver_number, fullName: winnerDriver.fullName, teamName: winnerDriver.teamName, teamColour: winnerDriver.teamColour }
      : { driverNumber: winnerRow.driver_number },
    totalLaps,
    overtakeCount,
    pitCount,
  };
}

function enrichSessionResult(sessionResult, driverLookup) {
  return sessionResult.map((row) => {
    const driver = driverLookup.get(row.driver_number);
    return {
      ...row,
      fullName: driver?.fullName ?? `#${row.driver_number}`,
      acronym: driver?.acronym ?? String(row.driver_number),
      teamName: driver?.teamName ?? "-",
      teamColour: driver?.teamColour ?? "888888",
    };
  });
}

/** rankFastestPits - เรียง pit stop จากเร็วสุดไปช้าสุดด้วย mergeSort (ไม่ใช้ .sort()) */
function rankFastestPits(pitStops, driverLookup) {
  const withDuration = pitStops.filter((p) => p.pit_duration != null);
  const sorted = mergeSort(withDuration, (a, b) => a.pit_duration - b.pit_duration);
  return sorted.map((p) => {
    const driver = driverLookup.get(p.driver_number);
    return {
      driverNumber: p.driver_number,
      fullName: driver?.fullName ?? `#${p.driver_number}`,
      teamColour: driver?.teamColour ?? "888888",
      lap: p.lap_number ?? null,
      pitDuration: p.pit_duration,
    };
  });
}

/**
 * buildTimeline - ยิง 5 endpoint ที่เกี่ยวกับเรซนี้พร้อมกัน (ผ่าน rate limiter ตัวเดียวกัน
 * เลยยังถูกคุมความเร็วรวมอยู่ดี) แล้วรวมเป็นไทม์ไลน์เดียวเรียงตามเวลา
 */
export async function buildTimeline(sessionKey) {
  const [drivers, overtakes, pit, raceControl, sessionResult] = await Promise.all([
    getDrivers(sessionKey),
    getOvertakes(sessionKey),
    getPit(sessionKey),
    getRaceControl(sessionKey),
    getSessionResult(sessionKey),
  ]);

  const driverLookup = buildDriverLookup(drivers);
  const lapMarkers = buildLapMarkers(pit, raceControl);

  const overtakeEvents = mergeSort(normalizeOvertakes(overtakes, lapMarkers), byDate);
  const pitEvents = mergeSort(normalizePit(pit), byDate);
  const controlEvents = mergeSort(normalizeRaceControl(raceControl), byDate);

  // รวม 3 แหล่งทีละคู่ (merge sort แบบ pairwise) ไม่ใช้ heap/priority queue ตามข้อกำหนด
  const merged = mergePairwise([overtakeEvents, pitEvents, controlEvents], byDate);

  attachMessages(merged, driverLookup);
  enrichWithDriverInfo(merged, driverLookup);

  const summary = computeSummary(sessionResult, overtakes.length, pit.length, driverLookup);

  return {
    sessionKey,
    drivers: drivers.map((d) => ({
      driverNumber: d.driver_number,
      fullName: d.full_name,
      acronym: d.name_acronym,
      teamName: d.team_name,
      teamColour: (d.team_colour ?? "888888").toLowerCase(),
    })),
    events: merged,
    sessionResult: enrichSessionResult(sessionResult, driverLookup),
    fastestPits: rankFastestPits(pit, driverLookup),
    summary,
    dataAvailability: {
      hasOvertakes: overtakes.length > 0,
      hasPit: pit.length > 0,
      hasRaceControl: raceControl.length > 0,
      hasSessionResult: sessionResult.length > 0,
    },
  };
}
