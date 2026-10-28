export type SqlStatement = {
  /** Text sent to Postgres, including leading comments. */
  raw: string;
  /** Statement with comments removed and whitespace collapsed. */
  body: string;
};

export type WrapperKind = "begin" | "commit";

/**
 * Split a SQL script on semicolons that sit outside comments, quotes, and dollar-quotes.
 * The locked migration uses all three, so a naive split would cut CREATE TABLE bodies.
 */
export function splitSql(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let raw = "";
  let body = "";
  let index = 0;
  let mode: "normal" | "line" | "block" | "single" | "dollar" = "normal";
  let dollarTag = "";

  const push = () => {
    const trimmedRaw = raw.trim();
    const trimmedBody = body.trim().replace(/\s+/g, " ");
    raw = "";
    body = "";
    if (trimmedRaw === "" || trimmedBody === "") return;
    statements.push({ raw: trimmedRaw, body: trimmedBody });
  };

  while (index < sql.length) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (mode === "line") {
      raw += char;
      if (char === "\n") mode = "normal";
      index += 1;
      continue;
    }

    if (mode === "block") {
      raw += char;
      if (char === "*" && next === "/") {
        raw += "/";
        index += 2;
        mode = "normal";
        continue;
      }
      index += 1;
      continue;
    }

    if (mode === "single") {
      raw += char;
      body += char;
      if (char === "'") {
        if (next === "'") {
          raw += "'";
          body += "'";
          index += 2;
          continue;
        }
        mode = "normal";
      }
      index += 1;
      continue;
    }

    if (mode === "dollar") {
      if (sql.startsWith(dollarTag, index)) {
        raw += dollarTag;
        body += dollarTag;
        index += dollarTag.length;
        mode = "normal";
        continue;
      }
      raw += char;
      body += char;
      index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      raw += "--";
      index += 2;
      mode = "line";
      continue;
    }
    if (char === "/" && next === "*") {
      raw += "/*";
      index += 2;
      mode = "block";
      continue;
    }
    if (char === "'") {
      raw += "'";
      body += "'";
      index += 1;
      mode = "single";
      continue;
    }
    if (char === "$") {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index));
      const tag = match?.[0];
      if (tag) {
        dollarTag = tag;
        raw += tag;
        body += tag;
        index += tag.length;
        mode = "dollar";
        continue;
      }
    }
    if (char === ";") {
      push();
      index += 1;
      continue;
    }
    raw += char;
    body += char;
    index += 1;
  }

  push();
  return statements;
}

export function wrapperKind(body: string): WrapperKind | null {
  if (/^begin(\s+(work|transaction))?$/i.test(body)) return "begin";
  if (/^(commit|end)(\s+(work|transaction))?$/i.test(body)) return "commit";
  return null;
}

export type MigrationScript = {
  wrapped: boolean;
  prologue: string | null;
  body: SqlStatement[];
};

/** Separate an optional BEGIN/COMMIT wrapper from the statements that run inside it. */
export function splitMigration(sql: string): MigrationScript {
  const statements = splitSql(sql);
  const first = statements[0];
  const last = statements[statements.length - 1];
  if (!first || !last) {
    throw new Error("migration file has no statements");
  }
  const wrapped = wrapperKind(first.body) === "begin" && wrapperKind(last.body) === "commit";
  const body = wrapped ? statements.slice(1, -1) : statements;
  for (const statement of body) {
    if (wrapperKind(statement.body)) {
      throw new Error("nested BEGIN/COMMIT in a migration is not supported");
    }
  }
  return {
    wrapped,
    prologue: wrapped ? first.raw : null,
    body,
  };
}
