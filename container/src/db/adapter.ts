export type DbDocument = Record<string, unknown>;

export interface UpdateSpec {
  $set?: DbDocument;
  $inc?: Record<string, number>;
  $setOnInsert?: DbDocument;
}

export interface UpdateOptions {
  upsert?: boolean;
}

export interface DbCollection {
  findOne(filter: DbDocument): Promise<DbDocument | null>;
  insertOne(doc: DbDocument): Promise<void>;
  updateOne(filter: DbDocument, update: UpdateSpec, options?: UpdateOptions): Promise<void>;
  deleteMany(filter: DbDocument): Promise<void>;
}

export interface Database {
  collection(name: string): DbCollection;
}
