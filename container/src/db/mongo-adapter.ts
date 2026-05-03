import type { Db } from 'mongodb';
import type { Database, DbCollection, DbDocument, FindOptions, UpdateOptions, UpdateSpec } from './adapter.js';

class MongoCollection implements DbCollection {
  constructor(private readonly db: Db, private readonly name: string) {}

  async findOne(filter: DbDocument): Promise<DbDocument | null> {
    const doc = await this.db.collection(this.name).findOne(filter);
    return (doc as DbDocument | null) ?? null;
  }

  async find(filter: DbDocument, options?: FindOptions): Promise<DbDocument[]> {
    let cursor = this.db.collection(this.name).find(filter);
    if (options?.sortBy) {
      cursor = cursor.sort({ [options.sortBy]: options.sortDir === 'asc' ? 1 : -1 });
    }
    if (options?.offset) cursor = cursor.skip(options.offset);
    if (options?.limit) cursor = cursor.limit(options.limit);
    const docs = await cursor.toArray();
    return docs as DbDocument[];
  }

  async insertOne(doc: DbDocument): Promise<void> {
    await this.db.collection(this.name).insertOne({ ...doc });
  }

  async updateOne(filter: DbDocument, update: UpdateSpec, options?: UpdateOptions): Promise<void> {
    const mongoUpdate: Record<string, unknown> = {};
    if (update.$set) mongoUpdate.$set = update.$set;
    if (update.$inc) mongoUpdate.$inc = update.$inc;
    if (update.$setOnInsert) mongoUpdate.$setOnInsert = update.$setOnInsert;
    await this.db.collection(this.name).updateOne(filter, mongoUpdate, { upsert: options?.upsert ?? false });
  }

  async deleteMany(filter: DbDocument): Promise<void> {
    await this.db.collection(this.name).deleteMany(filter);
  }
}

export class MongoAdapter implements Database {
  constructor(private readonly db: Db) {}
  collection(name: string): DbCollection {
    return new MongoCollection(this.db, name);
  }
}
