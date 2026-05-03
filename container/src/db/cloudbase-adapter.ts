import tcb from '@cloudbase/node-sdk';
import type { Database, DbCollection, DbDocument, FindOptions, UpdateOptions, UpdateSpec } from './adapter.js';

type TcbDatabase = ReturnType<ReturnType<typeof tcb.init>['database']>;

class CloudBaseCollection implements DbCollection {
  constructor(private readonly db: TcbDatabase, private readonly name: string) {}

  async findOne(filter: DbDocument): Promise<DbDocument | null> {
    const r = await this.db.collection(this.name).where(filter).limit(1).get();
    const arr = (r as { data: DbDocument[] }).data;
    return arr.length > 0 ? arr[0] : null;
  }

  async find(filter: DbDocument, options?: FindOptions): Promise<DbDocument[]> {
    let q = this.db.collection(this.name).where(filter) as unknown as {
      orderBy(field: string, dir: 'asc' | 'desc'): typeof q;
      skip(n: number): typeof q;
      limit(n: number): typeof q;
      get(): Promise<{ data: DbDocument[] }>;
    };
    if (options?.sortBy) q = q.orderBy(options.sortBy, options.sortDir ?? 'desc');
    if (options?.offset) q = q.skip(options.offset);
    if (options?.limit) q = q.limit(options.limit);
    const r = await q.get();
    return (r.data ?? []) as DbDocument[];
  }

  async insertOne(doc: DbDocument): Promise<void> {
    await this.db.collection(this.name).add(doc);
  }

  async updateOne(filter: DbDocument, update: UpdateSpec, options?: UpdateOptions): Promise<void> {
    const col = this.db.collection(this.name);
    const existing = await col.where(filter).limit(1).get();
    const rows = (existing as { data: DbDocument[] }).data;

    if (rows.length > 0) {
      const payload: DbDocument = {};
      if (update.$set) Object.assign(payload, update.$set);
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          payload[k] = (this.db.command as unknown as { inc(n: number): unknown }).inc(v);
        }
      }
      if (Object.keys(payload).length > 0) {
        const docId = (rows[0] as DbDocument & { _id: string })._id;
        await col.doc(docId).update(payload);
      }
      return;
    }

    if (!options?.upsert) return;

    // Insert path
    const newDoc: DbDocument = { ...filter };
    if (update.$setOnInsert) Object.assign(newDoc, update.$setOnInsert);
    if (update.$set) Object.assign(newDoc, update.$set);
    if (update.$inc) Object.assign(newDoc, update.$inc);
    await col.add(newDoc);
  }

  async deleteMany(filter: DbDocument): Promise<void> {
    await this.db.collection(this.name).where(filter).remove();
  }
}

export class CloudBaseAdapter implements Database {
  private db: TcbDatabase;
  constructor(envId: string) {
    const init: Parameters<typeof tcb.init>[0] = { env: envId };
    if (process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY) {
      init.secretId = process.env.TENCENT_SECRET_ID;
      init.secretKey = process.env.TENCENT_SECRET_KEY;
    }
    const app = tcb.init(init);
    this.db = app.database();
  }
  collection(name: string): DbCollection {
    return new CloudBaseCollection(this.db, name);
  }
}
