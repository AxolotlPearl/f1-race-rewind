// lib/HashTable.js
// Hash table เขียนเอง: array เป็น bucket + hash function เอง + collision จัดการด้วย chaining
// ห้ามใช้ Map/Set/plain object เป็นโครงสร้างหลักตามกฎของใบงาน
//
// ใช้ที่ไหนบ้าง:
// 1) lib/timeline.js: driver_number -> ข้อมูลนักขับ (ชื่อ/ทีม/สีทีม) เพื่อ enrich แต่ละ event
//    แบบ O(1) เฉลี่ย ถ้าใช้ .find() ทุก event จะเป็น O(events * drivers)
// 2) api/index.js: meeting_key -> ข้อมูลสนาม (ชื่อ circuit) ตอนสร้างรายชื่อเรซ
// 3) public/app.js (client): driver_number -> รายการ index ของ event ที่นักขับคนนั้นเกี่ยวข้อง
//    เพื่อคลิกนักขับแล้วไฮไลต์/ทำให้จางแบบ O(k) ไม่ต้องวนทุก event ทุกครั้งที่คลิก

/**
 * hashString - แปลง string เป็นเลข hash (แนว djb2)
 * Time complexity: O(L) โดย L คือความยาวของ string key
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // hash * 33 + charCode, เก็บให้อยู่ในช่วง 32-bit signed ด้วย bitwise OR 0
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0; // แปลงเป็น unsigned 32-bit
}

const DEFAULT_CAPACITY = 16;
const LOAD_FACTOR_THRESHOLD = 0.75;

export class HashTable {
  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    // แต่ละ bucket คือ array ของคู่ [key, value] (chaining)
    this.buckets = new Array(this.capacity).fill(null).map(() => []);
    this.count = 0;
  }

  /** Time complexity: O(1) โดยประมาณ (ไม่นับเวลา hash string ซึ่ง O(L)) */
  _indexFor(key) {
    return hashString(String(key)) % this.capacity;
  }

  /**
   * set - ใส่หรืออัปเดตค่า
   * Time complexity เฉลี่ย: O(1) (บวก O(L) ของการ hash key)
   * Worst case: O(n) ถ้าทุก key ชนกันที่ bucket เดียว (ไม่ควรเกิดถ้า hash กระจายดี)
   */
  set(key, value) {
    if (this.count + 1 > this.capacity * LOAD_FACTOR_THRESHOLD) {
      this._resize(this.capacity * 2);
    }
    const index = this._indexFor(key);
    const bucket = this.buckets[index];
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i][0] === key) {
        bucket[i][1] = value;
        return;
      }
    }
    bucket.push([key, value]);
    this.count += 1;
  }

  /** get - ดึงค่า คืน undefined ถ้าไม่มี key นี้. Time complexity เฉลี่ย: O(1), worst case O(n) */
  get(key) {
    const bucket = this.buckets[this._indexFor(key)];
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i][0] === key) return bucket[i][1];
    }
    return undefined;
  }

  /** has - เช็คว่ามี key อยู่หรือไม่. Time complexity เฉลี่ย: O(1) */
  has(key) {
    const bucket = this.buckets[this._indexFor(key)];
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i][0] === key) return true;
    }
    return false;
  }

  /** delete - ลบ key ออก คืน true ถ้าลบสำเร็จ. Time complexity เฉลี่ย: O(1) */
  delete(key) {
    const bucket = this.buckets[this._indexFor(key)];
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i][0] === key) {
        bucket.splice(i, 1);
        this.count -= 1;
        return true;
      }
    }
    return false;
  }

  /** _resize - ขยาย capacity แล้ว rehash ทุก entry ใหม่. Time complexity: O(n) */
  _resize(newCapacity) {
    const oldBuckets = this.buckets;
    this.capacity = newCapacity;
    this.buckets = new Array(this.capacity).fill(null).map(() => []);
    this.count = 0;
    for (const bucket of oldBuckets) {
      for (const [key, value] of bucket) {
        this.set(key, value);
      }
    }
  }

  /** keys - คืน array ของทุก key. Time complexity: O(n) */
  keys() {
    const result = [];
    for (const bucket of this.buckets) {
      for (const [key] of bucket) result.push(key);
    }
    return result;
  }

  /** values - คืน array ของทุก value. Time complexity: O(n) */
  values() {
    const result = [];
    for (const bucket of this.buckets) {
      for (const [, value] of bucket) result.push(value);
    }
    return result;
  }

  get size() {
    return this.count;
  }
}
