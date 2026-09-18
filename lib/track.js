// lib/track.js
// ฟังก์ชันล้วน (pure function) สำหรับตัดพิกัดดิบให้เหลือ "หนึ่งรอบสนาม" แล้ว normalize เป็น
// พิกัดสำหรับวาด SVG — แยกจาก scripts/build-track.js เพื่อให้เทสได้โดยไม่ต้องยิง API จริง

/** euclideanDistance - ระยะห่างระหว่างจุด 2 จุด. Time complexity: O(1) */
export function euclideanDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * extractOneLap - หาว่ารถวิ่งครบ 1 รอบที่ index ไหน โดยหาจุดที่ห่างจากจุดเริ่มต้นมากพอ
 * (ออกจากบริเวณเริ่ม) ก่อน แล้วค่อยหาจุดที่วนกลับมาใกล้จุดเริ่มต้นอีกครั้ง (ปิดรอบ)
 * Time complexity: O(n) โดย n = จำนวนจุดพิกัดที่ดึงมา
 *
 * @param {{x:number, y:number, date:string}[]} points เรียงตามเวลาแล้ว
 * @returns {{x:number, y:number, date:string}[] | null} จุดของ 1 รอบ (null ถ้าหาไม่เจอในช่วงที่ให้มา)
 */
export function extractOneLap(points) {
  if (points.length < 10) return null;

  const start = points[0];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const scale = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const MOVE_AWAY_RATIO = 0.2;
  // บางสนาม (เช่น Suzuka ที่ตัดกันเองแบบ figure-8) มีจุดที่รถวิ่งผ่านใกล้จุดเริ่มต้นกลางรอบ
  // ก่อนจะกลับมาจริง ๆ ตอนจบรอบ ถ้าค่านี้หลวมเกินไปจะจับจุดผ่านกลางรอบผิดเป็นจุดปิดรอบ
  const RETURN_CLOSE_RATIO = 0.015;

  const leaveIdx = points.findIndex((p) => euclideanDistance(p, start) > scale * MOVE_AWAY_RATIO);
  if (leaveIdx === -1) return null;

  for (let i = leaveIdx; i < points.length; i++) {
    if (euclideanDistance(points[i], start) < scale * RETURN_CLOSE_RATIO) {
      return points.slice(0, i + 1);
    }
  }
  return null;
}

const DEFAULT_MAX_DIMENSION = 520;
const DEFAULT_PADDING = 20;

/**
 * normalizeTrack - แปลงพิกัดดิบ (หน่วยของ OpenF1 เอง) ให้เป็นพิกัดสำหรับ SVG viewBox
 * พร้อมเก็บพารามิเตอร์ที่ใช้แปลง (minX, minY, scale, padding) ไว้ด้วย เพื่อให้ฝั่ง client
 * แปลงพิกัดรถแบบ real-time (จาก /api/positions) ด้วยสูตรเดียวกันได้ ให้จุดตรงกับเส้นสนาม
 * Time complexity: O(n)
 */
export function normalizeTrack(lapPoints, { maxDimension = DEFAULT_MAX_DIMENSION, padding = DEFAULT_PADDING } = {}) {
  const xs = lapPoints.map((p) => p.x);
  const ys = lapPoints.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX;
  const height = Math.max(...ys) - minY;
  const scale = (maxDimension - padding * 2) / Math.max(width, height);

  const transform = { minX, minY, scale, padding };

  const points = lapPoints.map((p) => applyTrackTransform(transform, p));

  return {
    transform,
    viewBox: { width: width * scale + padding * 2, height: height * scale + padding * 2 },
    points,
  };
}

/** applyTrackTransform - ใช้พารามิเตอร์แปลงพิกัดเดียวกับตอนสร้างเส้นสนาม กับพิกัดรถ real-time */
export function applyTrackTransform(transform, point) {
  return {
    x: transform.padding + (point.x - transform.minX) * transform.scale,
    y: transform.padding + (point.y - transform.minY) * transform.scale,
  };
}
