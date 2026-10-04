// test/dsa.test.js
// เทสพิสูจน์ว่า sort/hash/queue ที่เขียนเองทำงานถูก รวมเคส collision และ queue เต็ม/ว่าง
// รันด้วย: npm test  (หรือ node test/dsa.test.js)

import assert from "node:assert/strict";
import { merge, mergeSort, mergePairwise } from "../lib/sort.js";
import { HashTable } from "../lib/HashTable.js";
import { Queue } from "../lib/Queue.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err.message}`);
    failed += 1;
  }
}

const numCompare = (a, b) => a - b;

console.log("\n=== lib/sort.js ===");

test("mergeSort เรียง array ตัวเลขธรรมดา", () => {
  const input = [5, 3, 8, 1, 9, 2];
  const result = mergeSort(input, numCompare);
  assert.deepEqual(result, [1, 2, 3, 5, 8, 9]);
  assert.deepEqual(input, [5, 3, 8, 1, 9, 2], "ต้นฉบับต้องไม่ถูกแก้ไข");
});

test("mergeSort กับ array ว่างและ array 1 ตัว", () => {
  assert.deepEqual(mergeSort([], numCompare), []);
  assert.deepEqual(mergeSort([42], numCompare), [42]);
});

test("mergeSort กับ array ที่มีค่าซ้ำ", () => {
  const result = mergeSort([3, 1, 3, 2, 1], numCompare);
  assert.deepEqual(result, [1, 1, 2, 3, 3]);
});

test("mergeSort เรียงย้อนกลับได้ (compareFn กลับด้าน)", () => {
  const result = mergeSort([1, 2, 3, 4], (a, b) => b - a);
  assert.deepEqual(result, [4, 3, 2, 1]);
});

test("merge รวม 2 array ที่เรียงแล้วให้เป็น array เดียวที่เรียงแล้ว", () => {
  const result = merge([1, 3, 5], [2, 4, 6], numCompare);
  assert.deepEqual(result, [1, 2, 3, 4, 5, 6]);
});

