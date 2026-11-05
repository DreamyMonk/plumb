import "server-only";
import { exec, ident, literal, query } from "./db";
import { toColumnName } from "./ingest/clean";
import type { TransformOp } from "./types";

const CAST: Record<string, string> = { number: "DOUBLE", date: "DATE", text: "VARCHAR", boolean: "BOOLEAN" };

/** Every value and name is quoted here, so a transform proposed by the model is plain data. */
export async function applyOp(tableName: string, op: TransformOp, renames: Map<string, string>): Promise<void> {
  const table = ident(tableName);
  const described = await query(`DESCRIBE ${table}`);
  const type = described.find((row) => row.column_name === op.column)?.column_type as string | undefined;
  if (!type) throw new Error(`Column "${op.column}" no longer exists.`);
  const c = ident(op.column);

  switch (op.op) {
    case "fill_missing": {
      if (op.strategy === "forward_fill") {
        await exec(
          `CREATE OR REPLACE TABLE ${table} AS SELECT * REPLACE (LAST_VALUE(${c} IGNORE NULLS) OVER (ROWS UNBOUNDED PRECEDING) AS ${c}) FROM ${table}`,
        );
        return;
      }
      const fill =
        op.strategy === "constant"
          ? `TRY_CAST(${literal(op.value ?? "")} AS ${type})`
          : `(SELECT ${op.strategy === "median" ? "MEDIAN" : op.strategy === "mean" ? "AVG" : "MODE"}(${c}) FROM ${table})`;
      await exec(`UPDATE ${table} SET ${c} = CAST(${fill} AS ${type}) WHERE ${c} IS NULL`);
      return;
    }
    case "map_values": {
      if (type !== "VARCHAR") throw new Error("Value mapping only applies to text columns.");
      if (op.mapping.length === 0) return;
      const cases = op.mapping.map((m) => `WHEN ${literal(m.from)} THEN ${literal(m.to)}`).join(" ");
      const keys = op.mapping.map((m) => literal(m.from)).join(", ");
      await exec(`UPDATE ${table} SET ${c} = CASE ${c} ${cases} END WHERE ${c} IN (${keys})`);
      return;
    }
    case "drop_column":
      if (described.length === 1) throw new Error("Cannot drop the last column.");
      await exec(`ALTER TABLE ${table} DROP COLUMN ${c}`);
      return;
    case "rename_column": {
      const newName = toColumnName(op.newName, 0);
      if (described.some((row) => row.column_name === newName)) throw new Error(`Column "${newName}" already exists.`);
      await exec(`ALTER TABLE ${table} RENAME COLUMN ${c} TO ${ident(newName)}`);
      renames.set(op.column, newName);
      return;
    }
    case "cast_type":
      await exec(`CREATE OR REPLACE TABLE ${table} AS SELECT * REPLACE (TRY_CAST(${c} AS ${CAST[op.to]}) AS ${c}) FROM ${table}`);
      return;
    case "drop_rows": {
      if (op.condition === "is_null") {
        await exec(`DELETE FROM ${table} WHERE ${c} IS NULL`);
        return;
      }
      const [fences] = await query(`SELECT QUANTILE_CONT(${c}, 0.25) AS q1, QUANTILE_CONT(${c}, 0.75) AS q3 FROM ${table}`);
      const [q1, q3] = [Number(fences.q1), Number(fences.q3)];
      const iqr = q3 - q1;
      await exec(`DELETE FROM ${table} WHERE ${c} < ${q1 - 3 * iqr} OR ${c} > ${q3 + 3 * iqr}`);
      return;
    }
  }
}
