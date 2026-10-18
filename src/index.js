/**
 * hyper-atomic-log
 * =================
 * A lock‑free, persistent circular log built on top of SharedArrayBuffer and Atomics.
 *
 * @module hyper-atomic-log
 */

import { openSync, writeSync, readSync, fstatSync, closeSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

/**
 * Header layout (bytes):
 * 0 - 3   : uint32 - capacity (total usable bytes for entries)
 * 4 - 7   : uint32 - head index (write pointer)
 * 8 - 11  : uint32 - tail index (read pointer)
 */
const HEADER_SIZE = 12;

/**
 * PersistentAtomicLog
 * -------------------
 *
 * @class
 */
export class PersistentAtomicLog {
  /**
   * Create a new log.
   * @param {number} capacity - Maximum number of bytes for entry payloads.
   * @param {string} filePath - Path to the backing file for durability.
   */
  constructor(capacity, filePath) {
    if (capacity <= 0) throw new RangeError('capacity must be > 0');
    this.capacity = capacity;
    this.filePath = filePath;
    // Allocate a SharedArrayBuffer that holds header + payload area.
    this.buffer = new SharedArrayBuffer(HEADER_SIZE + capacity);
    this.view = new Uint8Array(this.buffer);
    // Typed view for atomic indices.
    this.u32 = new Uint32Array(this.buffer, 0, HEADER_SIZE / 4);
    // Initialise header if first time.
    if (Atomics.load(this.u32, 0) === 0) {
      Atomics.store(this.u32, 0, capacity);
      Atomics.store(this.u32, 1, 0); // head
      Atomics.store(this.u32, 2, 0); // tail
    }
    // Open file descriptor for persistence.
    this.fd = openSync(this.filePath, 'a+');
  }

  /**
   * Append a binary entry to the log.
   * The entry is stored as: [uint32 length][payload...]
   *
   * @param {Uint8Array} data - Payload to store.
   * @returns {boolean} true if the entry was written, false if insufficient space.
   */
  append(data) {
    const len = data.length;
    if (len > 0xffffffff) throw new RangeError('entry too large');
    const total = 4 + len; // length prefix + payload
    const capacity = Atomics.load(this.u32, 0);
    let head = Atomics.load(this.u32, 1);
    const tail = Atomics.load(this.u32, 2);
    const free = head >= tail ? capacity - (head - tail) : tail - head;
    if (total > free) return false; // not enough space
    // Write length (little‑endian)
    const dv = new DataView(this.buffer, HEADER_SIZE + head, total);
    dv.setUint32(0, len, true);
    // Write payload
    new Uint8Array(this.buffer, HEADER_SIZE + head + 4, len).set(data);
    // Advance head atomically (wrap around)
    const newHead = (head + total) % capacity;
    Atomics.store(this.u32, 1, newHead);
    // Notify potential readers.
    Atomics.notify(this.u32, 2, 1);
    return true;
  }

  /**
   * Consume entries from the log.
   * The callback receives a Uint8Array for each entry.
   *
   * @param {(entry: Uint8Array) => void} cb
   */
  consume(cb) {
    const capacity = Atomics.load(this.u32, 0);
    let tail = Atomics.load(this.u32, 2);
    const head = Atomics.load(this.u32, 1);
    while (tail !== head) {
      const dv = new DataView(this.buffer, HEADER_SIZE + tail, 4);
      const len = dv.getUint32(0, true);
      const payload = new Uint8Array(this.buffer, HEADER_SIZE + tail + 4, len);
      cb(payload.slice()); // slice to detach from shared memory
      tail = (tail + 4 + len) % capacity;
    }
    Atomics.store(this.u32, 2, tail);
  }

  /**
   * Flush the entire buffer (header + payload) to the backing file.
   * This is a best‑effort operation; callers should handle errors.
   */
  flush() {
    const totalSize = HEADER_SIZE + this.capacity;
    const tmp = Buffer.from(this.buffer);
    writeSync(this.fd, tmp, 0, totalSize, 0);
    // Ensure durability on POSIX systems.
    try { fsyncSync(this.fd); } catch (_) {}
  }

  /**
   * Close the underlying file descriptor.
   */
  close() {
    closeSync(this.fd);
  }
}

/**
 * CLI – simple tail‑like viewer.
 * Usage: node -e "import { PersistentAtomicLog } from './src/index.js'; new PersistentAtomicLog(1024, './log.bin').consume(e=>process.stdout.write(e.toString()+"\n"));"
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, sizeArg, fileArg] = process.argv;
  const size = Number(sizeArg) || 1024 * 1024;
  const file = fileArg || './hyper-atomic-log.bin';
  const log = new PersistentAtomicLog(size, file);
  log.consume(entry => {
    process.stdout.write(entry.toString() + '\n');
  });
  log.close();
}
