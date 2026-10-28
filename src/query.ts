import type { QueryResult, QueryResultRow } from "pg";

export type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<QueryResult<QueryResultRow>>;
};

/** Adapt a node-postgres client or pool to the small query surface ingest uses. */
export function asQueryable(client: {
  query: (text: string, values?: never[]) => Promise<QueryResult<QueryResultRow>>;
}): Queryable {
  return {
    query: (text, values) => client.query(text, values as never[] | undefined),
  };
}

export async function queryRows<T extends Record<string, unknown>>(
  client: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await client.query(text, values);
  return result.rows as T[];
}
