// lib/rateLimiter.js
// คุมไม่ให้ยิงไป OpenF1 API เกิน 3 req/s และ 30 req/min โดยใช้ Queue ที่เขียนเอง (lib/Queue.js)
//
// ทำไมต้อง Queue: งานที่เข้ามาพร้อมกัน (เช่น buildTimeline ยิง 5 endpoint พร้อมกัน) ต้องรอเป็นลำดับ
// FIFO และต้อง dequeue เวลาที่ยิงไปแล้วที่หมดอายุออกจากหน้าคิวบ่อย ๆ ถ้าใช้ array.shift() ตรงนี้
// จะเป็น O(n) ทุกครั้งที่ trim ส่วน Queue ของเราเป็น O(1) เสมอ
//
// คิว 2 ระดับ (ใช้ Queue 2 ตัว ไม่ใช่ heap/priority queue ซึ่งยังไม่ได้เรียน):
//   - high: request ที่ผู้ใช้กำลังรอดูอยู่ (รายชื่อเรซ, ไทม์ไลน์, เส้นสนาม)
//   - low:  request โหลดพิกัดรถล่วงหน้าของตัวเล่นแผนที่ (background)
// ภายในแต่ละระดับยังเป็น FIFO (มาก่อนได้ก่อน) แต่ high ได้ไปก่อน low เสมอ
// ปัญหาที่เจอจริงก่อนแก้: โควตา 30 req/min ถูกใช้หมดไปกับการโหลดล่วงหน้า พอผู้ใช้เปลี่ยนเรซ
// request ไทม์ไลน์ของเรซใหม่ต้องต่อคิวหลังงาน background จนใช้เวลา 15 วินาที

import { Queue } from "./Queue.js";

const SECOND_MS = 1000;
const MINUTE_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortError() {
  const err = new Error("request ถูกยกเลิกก่อนถึงคิว");
  err.name = "AbortError";
  return err;
}

// ขณะรอโควตา ให้ตื่นมาเช็คคิวบ่อย ๆ — ถ้างาน high เข้ามาระหว่างที่งาน low กำลังรอ จะได้ไม่ต้องรอนานตาม
const MAX_SLEEP_SLICE_MS = 250;

export class RateLimiter {
  /**
   * @param {object} options
   * @param {number} options.lowPriorityPerMinute โควตาสูงสุดต่อนาทีที่งาน low ใช้ได้ ส่วนที่เหลือกันไว้ให้
   *   งาน high เสมอ — ผู้ใช้สลับเรซเร็ว ๆ แล้วงานโหลดล่วงหน้าจะกินโควตาจนงานที่ผู้ใช้รออยู่ไม่มีที่เหลือ
   *   (พบจริง: สร้างเส้นสนามสนามใหม่ต้องรอ 43 วินาทีเพราะโควตา 30/นาทีหมดก่อน)
   */
  constructor({ perSecond = 3, perMinute = 30, lowPriorityPerMinute = 20, safetyMarginMs = 150 } = {}) {
    this.perSecond = perSecond;
    this.perMinute = perMinute;
    this.lowPriorityPerMinute = Math.min(lowPriorityPerMinute, perMinute);
    this.safetyMarginMs = safetyMarginMs; // กันพลาดจาก clock jitter / เวลาที่ request เดินทางไปถึงจริง
    this.highQueue = new Queue(32);
    this.lowQueue = new Queue(32);
    this.recentTimestamps = new Queue(64); // เวลาที่ยิง request ไปแล้วภายใน 60 วินาทีล่าสุด
    this.processing = false;
  }

