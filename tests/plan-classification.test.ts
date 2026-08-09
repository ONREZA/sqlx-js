import { describe, expect, test } from "bun:test";
import { classifyPlanValidation } from "../src/pg/plan-classification";

describe("plan validation classification", () => {
  test("recognizes PostgreSQL's generic planning surface", async () => {
    const statements = [
      "SELECT 1",
      "VALUES (1)",
      "INSERT INTO items (id) VALUES (1)",
      "UPDATE items SET id = 2",
      "DELETE FROM items",
      "MERGE INTO items USING source ON items.id = source.id WHEN MATCHED THEN DO NOTHING",
    ];
    for (const sql of statements) {
      expect(await classifyPlanValidation(sql)).toBe("planned");
    }
  });

  test("recognizes utility statements before server planning", async () => {
    const statements = [
      "SET LOCAL session_replication_role = replica",
      "SET LOCAL ROLE application_user",
      "ANALYZE",
      "CALL refresh_materialized_state()",
      "SELECT 1 INTO TEMPORARY TABLE prepared_output",
    ];
    for (const sql of statements) {
      expect(await classifyPlanValidation(sql)).toBe("parse-only");
    }
  });

  test("leaves invalid SQL to PostgreSQL diagnostics", async () => {
    expect(await classifyPlanValidation("SELECT FROM")).toBeUndefined();
  });
});
