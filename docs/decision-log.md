# Decision Log — F1 Race Rewind

เอกสารนี้ตอบ 3 คำถามตามที่ใบงานกำหนด: ทำไมเลือก DSA แต่ละตัวเพื่อแก้ปัญหา UX อะไร,
ถ้าไม่ใช้จะเสีย UX อย่างไร, และทำไม implement เองแทนของสำเร็จรูปในภาษา

## 1. Merge sort + pairwise merge ([lib/sort.js](../lib/sort.js))

**(ก) แก้ปัญหา UX อะไร**
ปุ่ม "เรียง: ตามเวลา / ตามรอบ / ตามนักขับ" ในไทม์ไลน์ ([public/app.js](../public/app.js))
ต้องตอบสนอง**ทันที**และ**ไม่ยิง API ใหม่** ([ข้อกำหนด UX](../public/app.js) — "ทุกการกรอง/เรียงต้องตอบสนองทันที")
เพราะข้อมูล event ทั้งหมดถูกโหลดมาแล้วครั้งเดียวตอนเลือกเรซ การสลับมุมมองการเรียงจึงต้องทำใน
memory ล้วน ๆ ด้วย compare function คนละตัว (เวลา/รอบ/ชื่อนักขับ) โดยไม่กระทบข้อมูลต้นฉบับ
(คืน array ใหม่เสมอ ไม่ mutate)

อีกที่หนึ่งที่ใช้จริงคือ server ตอนรวม event จาก 3 endpoint (`overtakes`, `pit`, `race_control`)
เป็นไทม์ไลน์เดียว ([lib/timeline.js](../lib/timeline.js)) — แต่ละ endpoint ส่งข้อมูลมาไม่เรียงรวมกัน
ต้อง merge ให้เป็นลำดับเวลาเดียวก่อนส่งให้ frontend ตามที่ route `/api/race/:sessionKey`
สัญญาไว้ว่าจะ "merge เป็นไทม์ไลน์เดียวเรียงตามเวลา"

**(ข) ถ้าไม่ใช้จะเสีย UX อย่างไร**
ถ้าไม่ implement เอง ทางเลือกที่เหลือคือยิง API ใหม่ทุกครั้งที่เปลี่ยนมุมมองการเรียง (ช้า มี
loading state โผล่มาขัดจังหวะ ผิดข้อกำหนด UX โดยตรง) หรือให้ server เตรียมไว้แค่ลำดับเดียว
(เช่น ตามเวลา) แล้วให้ผู้ใช้เรียงเองไม่ได้เลย ซึ่งเสียฟีเจอร์ที่ใบงานกำหนดไปทั้งปุ่ม

**(ค) ทำไม implement เองแทน `Array.prototype.sort()`**
ข้อบังคับของใบงานห้ามใช้ `.sort()` โดยตรง แต่เหตุผลเชิงวิศวกรรมที่สนับสนุนคือ: การรวม 3
แหล่งข้อมูลที่ "เรียงแล้วแต่ละแหล่ง" เข้าด้วยกัน ใช้ประโยชน์จาก merge step ของ merge sort ได้
ตรงตัว (`merge(a, b)` ที่ทั้ง a, b เรียงแล้ว = O(n+m)) เร็วกว่าการโยนทุกอย่างรวมกันแล้วเรียกลำดับ
ใหม่ทั้งหมด (`O(n log n)` ของทั้งชุด) และเพราะใบงานกำหนดให้ merge ทีละคู่โดยห้ามใช้ heap/priority
queue เราจึงใช้ `mergePairwise` (reduce แบบ merge สองตัวไปเรื่อย ๆ) ตรงตามข้อกำหนด

## 2. HashTable แบบ chaining ([lib/HashTable.js](../lib/HashTable.js))

**(ก) แก้ปัญหา UX อะไร**
มี 3 จุดที่ต้อง "หาข้อมูลจาก key ให้เร็ว" ซ้ำ ๆ เป็นจำนวนมากในเส้นทางที่ผู้ใช้รอผลอยู่:
1. Server: enrich ทุก event (สูงสุดหลายร้อยตัวต่อเรซ) ด้วยชื่อ/ทีม/สีทีมของนักขับ โดย lookup
   จาก `driver_number` ([lib/timeline.js](../lib/timeline.js) — `buildDriverLookup`)
