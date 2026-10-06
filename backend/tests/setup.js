// tests/setup.js — database lifecycle shared by all integration tests.
// Uses MONGO_URI_TEST when set (e.g. a local mongod or a disposable Atlas
// database); otherwise starts an in-process mongodb-memory-server (D-P8-02).
//
// D-09 SAFETY: every helper below DELETES DATA (dropDatabase / deleteMany on every
// collection). They therefore refuse to run unless the database name contains
// "test", and never against the database named in MONGODB_URI (the application's
// real database). Pasting a production URI into MONGO_URI_TEST fails fast.
import mongoose from 'mongoose';
import { getMongoDbName } from '../config/mongoUri.js';

let mongod = null;

/**
 * Throws unless `dbName` is safe to wipe.
 * @param {string} dbName            database the tests are about to use
 * @param {string} [productionDbName] database named by MONGODB_URI, if any
 */
export function assertSafeTestDatabase(dbName, productionDbName = '') {
  if (!/test/i.test(dbName ?? '')) {
    throw new Error(
      `Refusing to run tests: database "${dbName}" does not contain "test". ` +
      'The test helpers drop the whole database. Use a name such as "finguardai_test" in MONGO_URI_TEST.'
    );
  }
  if (productionDbName && dbName === productionDbName) {
    throw new Error(
      `Refusing to run tests: "${dbName}" is the database named in MONGODB_URI. ` +
      'Point MONGO_URI_TEST at a separate, disposable database.'
    );
  }
}

const productionDbName = () => getMongoDbName(process.env.MONGODB_URI);

export async function connectTestDB() {
  if (mongoose.connection.readyState !== 0) return; // idempotent (C-P8-11)
  let uri = process.env.MONGO_URI_TEST;
  if (uri) {
    // Check the name BEFORE connecting. A URI without a database name makes the
    // driver use "test" — not acceptable here either: require it to be explicit.
    assertSafeTestDatabase(getMongoDbName(uri), productionDbName());
  } else {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongod = await MongoMemoryServer.create();
    uri = mongod.getUri();
  }
  await mongoose.connect(uri);
  try {
    assertSafeTestDatabase(mongoose.connection.name, productionDbName()); // authoritative: the name actually in use
  } catch (err) {
    await mongoose.disconnect();
    throw err;
  }
  await Promise.all(Object.values(mongoose.models).map((m) => m.init())); // build unique indexes before tests
}

export async function disconnectTestDB() {
  if (mongoose.connection.readyState === 0) return;
  assertSafeTestDatabase(mongoose.connection.name, productionDbName());
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (mongod) { await mongod.stop(); mongod = null; }
}

export async function clearCollections() {
  assertSafeTestDatabase(mongoose.connection.name, productionDbName());
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
}
