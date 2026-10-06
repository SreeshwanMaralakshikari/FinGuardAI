// tests/helpers/dbAtomicity.js
// Tests that fire truly parallel requests at the SAME document and rely on the database's
// single-document atomicity (conditional findOneAndUpdate / $push). Real MongoDB (Atlas,
// mongodb-memory-server) guarantees it, so there they run for real. The FerretDB stand-in
// some sandboxes use (it reports `ferretdbVersion` in buildInfo) does not — it loses
// concurrent updates, the same limitation that fails the original AUD-05 test there — so on
// FerretDB `itAtomic` tests log a warning and return early. SKIP_ATOMICITY_TESTS=1 skips
// them explicitly. The same guarded logic is also covered deterministically, without real
// concurrency, by the "lost race (stale read)" tests next to each of them.
import { it } from '@jest/globals';
import mongoose from 'mongoose';

export const isEmulatedDb = async () => {
  try {
    const info = await mongoose.connection.db.admin().command({ buildInfo: 1 });
    return Boolean(info.ferretdbVersion);
  } catch {
    return false;
  }
};

export const itAtomic = (name, fn, timeout) => {
  if (process.env.SKIP_ATOMICITY_TESTS === '1') return it.skip(name, fn, timeout);
  return it(name, async () => {
    if (await isEmulatedDb()) {
      console.warn(`[atomicity] "${name}" was not run: FerretDB has no single-document atomicity. Run it on real MongoDB.`);
      return;
    }
    await fn();
  }, timeout);
};
