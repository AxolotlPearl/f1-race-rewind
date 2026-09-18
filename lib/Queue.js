// lib/Queue.js
// Queue เขียนเอง: array ธรรมดาเป็นที่เก็บ + head/tail เป็นตัวชี้ตำแหน่ง (circular buffer)
// ห้ามใช้ linked list, ห้ามใช้ array.shift() เป็น dequeue (shift() คือ O(n) ต้องขยับทุกตัว)
//
// ใช้ที่ไหนบ้าง (lib/rateLimiter.js):
// 1) taskQueue: คิวของ request ที่รอยิงไป OpenF1 API เรียงตามลำดับที่ขอเข้ามา (FIFO)
// 2) timestampWindow: เก็บเวลาที่ยิง request ล่าสุด ๆ เพื่อเช็ค sliding window (3 req/s, 30 req/min)
//    ต้อง dequeue timestamp ที่หมดอายุออกจากหน้าคิวบ่อย ๆ ถ้าใช้ shift() จะเป็น O(n) ทุกครั้ง
//    ที่ trim หน้าคิว ส่วน dequeue ของเราเป็น O(1) เสมอ

const DEFAULT_CAPACITY = 8;

export class Queue {
  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.buffer = new Array(this.capacity);
    this.head = 0; // ตำแหน่งของสมาชิกตัวแรก (จะ dequeue ต่อไป)
    this.tail = 0; // ตำแหน่งว่างถัดไปที่จะ enqueue
    this.count = 0;
  }

  get size() {
    return this.count;
  }

  isEmpty() {
    return this.count === 0;
  }

  isFull() {
    return this.count === this.capacity;
  }

  /**
   * enqueue - เติมสมาชิกเข้าท้ายคิว ถ้าคิวเต็มจะขยาย buffer เป็น 2 เท่าก่อน (rare, amortized O(1))
   * Time complexity: O(1) amortized (ปกติ O(1), นาน ๆ ครั้งที่ resize จะเป็น O(n))
   */
  enqueue(item) {
    if (this.isFull()) {
      this._resize(this.capacity * 2);
    }
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    this.count += 1;
  }

  /**
   * dequeue - เอาสมาชิกหน้าคิวออกแล้วคืนค่ากลับมา คืน undefined ถ้าคิวว่าง
   * Time complexity: O(1) เสมอ (ต่างจาก array.shift() ที่เป็น O(n))
   */
  dequeue() {
    if (this.isEmpty()) return undefined;
    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count -= 1;
    return item;
  }

  /** peek - ดูสมาชิกหน้าคิวโดยไม่เอาออก. Time complexity: O(1) */
  peek() {
    if (this.isEmpty()) return undefined;
    return this.buffer[this.head];
  }

  /**
   * _resize - ขยาย capacity แล้วเรียงสมาชิกเดิมใหม่ตั้งแต่ index 0 (head=0, tail=count)
   * Time complexity: O(n)
   */
  _resize(newCapacity) {
    const newBuffer = new Array(newCapacity);
    for (let i = 0; i < this.count; i++) {
      newBuffer[i] = this.buffer[(this.head + i) % this.capacity];
    }
    this.buffer = newBuffer;
    this.capacity = newCapacity;
    this.head = 0;
    this.tail = this.count;
  }

  /** toArray - คืน array ของสมาชิกทั้งหมดตามลำดับหน้า->หลัง (ใช้เพื่อ debug/ตรวจสอบ). Time complexity: O(n) */
  toArray() {
    const result = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buffer[(this.head + i) % this.capacity]);
    }
    return result;
  }
}
