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
  /** Permission-aware protocols: server-resolved home space. Legacy responses omit this field. */
  spaceId?: string;
  /** Protocol 3, cross-space relations only: the other readable space (the home space is `spaceId`). */
  peerSpaceId?: string;
}

export interface PublicUser {
  id: string;
  username: string;
  name: string;
  role: 'admin' | 'member';
  color: string;
}
