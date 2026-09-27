export interface Mutation {
  id: string;
  collection: string;
  patch: Record<string, unknown>;
  ts: number;
}

export interface StoredRecord {
  data: Record<string, unknown>;
  field_ts: Record<string, number>;
}

export interface PulledRecord extends StoredRecord {
  id: string;
  collection: string;
  seq: number;
}

export interface PublicUser {
  id: string;
  username: string;
  name: string;
  role: 'admin' | 'member';
  color: string;
}
