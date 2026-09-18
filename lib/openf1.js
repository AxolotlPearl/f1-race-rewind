// lib/openf1.js
// Client เรียก OpenF1 API จริงทุกครั้งผ่าน rateLimiter (คุม 3 req/s, 30 req/min)
// พร้อม cache ชั้นที่ 1 แบบ module-scope (best effort — จะหายเมื่อ serverless function เย็นลง
// แต่ระหว่างที่ instance ยังอุ่นอยู่จะช่วยลดการยิงซ้ำ) ข้อมูลเป็นข้อมูลย้อนหลังที่ไม่เปลี่ยนแปลง
// แล้ว จึงไม่ต้องมี TTL

import { rateLimiter } from "./rateLimiter.js";
import { HashTable } from "./HashTable.js";

const BASE_URL = "https://api.openf1.org/v1";

// cache module-scope: key = path string เต็ม, value = ผลลัพธ์ (array) ที่ parse แล้ว
const cache = new HashTable(64);

const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOpenF1(path) {
  if (cache.has(path)) return cache.get(path);

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
  });

  cache.set(path, data);
  return data;
}

export function getSessions(year, sessionType = "Race") {
  return fetchOpenF1(`/sessions?year=${encodeURIComponent(year)}&session_type=${encodeURIComponent(sessionType)}`);
}

export function getMeetings(year) {
  return fetchOpenF1(`/meetings?year=${encodeURIComponent(year)}`);
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
