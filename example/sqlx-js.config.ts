import { defineConfig } from "@onreza/sqlx-js";

export default defineConfig({
  jsonbTypes: {
    "users.settings": "SqlxJsJson.UserSettings",
    "posts.meta": "SqlxJsJson.PostMeta",
    "posts.attachments": "SqlxJsJson.Attachment",
  },
});
