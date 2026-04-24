import { MongoClient, type Db } from 'mongodb';

let db: Db | null = null;

export async function connectMongo(uri: string, dbName: string): Promise<Db> {
  if (db) {
    return db;
  }

  const client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  return db;
}

export function getDb(): Db {
  if (!db) {
    throw new Error('Mongo not connected');
  }

  return db;
}

export function __setDbForTest(testDb: Db) {
  db = testDb;
}

export function __resetDbForTest() {
  db = null;
}
