const globalForLocks = globalThis as unknown as { __plumbLocks?: Map<string, Promise<unknown>> };
const locks = (globalForLocks.__plumbLocks ??= new Map());

/** Runs jobs for one key strictly in order, so batches can't interleave their writes. */
export function withTableLock<T>(key: string, job: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(job, job);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}