2. Server: lookup ข้อมูลสนามจาก `meeting_key` ตอนสร้างรายชื่อเรซในดรอปดาวน์
   ([api/index.js](../api/index.js))
3. Client: ตอนคลิกนักขับคนหนึ่งเพื่อไฮไลต์ ([public/app.js](../public/app.js) —
   `buildDriverEventIndex` / `applyHighlight`) ต้องรู้ทันทีว่าการ์ดไหนเกี่ยวกับนักขับคนนั้นบ้าง
   เพื่อ toggle class `highlighted`/`dimmed` ให้ทุกการ์ด — อินเทอร์แอกชันนี้ต้องรู้สึก "ทันที"
   ตามข้อกำหนด UX

**(ข) ถ้าไม่ใช้จะเสีย UX อย่างไร**
ถ้า lookup ด้วย `array.find()` ทุกครั้ง จุดที่ 1 จะกลายเป็น O(events × drivers) ต่อเรซหนึ่งครั้ง
(เรซที่มี event ~500 ตัว × นักขับ 20 คน = 10,000 การเทียบ) ซึ่งแม้จะยังพอไหวสำหรับเรซเดียว แต่
จุดที่ 3 (คลิกนักขับ) ต้องทำซ้ำทุกครั้งที่คลิก ถ้าใช้ `array.includes()` แทนการเช็ค hash table
จะกลายเป็น O(n×k) ต่อคลิกหนึ่งครั้ง (n = จำนวนการ์ดทั้งหมด, k = จำนวน event ของนักขับคนนั้น)
ผู้ใช้จะรู้สึกว่าคลิกแล้วหน่วงเมื่อเรซมี event เยอะ (พบจริงว่าบางเรซมี overtake เกือบ 400 ครั้ง)

**(ค) ทำไม implement เองแทน `Map`/`Set`/object**
ข้อบังคับใบงานห้ามใช้ `Map`/`Set`/plain object เป็นโครงสร้างหลัก แต่เหตุผลที่ทำให้เข้าใจ trade-off
จริงคือ: การเขียน hash function เอง (djb2-based) และ chaining เอง ทำให้เห็นชัดว่า collision
handling และ load-factor resize ทำงานอย่างไรจริง ๆ (ต่างจาก `Map` ที่ซ่อน implementation ไว้)
และยังคงได้ average-case O(1) เท่ากันถ้า hash กระจายดีและ resize ทำงานถูกต้อง

## 3. Queue แบบ circular buffer + rate limiter ([lib/Queue.js](../lib/Queue.js), [lib/rateLimiter.js](../lib/rateLimiter.js))

**(ก) แก้ปัญหา UX อะไร**
OpenF1 จำกัด 3 req/s และ 30 req/min แต่หน้าเว็บต้องยิงพร้อมกันหลาย endpoint ในคำขอเดียว (เช่น
`/api/race/:sessionKey` ยิง drivers+overtakes+pit+race_control+session_result พร้อมกันด้วย
`Promise.all`) ถ้าไม่มีตัวคุมจังหวะ จะโดน 429 กลับมาเป็น error state ทำให้ผู้ใช้เห็นหน้าเว็บพัง
ทั้งที่ควรจะเห็นข้อมูลเรซของตัวเองโหลดสำเร็จ Queue ถูกใช้ 2 จุดใน rate limiter:
1. `taskQueue` — คิว FIFO ของ request ที่รอส่ง เรียงตามลำดับที่ขอเข้ามาจริง
2. `recentTimestamps` — sliding window ของเวลาที่ยิงไปแล้วภายใน 60 วินาทีล่าสุด ต้อง dequeue
   timestamp ที่หมดอายุออกจากหน้าคิวบ่อย ๆ (ทุกครั้งที่จะยิง request ใหม่)

