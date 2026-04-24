import { MongoClient } from 'mongodb';
import type { Database } from './adapter.js';
import { CloudBaseAdapter } from './cloudbase-adapter.js';
import { MongoAdapter } from './mongo-adapter.js';

let db: Database | null = null;

export async function connectMongo(uri: string, dbName: string): Promise<Database> {
  if (db) return db;
  const client = new MongoClient(uri);
  await client.connect();
  db = new MongoAdapter(client.db(dbName));
  return db;
}

export function connectCloudBase(envId: string): Database {
  if (db) return db;
  db = new CloudBaseAdapter(envId);
  return db;
}

export function getDb(): Database {
  if (!db) throw new Error('DB not connected');
  return db;
}

// tests only
export function __setDbForTest(impl: Database) {
  db = impl;
}
export function __resetDbForTest() {
  db = null;
}
