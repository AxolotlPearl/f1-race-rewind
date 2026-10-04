// lib/openf1.js
// Client เรียก OpenF1 API จริงทุกครั้งผ่าน rateLimiter (คุม 3 req/s, 30 req/min)
// พร้อม cache ชั้นที่ 1 แบบ module-scope (best effort — จะหายเมื่อ serverless function เย็นลง
// แต่ระหว่างที่ instance ยังอุ่นอยู่จะช่วยลดการยิงซ้ำ)
// ข้อมูลเรซที่แข่งจบไปแล้วไม่เปลี่ยน cache ถาวรได้ แต่ "รายชื่อเรซของปีปัจจุบัน" ต้องหมดอายุได้
// ไม่งั้นเรซใหม่ที่เพิ่งแข่งจบจะไม่โผล่จนกว่า instance จะเย็นลงเอง

import { rateLimiter } from "./rateLimiter.js";
import { HashTable } from "./HashTable.js";

const BASE_URL = "https://api.openf1.org/v1";
const CURRENT_SEASON_TTL_MS = 10 * 60 * 1000;

// cache module-scope: key = path string เต็ม, value = { data, expiresAt }
const cache = new HashTable(64);

const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCurrentOrFutureSeason(year) {
  return Number(year) >= new Date().getUTCFullYear();
}

/**
 * @param {string} path
 * @param {{ ttlMs?: number, useCache?: boolean, priority?: "high"|"low", isCancelled?: () => boolean }} options
 *   ttlMs: อายุ cache (ค่าเริ่มต้นไม่หมดอายุ), useCache: false = ไม่เก็บลง cache เลย
 *   priority/isCancelled: ส่งต่อให้ rateLimiter (ดูคำอธิบายใน lib/rateLimiter.js)
 */
async function fetchOpenF1(path, { ttlMs = Infinity, useCache = true, priority = "high", isCancelled } = {}) {
  if (useCache && cache.has(path)) {
    const entry = cache.get(path);
    if (entry.expiresAt > Date.now()) return entry.data;
    cache.delete(path);
  }

  const data = await rateLimiter.enqueue(async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(`${BASE_URL}${path}`);

      // OpenF1 ตอบ 404 "No results found" เมื่อไม่มีข้อมูลประเภทนั้นสำหรับเรซนี้ (พบจริงกับ /pit
      // ของเรซ 2023 Bahrain ตอนสำรวจเฟส 0) ต้อง treat เป็น "ไม่มีข้อมูล" ไม่ใช่ error
      if (res.status === 404) return [];

      // rate limit เป็น resource กลางที่ทุกคนบนอินเทอร์เน็ตแชร์กัน ต่อให้ scheduler ของเราคุมดีแล้ว
      // ก็ยังมีโอกาสชน 429 ได้จาก jitter/ผู้ใช้คนอื่น จึง retry แบบ backoff ไม่ throw ทันที
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfterHeader = Number(res.headers.get("retry-after"));
        const backoffMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 400 * (attempt + 1);
        await sleep(backoffMs);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`OpenF1 API ตอบ ${res.status} สำหรับ ${path}: ${text}`);
      }

      return res.json();
    }
    throw new Error(`OpenF1 API ยัง 429 ต่อเนื่องหลัง retry ${MAX_RETRIES} ครั้งสำหรับ ${path}`);
  }, { priority, isCancelled });

  if (useCache) cache.set(path, { data, expiresAt: Date.now() + ttlMs });
  return data;
}

export function getSessions(year, sessionType = "Race") {
  const ttlMs = isCurrentOrFutureSeason(year) ? CURRENT_SEASON_TTL_MS : Infinity;
  return fetchOpenF1(`/sessions?year=${encodeURIComponent(year)}&session_type=${encodeURIComponent(sessionType)}`, { ttlMs });
}

export function getMeetings(year) {
  const ttlMs = isCurrentOrFutureSeason(year) ? CURRENT_SEASON_TTL_MS : Infinity;
  return fetchOpenF1(`/meetings?year=${encodeURIComponent(year)}`, { ttlMs });
}

export function getDrivers(sessionKey) {
  return fetchOpenF1(`/drivers?session_key=${encodeURIComponent(sessionKey)}`);
}

export function getOvertakes(sessionKey) {
  return fetchOpenF1(`/overtakes?session_key=${encodeURIComponent(sessionKey)}`);
}

export function getPit(sessionKey) {
  return fetchOpenF1(`/pit?session_key=${encodeURIComponent(sessionKey)}`);
}

export function getRaceControl(sessionKey) {
  return fetchOpenF1(`/race_control?session_key=${encodeURIComponent(sessionKey)}`);
}

export function getSessionResult(sessionKey) {
  return fetchOpenF1(`/session_result?session_key=${encodeURIComponent(sessionKey)}`);
}

// ใช้ตอนสร้างเส้นสนาม (ทั้ง scripts/build-track.js แบบ offline และ /api/track สำหรับสนามใหม่ที่ยัง
// ไม่มีไฟล์ precompute) เพื่อรู้ circuit_key/date_start ของเรซที่จะดึงพิกัดมาสร้างเส้นสนาม
export function getSessionInfo(sessionKey) {
  return fetchOpenF1(`/sessions?session_key=${encodeURIComponent(sessionKey)}`);
}

/**
 * getLocation - พิกัด x,y ของรถในช่วงเวลาที่ขอ (3.7 Hz ต่อนักขับ)
 * ต้อง encodeURIComponent ค่า ISO date เพราะมี "+00:00"/":" ที่ query string ตีความผิดได้ถ้าไม่ encode
 */
export function getLocation(sessionKey, { driverNumber, fromIso, toIso, priority = "high", isCancelled } = {}) {
  const params = new URLSearchParams();
  params.set("session_key", sessionKey);
  if (driverNumber != null) params.set("driver_number", driverNumber);
  // ต่อ query string ที่มี operator (>=, <=) เองเพราะ URLSearchParams จะ encode "=" ตัวหลังทับ
  const base = `/location?${params.toString()}`;
  const dateFilter = `&date>=${encodeURIComponent(fromIso)}&date<=${encodeURIComponent(toIso)}`;
  // ไม่ cache: ตอนเล่นแผนที่ยาว ๆ แต่ละหน้าต่างเวลาไม่ซ้ำกันเลย เก็บไว้มีแต่บวม memory ของ instance
  return fetchOpenF1(base + dateFilter, { useCache: false, priority, isCancelled });
}
