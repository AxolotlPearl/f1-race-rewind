// lib/rateLimiter.js
// คุมไม่ให้ยิงไป OpenF1 API เกิน 3 req/s และ 30 req/min โดยใช้ Queue ที่เขียนเอง (lib/Queue.js)
// ทำไมต้อง Queue: งานที่เข้ามาพร้อมกัน (เช่น buildTimeline ยิง 5 endpoint พร้อมกัน) ต้องรอเป็นลำดับ
// FIFO และต้อง dequeue เวลาที่ยิงไปแล้วที่หมดอายุออกจากหน้าคิวบ่อย ๆ ถ้าใช้ array.shift() ตรงนี้
// จะเป็น O(n) ทุกครั้งที่ trim ส่วน Queue ของเราเป็น O(1) เสมอ

import { Queue } from "./Queue.js";

const MAX_PER_SECOND = 3;
const MAX_PER_MINUTE = 30;
const SECOND_MS = 1000;
const MINUTE_MS = 60000;
const SAFETY_MARGIN_MS = 150; // กันพลาดจาก clock jitter / เวลาที่ request เดินทางไปถึงเซิร์ฟเวอร์จริง

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RateLimiter {
  constructor() {
    this.taskQueue = new Queue(32);
    this.recentTimestamps = new Queue(64); // เก็บเวลาที่ยิง request ไปแล้วภายใน 60 วินาทีล่าสุด
    this.processing = false;
  }

  /**
   * enqueue - จองสิทธิ์ยิง request หนึ่งครั้ง คืน Promise ที่ resolve เมื่อ fn() ทำงานเสร็จ
   * fn ควรเป็น async function ที่คืน Promise ของผลลัพธ์จริง (เช่น fetch แล้ว parse json)
   */
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.taskQueue.enqueue({ fn, resolve, reject });
      this._processLoop();
    });
  }

  /** _trimExpired - เอา timestamp ที่เก่ากว่า 60 วินาทีออกจากหน้าคิว. Time complexity: O(k) ที่ k = จำนวนตัวที่หมดอายุ */
  _trimExpired(now) {
    while (!this.recentTimestamps.isEmpty() && now - this.recentTimestamps.peek() >= MINUTE_MS) {
      this.recentTimestamps.dequeue();
    }
  }

  /** _delayNeeded - คำนวณว่าต้องรอกี่ ms ก่อนยิง request ถัดไปได้ (0 ถ้ายิงได้ทันที) */
  _delayNeeded(now) {
    const timestamps = this.recentTimestamps.toArray();

    const withinLastSecond = timestamps.filter((t) => now - t < SECOND_MS);
    if (withinLastSecond.length >= MAX_PER_SECOND) {
      const oldest = withinLastSecond[0];
      return SECOND_MS - (now - oldest) + SAFETY_MARGIN_MS;
    }

    if (timestamps.length >= MAX_PER_MINUTE) {
      const oldest = timestamps[0];
      return MINUTE_MS - (now - oldest) + SAFETY_MARGIN_MS;
    }

    return 0;
  }

  async _processLoop() {
    if (this.processing) return;
    this.processing = true;

    while (!this.taskQueue.isEmpty()) {
      const now = Date.now();
      this._trimExpired(now);

      const delay = this._delayNeeded(now);
      if (delay > 0) {
        await sleep(delay);
        continue;
      }

      const task = this.taskQueue.dequeue();
      this.recentTimestamps.enqueue(Date.now());
      if (process.env.DEBUG_RATE_LIMITER) {
        console.error(`[rateLimiter] dispatch at t=${Date.now()} window=${JSON.stringify(this.recentTimestamps.toArray())}`);
      }

      try {
        const result = await task.fn();
        task.resolve(result);
      } catch (err) {
        task.reject(err);
      }
    }

    this.processing = false;
  }
}

// export instance เดียว (singleton) ให้ทุกที่ที่ import ใช้ตัวเดียวกัน
// เพื่อคุม rate limit ของทั้งแอปรวมกัน ไม่ใช่แยกต่อไฟล์
export const rateLimiter = new RateLimiter();