  /**
   * enqueue - จองสิทธิ์ยิง request หนึ่งครั้ง คืน Promise ที่ resolve เมื่อ fn() ทำงานเสร็จ
   * @param {() => Promise<any>} fn async function ที่ยิง request จริง
   * @param {{ priority?: "high" | "low", isCancelled?: () => boolean }} options
   *   isCancelled: ถ้าคืน true ตอนถึงคิวแล้ว (เช่นผู้ใช้กระโดดไปเวลาอื่น/ปิดหน้าไปแล้ว) จะไม่ยิงจริง
   *   ไม่เสียโควตาไปกับงานที่ไม่มีใครรอผลแล้ว
   * Time complexity: O(1)
   */
  enqueue(fn, { priority = "high", isCancelled } = {}) {
    return new Promise((resolve, reject) => {
      const queue = priority === "low" ? this.lowQueue : this.highQueue;
      queue.enqueue({ fn, resolve, reject, isCancelled });
      this._processLoop();
    });
  }

  get pending() {
    return this.highQueue.size + this.lowQueue.size;
  }

  /** _nextTask - เอางานถัดไป: คิว high ก่อนเสมอ ถ้าว่างค่อยเอาจาก low. Time complexity: O(1) */
  _nextTask() {
    return this.highQueue.isEmpty() ? this.lowQueue.dequeue() : this.highQueue.dequeue();
  }

  /** _trimExpired - เอา timestamp ที่เก่ากว่า 60 วินาทีออกจากหน้าคิว. Time complexity: O(k) ที่ k = จำนวนตัวที่หมดอายุ */
  _trimExpired(now) {
    while (!this.recentTimestamps.isEmpty() && now - this.recentTimestamps.peek() >= MINUTE_MS) {
      this.recentTimestamps.dequeue();
    }
  }

  /**
   * _delayNeeded - ต้องรอกี่ ms ก่อนยิงงานถัดไปได้ (0 = ยิงได้ทันที)
   * งานถัดไปเป็น low จะถูกจำกัดที่ lowPriorityPerMinute แทน perMinute (กันโควตาไว้ให้งาน high)
   * Time complexity: O(w), w ≤ perMinute
   */
  _delayNeeded(now) {
    const timestamps = this.recentTimestamps.toArray();

    const withinLastSecond = timestamps.filter((t) => now - t < SECOND_MS);
    if (withinLastSecond.length >= this.perSecond) {
      return SECOND_MS - (now - withinLastSecond[0]) + this.safetyMarginMs;
    }

    const nextIsLow = this.highQueue.isEmpty();
    const minuteCap = nextIsLow ? this.lowPriorityPerMinute : this.perMinute;
    if (timestamps.length >= minuteCap) {
      // ต้องรอจนเหลือในหน้าต่าง 60 วินาทีน้อยกว่า cap → timestamp ตัวที่ (len - cap) ต้องหมดอายุก่อน
      const mustExpire = timestamps[timestamps.length - minuteCap];
      return MINUTE_MS - (now - mustExpire) + this.safetyMarginMs;
    }
    return 0;
  }

  async _processLoop() {
    if (this.processing) return;
    this.processing = true;

    while (this.pending > 0) {
      const now = Date.now();
      this._trimExpired(now);

      const delay = this._delayNeeded(now);
      if (delay > 0) {
        await sleep(Math.min(delay, MAX_SLEEP_SLICE_MS));
        continue;
      }

      const task = this._nextTask();
      if (task.isCancelled?.()) {
        task.reject(abortError()); // ไม่นับโควตา ไปงานถัดไปเลย
        continue;
      }

      this.recentTimestamps.enqueue(Date.now());
      // ยิงแล้วไม่ต้องรอผลก่อนส่งตัวถัดไป — อัตราการ "ส่ง" ยังถูกคุมด้วย timestamp ด้านบน
      // (เดิมรอให้ตอบกลับทีละตัว ทำให้ได้จริงแค่ ~1–2 req/s ทั้งที่อนุญาต 3)
      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject);
    }

    this.processing = false;
  }
}

// export instance เดียว (singleton) ให้ทุกที่ที่ import ใช้ตัวเดียวกัน
// เพื่อคุม rate limit ของทั้งแอปรวมกัน ไม่ใช่แยกต่อไฟล์
export const rateLimiter = new RateLimiter();
