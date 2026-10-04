// test/rateLimiter.test.js
// เทส rate limiter (ใช้ Queue 2 ระดับ): ลำดับ high ก่อน low, ข้ามงานที่ถูกยกเลิก, ไม่ยิงเกินโควตา/วินาที
// รันด้วย: node test/rateLimiter.test.js

import assert from "node:assert/strict";
import { RateLimiter } from "../lib/rateLimiter.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err.message}`);
    failed += 1;
  }
}

console.log("\n=== lib/rateLimiter.js ===");

await test("งาน high ได้ไปก่อนงาน low ที่เข้าคิวก่อนหน้า (แต่ละระดับยัง FIFO)", async () => {
  const limiter = new RateLimiter({ perSecond: 1, perMinute: 100, safetyMarginMs: 0 });
  const order = [];
  const job = (label) => async () => order.push(label);
  // ตัวแรกยิงทันที ที่เหลือต้องรอโควตา → ระหว่างรอ งาน high ที่มาทีหลังต้องลัดหน้า low
  const all = [
    limiter.enqueue(job("low-1"), { priority: "low" }),
    limiter.enqueue(job("low-2"), { priority: "low" }),
    limiter.enqueue(job("high-1"), { priority: "high" }),
    limiter.enqueue(job("high-2"), { priority: "high" }),
  ];
  await Promise.all(all);
  assert.deepEqual(order, ["low-1", "high-1", "high-2", "low-2"]);
});

await test("งานที่ถูกยกเลิกก่อนถึงคิวจะไม่ถูกยิง และไม่กินโควตา", async () => {
  const limiter = new RateLimiter({ perSecond: 2, perMinute: 100, safetyMarginMs: 0 });
  let ran = 0;
  const job = async () => {
    ran += 1;
  };
  const cancelled = limiter.enqueue(job, { isCancelled: () => true });
  await assert.rejects(cancelled, (err) => err.name === "AbortError");
  await limiter.enqueue(job);
  await limiter.enqueue(job);
  assert.equal(ran, 2, "ต้องรันเฉพาะ 2 งานที่ไม่ถูกยกเลิก");
  assert.equal(limiter.recentTimestamps.size, 2, "งานที่ถูกยกเลิกต้องไม่ถูกนับเป็นการยิง");
});

await test("ไม่ยิงเกิน perSecond ภายใน 1 วินาที", async () => {
  const limiter = new RateLimiter({ perSecond: 3, perMinute: 100, safetyMarginMs: 20 });
  const startedAt = [];
  const job = async () => startedAt.push(Date.now());
  await Promise.all(Array.from({ length: 5 }, () => limiter.enqueue(job)));
  for (let i = 3; i < startedAt.length; i++) {
    assert.ok(startedAt[i] - startedAt[i - 3] >= 1000, `request ที่ ${i + 1} ห่างจากตัวที่ ${i - 2} ไม่ถึง 1 วินาที`);
  }
});

await test("งาน low ใช้โควตาได้ไม่เกิน lowPriorityPerMinute ส่วนที่เหลือกันไว้ให้งาน high", async () => {
  const limiter = new RateLimiter({ perSecond: 100, perMinute: 5, lowPriorityPerMinute: 3, safetyMarginMs: 0 });
  const ran = [];
  const job = (label) => async () => ran.push(label);
  // low 4 งาน: 3 งานแรกได้ยิง งานที่ 4 ต้องรอ (ชน cap ของ low) — จึงไม่ await งานที่ 4
  for (let i = 1; i <= 3; i++) await limiter.enqueue(job(`low-${i}`), { priority: "low" });
  limiter.enqueue(job("low-4"), { priority: "low" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ran, ["low-1", "low-2", "low-3"], "low ตัวที่ 4 ต้องยังไม่ได้ยิง");
  // งาน high ยังมีที่เหลือ (5 - 3 = 2 ช่อง) ต้องได้ยิงทันทีแม้ low ยังรออยู่
  await limiter.enqueue(job("high-1"));
  await limiter.enqueue(job("high-2"));
  assert.deepEqual(ran, ["low-1", "low-2", "low-3", "high-1", "high-2"]);
});

await test("error ของงานหนึ่งไม่ทำให้งานอื่นในคิวล้มตาม", async () => {
  const limiter = new RateLimiter({ perSecond: 10, perMinute: 100, safetyMarginMs: 0 });
  const bad = limiter.enqueue(async () => {
    throw new Error("boom");
  });
  const good = limiter.enqueue(async () => "ok");
  await assert.rejects(bad, /boom/);
  assert.equal(await good, "ok");
});

console.log(`\n=== สรุป: ${passed} ผ่าน, ${failed} ล้มเหลว ===\n`);
// ต้องสั่งจบเอง: เทส cap ของงาน low ตั้งใจทิ้งงานที่รอโควตาไว้ 1 งาน ซึ่งจะรอต่ออีกเกือบนาที
process.exit(failed > 0 ? 1 : 0);
