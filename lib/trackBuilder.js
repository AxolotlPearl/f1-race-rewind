// lib/trackBuilder.js
// สร้างเส้นสนาม (1 รอบ, normalize เป็นพิกัด SVG) จากพิกัด /location ของนักขับ 1 คน
// ใช้ทั้ง scripts/build-track.js (precompute แบบ offline) และ /api/track/:sessionKey
// (สร้างสดสำหรับสนามใหม่ที่ยังไม่มีไฟล์ใน public/tracks — เช่นสนามที่เพิ่มเข้าปฏิทินปีใหม่)

import { getSessionInfo, getSessionResult, getLocation } from "./openf1.js";
import { normalizeTrack, euclideanDistance } from "./track.js";

// รอบสนาม F1 จริงอยู่ราว ๆ 65–130 วินาที (ช่วง safety car อาจช้ากว่านั้น) ถ้าได้สั้น/ยาวกว่านี้มาก
// แปลว่าจับจุดปิดรอบผิด (เช่นสนามที่ตัดกันเองอย่าง Suzuka) ให้ทิ้งแล้วลองจุดเริ่มอื่น
const MIN_LAP_SECONDS = 55;
const MAX_LAP_SECONDS = 160;
const START_STEP_POINTS = 15; // เลื่อนจุดเริ่มทีละ ~4 วินาที (3.7Hz)
const MOVE_AWAY_RATIO = 0.2; // ต้องวิ่งออกห่างจากจุดเริ่มอย่างน้อย 20% ของขนาดสนามก่อน ถึงนับว่ากำลังวนกลับ
const MAX_CLOSURE_RATIO = 0.05; // จุดปิดรอบที่ดีที่สุดต้องห่างจากจุดเริ่มไม่เกิน 5% ของขนาดสนาม
const GOOD_ENOUGH_RATIO = 0.005; // ปิดรอบได้ใกล้ขนาดนี้ถือว่าดีแล้ว หยุดหาต่อได้เลย

function lapDurationSeconds(lap) {
  return (new Date(lap[lap.length - 1].date) - new Date(lap[0].date)) / 1000;
}

/**
 * findValidLap - หา 1 รอบสนามที่ "ปิดรอบได้สนิทที่สุด" จากพิกัดดิบในหน้าต่างเวลาหนึ่ง
 *
 * วิธีเดิม (extractOneLap) รับ "จุดแรกที่กลับมาใกล้จุดเริ่มต่ำกว่า threshold" ซึ่งเจอปัญหา 2 แบบตรงข้ามกัน:
 *  - threshold หลวม: สนามที่ตัดกันเอง (Suzuka) มีจุดกลางรอบที่ผ่านใกล้จุดเริ่ม → จับจุดหลอกได้รอบไม่ครบ
 *  - threshold เข้ม: GPS เก็บแค่ 3.7 ครั้ง/วินาที (~20 เมตร/จุดที่ความเร็วแข่ง) บางสนาม/บางรอบไม่มีจุดไหน
 *    ใกล้จุดเริ่มพอ → หาไม่เจอเลย (พบจริงกับเรซ Kuala Lumpur 2026)
 * วิธีนี้แก้ทั้งคู่: ในช่วงเวลาที่เป็นไปได้ของ 1 รอบ (55–160 วินาที) เลือก "จุดที่ใกล้จุดเริ่มที่สุด"
 * — จุดหลอกของ Suzuka ห่างกว่าจุดปิดรอบจริงเสมอ จึงไม่ถูกเลือก และไม่ต้องพึ่ง threshold ตายตัว
 * และยังไล่ลองจุดเริ่มหลายจุดในหน้าต่าง เผื่อจุดแรกตกช่วงที่รถจอดนิ่ง (ธงแดง/อยู่ในพิท)
 *
 * Time complexity: O((n/STEP) × m) โดย m = จำนวนจุดในช่วง 160 วินาที (~600) — หน้าต่าง 8 นาที
 * (~1,800 จุด) ใช้ราว 70,000 ครั้งเปรียบเทียบ เร็วระดับมิลลิวินาที
 */
