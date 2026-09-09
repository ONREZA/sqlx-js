import { expect, test } from "bun:test";
import { buildParamMap, effectiveParamTargets } from "../src/pg/param-map";

for (const query of [
  "SELECT id FROM users WHERE id = $1",
  "INSERT INTO users(id, name) VALUES ($1, $2)",
  "UPDATE users SET name = $2 WHERE id = $1",
  "DELETE FROM users WHERE id = $1",
  "WITH updated AS (UPDATE users SET name = $2 WHERE id = $1 RETURNING *) SELECT * FROM updated",
  "SELECT id FROM users WHERE ($1::integer IS NULL OR id = $1)",
]) {
  for (const options of ["(FORMAT JSON)", "(ANALYZE, FORMAT JSON)"]) {
    test(`EXPLAIN preserves the underlying parameter contract: ${options} ${query}`, async () => {
      const original = await buildParamMap(query);
      expect(effectiveParamTargets(original.bindings.get(1))).toContainEqual(expect.objectContaining({ table: "users", column: "id" }));
      expect(await buildParamMap(`EXPLAIN ${options} ${query}`)).toEqual(original);
    });
  }
}
