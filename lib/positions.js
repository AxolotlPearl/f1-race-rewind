// lib/positions.js
// จัดกลุ่มพิกัดรถ (จาก /location ที่ได้ทุกคันในหน้าต่างเวลาเดียว) แยกตามนักขับ + downsample
// ให้เบาลงก่อนส่งกลับ ป้องกัน response ใหญ่เกินไปถ้าผู้ใช้ขอหน้าต่างเวลานานเข้าใกล้ 60 วินาที
// (ตามข้อจำกัด Vercel: response ต้องไม่เกิน 4.5MB)

import { HashTable } from "./HashTable.js";

const TARGET_HZ = 2;

/**
 * groupByDriver - จัดกลุ่มพิกัดดิบตาม driver_number ด้วย HashTable แทนการ find() ทุกจุด
 * (ถ้าใช้ find() ทุกจุดจะเป็น O(n × d) โดย d = จำนวนนักขับ, ส่วนนี้เป็น O(n) เฉลี่ย)
 * Time complexity: O(n)
 */
export function groupByDriver(rawPoints) {
  const table = new HashTable(32);
  for (const p of rawPoints) {
    if (!table.has(p.driver_number)) table.set(p.driver_number, []);
    table.get(p.driver_number).push(p);
  }
  const result = {};
  for (const driverNumber of table.keys()) {
    result[driverNumber] = table.get(driverNumber);
  }
  return result;
}

/**
 * downsample - ลดความถี่ของจุดพิกัดให้เหลือประมาณ targetHz ต่อวินาที ด้วยการสุ่มเลือกทุก ๆ N จุด
 * (ไม่ใช่ DSA ที่ใบงานบังคับ แค่ ลด payload) Time complexity: O(n)
 */
export function downsample(points, windowSeconds, targetHz = TARGET_HZ) {
  const maxPoints = Math.max(2, Math.ceil(windowSeconds * targetHz));
  if (points.length <= maxPoints) return points;

  const stride = Math.ceil(points.length / maxPoints);
  const result = [];
  for (let i = 0; i < points.length; i += stride) {
    result.push(points[i]);
  }
  return result;
}

export function buildPositionsResponse(rawPoints, windowSeconds) {
  const grouped = groupByDriver(rawPoints);
  const positions = {};
  for (const driverNumber of Object.keys(grouped)) {
    positions[driverNumber] = downsample(grouped[driverNumber], windowSeconds).map((p) => ({
      date: p.date,
      x: p.x,
      y: p.y,
    }));
  }
  return positions;
}
