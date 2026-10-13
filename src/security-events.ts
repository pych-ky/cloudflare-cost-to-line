export interface R2BucketCreated {
  bucketName: string;
  eventTimestamp: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readR2BucketCreated(value: unknown, accountId: string): R2BucketCreated | null {
  if (!record(value) || value.type !== 'cf.r2.bucket.created' || !record(value.source) || value.source.type !== 'r2') {
    return null;
  }
  if (!record(value.payload) || !record(value.metadata)) return null;
  const { name } = value.payload;
  const { accountId: eventAccountId, eventSchemaVersion, eventTimestamp } = value.metadata;
  if (
    typeof eventAccountId !== 'string' || !/^[a-f0-9]{32}$/i.test(eventAccountId)
    || eventAccountId.toLowerCase() !== accountId.toLowerCase() || eventSchemaVersion !== 1
    || typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)
    || typeof eventTimestamp !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(eventTimestamp)
  ) {
    return null;
  }
  const timestamp = Date.parse(eventTimestamp);
  if (!Number.isFinite(timestamp)) return null;
  return { bucketName: name, eventTimestamp: new Date(timestamp).toISOString() };
}
