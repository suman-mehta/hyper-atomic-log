import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { PersistentAtomicLog } from '../src/index.js';
import { unlinkSync, existsSync } from 'node:fs';

const LOG_PATH = './tmp-hyper-atomic-log.bin';

function clean() {
  if (existsSync(LOG_PATH)) unlinkSync(LOG_PATH);
}

clean();

test('single‑thread append & consume', t => {
  const log = new PersistentAtomicLog(1024, LOG_PATH);
  const payload = Buffer.from('hello world');
  const ok = log.append(payload);
  assert.ok(ok, 'append should succeed');
  const collected = [];
  log.consume(entry => collected.push(entry.toString()));
  assert.deepEqual(collected, ['hello world']);
  log.flush();
  log.close();
});

test('concurrent workers produce entries without loss', async t => {
  const workers = 4;
  const entriesPerWorker = 250;
  const log = new PersistentAtomicLog(64 * 1024, LOG_PATH);

  const promises = [];
  for (let i = 0; i < workers; i++) {
    promises.push(new Promise((res, rej) => {
      const worker = new Worker(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { PersistentAtomicLog } from '${process.cwd().replace(/\\/g, '\\\\')}/src/index.js';
        const log = new PersistentAtomicLog(workerData.capacity, workerData.path);
        for (let j = 0; j < ${entriesPerWorker}; j++) {
          const msg = Buffer.from('w' + workerData.id + '-' + j);
          while (!log.append(msg)) {
            // spin until space is available
          }
        }
        parentPort.postMessage('done');
      `, { eval: true, workerData: { id: i, capacity: 64 * 1024, path: LOG_PATH } });
      worker.on('message', () => res());
      worker.on('error', err => rej(err));
    }));
  }

  await Promise.all(promises);

  // Give a tiny grace period for any pending writes.
  await new Promise(r => setTimeout(r, 100));

  const seen = new Set();
  log.consume(entry => seen.add(entry.toString()));
  assert.equal(seen.size, workers * entriesPerWorker, 'all entries should be present');
  log.close();
});