test("mergePairwise รวมหลาย array ทีละคู่ให้เรียงถูกทั้งหมด", () => {
  const a = mergeSort([9, 1, 5], numCompare);
  const b = mergeSort([8, 2], numCompare);
  const c = mergeSort([7, 3, 4, 6], numCompare);
  const result = mergePairwise([a, b, c], numCompare);
  assert.deepEqual(result, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("mergePairwise กับ array ว่างบางตัวไม่พัง", () => {
  const result = mergePairwise([[], [1, 2], [], [3]], numCompare);
  assert.deepEqual(result, [1, 2, 3]);
});

test("mergePairwise กับทุก array ว่างคืน []", () => {
  assert.deepEqual(mergePairwise([[], []], numCompare), []);
});

test("mergeSort เรียง object ตาม field ได้ (ใช้จริงกับ event ที่มี date)", () => {
  const events = [
    { date: "2024-01-01T00:00:03Z", name: "c" },
    { date: "2024-01-01T00:00:01Z", name: "a" },
    { date: "2024-01-01T00:00:02Z", name: "b" },
  ];
  const result = mergeSort(events, (a, b) => new Date(a.date) - new Date(b.date));
  assert.deepEqual(result.map((e) => e.name), ["a", "b", "c"]);
});

console.log("\n=== lib/HashTable.js ===");

test("set/get พื้นฐาน", () => {
  const ht = new HashTable();
  ht.set("VER", { team: "Red Bull" });
  ht.set("HAM", { team: "Mercedes" });
  assert.deepEqual(ht.get("VER"), { team: "Red Bull" });
  assert.deepEqual(ht.get("HAM"), { team: "Mercedes" });
  assert.equal(ht.get("NOPE"), undefined);
});

test("set ทับ key เดิมต้องอัปเดตค่า ไม่เพิ่ม count", () => {
  const ht = new HashTable();
  ht.set("a", 1);
  ht.set("a", 2);
  assert.equal(ht.get("a"), 2);
  assert.equal(ht.size, 1);
});

test("has คืน true/false ถูกต้อง", () => {
  const ht = new HashTable();
  ht.set("x", 1);
  assert.equal(ht.has("x"), true);
  assert.equal(ht.has("y"), false);
});

test("delete ลบ key ออกและคืน true, ลบซ้ำคืน false", () => {
  const ht = new HashTable();
  ht.set("x", 1);
  assert.equal(ht.delete("x"), true);
  assert.equal(ht.has("x"), false);
  assert.equal(ht.delete("x"), false);
});

test("จัดการ collision ด้วย chaining ได้ถูกต้อง (บังคับให้ชนกันด้วย capacity=1)", () => {
  // capacity=1 แปลว่าทุก key ต้องตกลง bucket เดียวกันหมด (index 0) บังคับชนแน่นอน
  const ht = new HashTable(1);
  ht.set("a", "value-a");
  ht.set("b", "value-b");
  ht.set("c", "value-c");
  assert.equal(ht.get("a"), "value-a");
  assert.equal(ht.get("b"), "value-b");
  assert.equal(ht.get("c"), "value-c");
  assert.equal(ht.size, 3);
});

test("resize อัตโนมัติเมื่อ load factor เกิน threshold ยังคง get ค่าเดิมได้ถูกต้อง", () => {
  const ht = new HashTable(4); // capacity เล็ก บังคับให้ resize เร็ว
  for (let i = 0; i < 50; i++) {
    ht.set(`key-${i}`, i);
  }
  assert.equal(ht.size, 50);
  for (let i = 0; i < 50; i++) {
    assert.equal(ht.get(`key-${i}`), i);
  }
});

test("keys() และ values() คืนครบตามจำนวนที่ set", () => {
  const ht = new HashTable();
  ht.set("a", 1);
  ht.set("b", 2);
  assert.equal(ht.keys().length, 2);
  assert.equal(ht.values().length, 2);
  assert.ok(ht.keys().includes("a") && ht.keys().includes("b"));
});

console.log("\n=== lib/Queue.js ===");

test("enqueue/dequeue พื้นฐานตามลำดับ FIFO", () => {
  const q = new Queue();
  q.enqueue(1);
  q.enqueue(2);
  q.enqueue(3);
  assert.equal(q.dequeue(), 1);
  assert.equal(q.dequeue(), 2);
  assert.equal(q.dequeue(), 3);
});

test("dequeue คิวว่างคืน undefined ไม่ throw", () => {
  const q = new Queue();
  assert.equal(q.dequeue(), undefined);
  assert.equal(q.isEmpty(), true);
});

test("isFull ทำงานถูกและ enqueue เกิน capacity ต้อง resize อัตโนมัติโดยไม่เสียข้อมูล", () => {
  const q = new Queue(2);
  q.enqueue("a");
  q.enqueue("b");
  assert.equal(q.isFull(), true);
  q.enqueue("c"); // ต้อง resize
  assert.equal(q.size, 3);
  assert.deepEqual(q.toArray(), ["a", "b", "c"]);
});

test("wrap-around: dequeue แล้ว enqueue ใหม่ต้องวนกลับมาที่ index 0 ถูกต้อง", () => {
  const q = new Queue(3);
  q.enqueue(1);
  q.enqueue(2);
  q.enqueue(3); // เต็ม, tail กลับมาที่ 0 แล้ว (ไม่ resize เพราะเพิ่งเต็มพอดี ยังไม่เกิน)
  assert.equal(q.dequeue(), 1); // head เลื่อนไป 1
  q.enqueue(4); // ต้องเขียนที่ index 0 (wrap) เพราะ capacity ยังพอ (count=3 -> isFull true ก่อน enqueue ต้อง resize)
  // capacity=3, count หลัง dequeue=2, isFull()=false ดังนั้น enqueue(4) ไม่ resize เขียนที่ index 0 ได้เลย
  assert.equal(q.size, 3);
  assert.deepEqual(q.toArray(), [2, 3, 4]);
});

test("peek ไม่เอาสมาชิกออกจากคิว", () => {
  const q = new Queue();
  q.enqueue("only");
  assert.equal(q.peek(), "only");
  assert.equal(q.size, 1);
  assert.equal(q.dequeue(), "only");
});

test("enqueue/dequeue สลับกันจำนวนมากต้องยังคงลำดับ FIFO ถูกต้อง (ทดสอบ wrap-around หลายรอบ)", () => {
  const q = new Queue(4);
  const expected = [];
  const output = [];
  for (let i = 0; i < 100; i++) {
    q.enqueue(i);
    expected.push(i);
    if (i % 3 === 0) {
      output.push(q.dequeue());
    }
  }
  while (!q.isEmpty()) {
    output.push(q.dequeue());
  }
  assert.deepEqual(output, expected);
});

test("at(i) อ่านสมาชิกตามลำดับจากหน้าคิวได้ถูก แม้ข้อมูลวนรอบ (wrap-around) ใน buffer แล้ว", () => {
  const q = new Queue(4);
  q.enqueue("a");
  q.enqueue("b");
  q.enqueue("c");
  q.dequeue(); // head ขยับไป index 1
  q.dequeue(); // head ขยับไป index 2
  q.enqueue("d");
  q.enqueue("e"); // e เขียนที่ index 0 (วนรอบแล้ว)
  assert.equal(q.at(0), "c");
  assert.equal(q.at(1), "d");
  assert.equal(q.at(2), "e");
  assert.equal(q.at(3), undefined, "เกินจำนวนสมาชิกต้องได้ undefined");
  assert.equal(q.at(-1), undefined);
  assert.equal(q.peekLast(), "e");
});

test("clear() ล้างคิวแล้วใช้ต่อได้ตามปกติ", () => {
  const q = new Queue(2);
  q.enqueue(1);
  q.enqueue(2);
  q.enqueue(3);
  q.clear();
  assert.equal(q.isEmpty(), true);
  assert.equal(q.dequeue(), undefined);
  assert.equal(q.peekLast(), undefined);
  q.enqueue(9);
  assert.equal(q.peek(), 9);
  assert.equal(q.size, 1);
});

console.log(`\n=== สรุป: ${passed} ผ่าน, ${failed} ล้มเหลว ===\n`);

if (failed > 0) {
  process.exit(1);
}
