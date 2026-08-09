import { defineConfig } from "@onreza/sqlx-js";

export default defineConfig({
  enumCatalog: {
    output: "db-enums.ts",
    schemas: ["public"],
    exclude: ["public.post_status"],
    registry: true,
  },
  columnTypes: {
    "users.settings": "SqlxJsJson.UserSettings",
    "posts.meta": "SqlxJsJson.PostMeta",
    "posts.attachments": "SqlxJsJson.Attachment",
  },
});