**(ข) ถ้าไม่ใช้จะเสีย UX อย่างไร**
ไม่มี queue = ไม่มีลำดับ FIFO ที่ชัดเจนสำหรับ request ที่รอ ทำให้ยากจะการันตีว่า request ไหนถูก
ส่งก่อนตามลำดับที่ผู้ใช้ขอ และถ้าใช้ `array.shift()` แทนการ dequeue ของเราในจุดที่ 2 (ต้อง trim
timestamp ที่หมดอายุทุกครั้งก่อนยิง request ใหม่ — เกิดขึ้นบ่อยมาก เพราะจำกัดแค่ 3 req/s) จะเป็น
O(n) ทุกครั้งที่ trim ต่างจาก dequeue ของเราที่เป็น O(1) เสมอ แม้ n จะเล็ก (สูงสุด 30) ก็ยังเป็น
การขยับ array ที่ไม่จำเป็นซ้ำ ๆ หลายพันครั้งตลอดอายุการทำงานของ serverless function

**(ค) ทำไม implement เองแทน linked list หรือ array + shift()**
ข้อบังคับใบงาน (แก้ไขแล้ว) กำหนดให้ใช้ array ธรรมดา + head/tail pointer แบบ circular buffer
โดยห้าม linked list (ยังไม่ได้เรียน) และห้าม `shift()` เพราะเป็น O(n) เหตุผลเชิงวิศวกรรมที่สนับสนุน
คือ circular buffer ให้ enqueue/dequeue เป็น O(1) แท้จริงโดยไม่ต้องมี pointer/node แยกแต่ละตัว
(ซึ่งซับซ้อนกว่าที่จำเป็นสำหรับ FIFO queue ง่าย ๆ แบบนี้) แลกมาด้วยความซับซ้อนเพิ่มขึ้นเล็กน้อยตอน
ต้อง resize (ขยาย array เป็น 2 เท่าแล้วจัดเรียง index ใหม่ให้ head=0) ซึ่งเกิดขึ้นไม่บ่อย (amortized O(1))

## บันทึกเพิ่มเติม: ปัญหาจาก API จริงที่พบระหว่างพัฒนา

- `/pit` ตอบ HTTP 404 (ไม่ใช่ array ว่าง) เมื่อไม่มีข้อมูล — ต้อง treat เป็น "ไม่มีข้อมูล" ใน
  `lib/openf1.js` ไม่ใช่ throw error ไม่งั้น empty state ที่ตั้งใจทำจะกลายเป็น error state ผิด ๆ
- `team_colour` ไม่คงที่ตัวใหญ่/เล็กระหว่างปี (2023 ตัวใหญ่, 2024 ตัวเล็ก) — normalize เป็น
  lowercase เสมอใน `buildDriverLookup`
- `/overtakes` ไม่มี field `lap_number` (มีแค่ `position`) ต่างจาก `/pit` และ `/race_control` ที่มี
  — ประมาณค่ารอบของ overtake จาก lap marker ที่ใกล้ที่สุดก่อนหน้า (ดู `estimateLap` ใน
  `lib/timeline.js`) และ flag ค่านี้ว่าเป็นค่าประมาณ (`lapIsEstimated: true`) ไม่ใช่ค่าจริงจาก API
- `session_type=Race` ใน `/sessions` ครอบคลุมทั้ง session ชื่อ "Race" และ "Sprint" (สุดสัปดาห์
  sprint มี 2 session ที่ track เดียวกัน) — ต้องส่ง `session_name` แยกให้ dropdown แสดงต่างกันได้
  ไม่งั้นผู้ใช้จะเห็นตัวเลือกซ้ำหน้ากันโดยไม่รู้ว่าอันไหนคืออะไร
- rate limit ของ OpenF1 เป็น resource กลางที่ผู้ใช้คนอื่นบนอินเทอร์เน็ตแชร์ด้วย ต่อให้ scheduler
  ฝั่งเราคุมจังหวะถูกต้องตามทฤษฎีแล้ว ก็ยังมีโอกาสเจอ 429 ได้จาก jitter จึงเพิ่ม retry-with-backoff
  ใน `lib/openf1.js` เป็นเกราะป้องกันอีกชั้น ไม่ใช่พึ่ง scheduler ฝั่งเราอย่างเดียว
