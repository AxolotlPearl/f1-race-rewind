// lib/sort.js
// Merge sort เขียนเอง — ห้ามใช้ Array.prototype.sort() ตามกฎของใบงาน
//
// ใช้ที่ไหนบ้าง:
// 1) ฝั่ง client (public/app.js): ปุ่มเรียง "ตามเวลา/ตามรอบ/ตามนักขับ" เรียก mergeSort ใหม่
//    ทุกครั้งด้วย compareFn ต่างกัน — ทำงานใน memory ไม่ยิง API ใหม่ ตอบสนองทันที
// 2) ฝั่ง server (lib/timeline.js): เรียงแต่ละ event source (overtakes/pit/race_control)
//    ตามเวลาก่อน แล้วส่งต่อให้ mergePairwise รวมเป็นไทม์ไลน์เดียว

/**
 * merge - รวม array ที่ "เรียงแล้วทั้งคู่" ให้เป็น array เดียวที่เรียงแล้ว
 * Time complexity: O(n + m) โดย n, m คือความยาวของ a, b
 * Space complexity: O(n + m)
 */
export function merge(a, b, compareFn) {
  const result = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;

  while (i < a.length && j < b.length) {
    if (compareFn(a[i], b[j]) <= 0) {
      result[k++] = a[i++];
    } else {
      result[k++] = b[j++];
    }
  }
  while (i < a.length) result[k++] = a[i++];
  while (j < b.length) result[k++] = b[j++];

  return result;
}

/**
 * mergeSort - เรียง array ด้วย merge sort (แบ่งครึ่งไปเรื่อย ๆ แล้ว merge กลับ)
 * Time complexity: O(n log n) ทุกกรณี (best/average/worst เท่ากันเพราะ merge sort ไม่ขึ้นกับ input order)
 * Space complexity: O(n) ต้องใช้ array ชั่วคราวตอน merge
 *
 * @param {Array} arr
 * @param {(a, b) => number} compareFn คืนค่า <0 ถ้า a ควรอยู่ก่อน b, >0 ถ้า b ควรอยู่ก่อน a, 0 ถ้าเท่ากัน
 * @returns {Array} array ใหม่ที่เรียงแล้ว (ไม่แก้ไข arr เดิม)
 */
export function mergeSort(arr, compareFn) {
  if (arr.length <= 1) return arr.slice();

  const mid = Math.floor(arr.length / 2);
  const left = mergeSort(arr.slice(0, mid), compareFn);
  const right = mergeSort(arr.slice(mid), compareFn);

  return merge(left, right, compareFn);
}

/**
 * mergePairwise - รวมหลาย array (แต่ละ array เรียงแล้ว) เป็น array เดียวที่เรียงแล้ว
 * โดย merge ทีละคู่ตามลำดับ: merge(A, B) = AB, merge(AB, C) = ABC, ...
 * ห้ามใช้ heap / priority queue ตามข้อกำหนดของใบงาน (ยังไม่ได้เรียน)
 *
 * Time complexity: ถ้ามี k arrays รวมกันมี n สมาชิกทั้งหมด จะ merge k-1 ครั้ง
 * ครั้งที่ i ต้อง merge array ที่ยาวขึ้นเรื่อย ๆ ทำให้ worst case เป็น O(n * k)
 * (แลกความง่ายของ implementation กับ performance เพราะ k เล็กมาก คือจำนวน endpoint ~3-4 ตัว)
 * Space complexity: O(n)
 *
 * @param {Array[]} arrays รายชื่อ array ที่แต่ละตัวเรียงแล้วตาม compareFn
 * @param {(a, b) => number} compareFn
 * @returns {Array}
 */
export function mergePairwise(arrays, compareFn) {
  const nonEmpty = arrays.filter((a) => a.length > 0);
  if (nonEmpty.length === 0) return [];

  let acc = nonEmpty[0];
  for (let i = 1; i < nonEmpty.length; i++) {
    acc = merge(acc, nonEmpty[i], compareFn);
  }
  return acc;
}