export function findValidLap(points) {
  if (points.length < 10) return null;

  const times = points.map((p) => new Date(p.date).getTime());
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (scale === 0) return null; // รถไม่ขยับเลยทั้งหน้าต่าง

  let best = null; // { start, end, ratio }

  for (let start = 0; start < points.length - 10; start += START_STEP_POINTS) {
    const origin = points[start];
    let movedAway = false;
    let candidate = null;

    for (let i = start + 1; i < points.length; i++) {
      const elapsed = (times[i] - times[start]) / 1000;
      if (elapsed > MAX_LAP_SECONDS) break;

      const d = euclideanDistance(points[i], origin);
      if (!movedAway) {
        if (d > scale * MOVE_AWAY_RATIO) movedAway = true;
        continue;
      }
      if (elapsed < MIN_LAP_SECONDS) continue;
      if (!candidate || d < candidate.d) candidate = { end: i, d };
    }

    if (!candidate) continue;
    const ratio = candidate.d / scale;
    if (ratio > MAX_CLOSURE_RATIO) continue;
    if (!best || ratio < best.ratio) best = { start, end: candidate.end, ratio };
    if (best.ratio <= GOOD_ENOUGH_RATIO) break;
  }

  return best ? points.slice(best.start, best.end + 1) : null;
}

/**
 * buildTrackFromWindow - ดึงพิกัดนักขับ 1 คนช่วง [date_start+offset, +window] แล้วหา 1 รอบที่ใช้ได้
 * คืน null ถ้าช่วงนั้นหาไม่เจอ (รถจอดทั้งช่วงเพราะธงแดง, นักขับ DNF ไปแล้ว ฯลฯ)
 */
export async function buildTrackFromWindow(session, driverNumber, offsetMinutes, windowSeconds) {
  const start = new Date(session.date_start).getTime() + offsetMinutes * 60 * 1000;
  const fromIso = new Date(start).toISOString();
  const toIso = new Date(start + windowSeconds * 1000).toISOString();

  const rawPoints = await getLocation(session.session_key, { driverNumber, fromIso, toIso });
  if (rawPoints.length < 10) return null;

  const lap = findValidLap(rawPoints);
  if (!lap) return null;

  const lapSeconds = lapDurationSeconds(lap);

  const { transform, viewBox, points } = normalizeTrack(lap);
  return {
    circuitKey: session.circuit_key,
    circuitShortName: session.circuit_short_name,
    sourceSessionKey: session.session_key,
    sourceDriverNumber: driverNumber,
    lapSeconds: Number(lapSeconds.toFixed(1)),
    generatedAt: new Date().toISOString(),
    transform,
    viewBox,
    points,
  };
}

/**
 * buildTrackAuto - เลือกนักขับ/ช่วงเวลาเองแล้วลองไล่ทีละแบบจนได้ 1 รอบที่ใช้ได้
 * เริ่มจากผู้ชนะ (วิ่งครบระยะแน่ ๆ) ที่ +20 นาที แล้วค่อยถอยไปช่วงหลัง ๆ / นักขับคนอื่น
 * จำกัดจำนวนครั้งไว้ เพราะ endpoint นี้รันบน serverless ที่มีเวลาจำกัดและต้องเคารพ rate limit
 */
export async function buildTrackAuto(sessionKey) {
  const [session] = await getSessionInfo(sessionKey);
  if (!session) return null;

  const results = await getSessionResult(sessionKey);
  const finishers = results.filter((r) => !r.dnf && !r.dns && !r.dsq && r.position != null);
  let first = null;
  let second = null;
  for (const r of finishers) {
    if (!first || r.position < first.position) {
      second = first;
      first = r;
    } else if (!second || r.position < second.position) {
      second = r;
    }
  }
  const winner = first?.driver_number ?? results[0]?.driver_number;
  const runnerUp = second?.driver_number;
  if (winner == null) return null;

  // หน้าต่างละ 8 นาที (1 request ต่อครั้ง ~1,800 จุด) กระจายให้ครอบคลุมทั้งเรซ เพราะบางเรซหยุดนาน
  // มาก (พบจริง: Kuala Lumpur 2026 รถจอดนิ่งตลอดช่วง +35 ถึง +93 นาที) ลองผู้ชนะก่อนเพราะวิ่งครบ
  // ระยะแน่ ๆ แล้วค่อยใช้อันดับ 2 เป็นทางสำรอง
  const WINDOW_SECONDS = 480;
  const attempts = [
    [winner, 20],
    [winner, 50],
    [winner, 80],
    [winner, 100],
    [runnerUp ?? winner, 35],
  ];

  for (const [driverNumber, offsetMinutes] of attempts) {
    const track = await buildTrackFromWindow(session, driverNumber, offsetMinutes, WINDOW_SECONDS);
    if (track) return track;
  }
  return null;
}
