import { expect, test } from "bun:test";
import { jsonSensitiveIndicators } from "../src/commands/json-audit";

test("json audit identifies operator and function dependencies without flagging ordinary SQL", () => {
  expect(jsonSensitiveIndicators(
    "SELECT payload->>'kind' FROM events WHERE payload @> $1::jsonb AND jsonb_path_exists(payload, '$.id')",
  )).toEqual(["->>", "@>", "jsonb_path_exists"]);
  expect(jsonSensitiveIndicators("SELECT payload ? 'kind' FROM events")).toEqual(["?"]);
  expect(jsonSensitiveIndicators("SELECT payload?'kind' FROM events")).toEqual(["?"]);
  expect(jsonSensitiveIndicators("SELECT payload @? '$.kind' FROM events")).toEqual(["@?"]);
  expect(jsonSensitiveIndicators("SELECT id, payload FROM events WHERE id = $1")).toEqual([]);
});
