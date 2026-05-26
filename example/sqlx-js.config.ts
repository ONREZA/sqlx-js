import type { SqlxJsConfig } from "@onreza/sqlx-js";

const config: SqlxJsConfig = {
  jsonbTypes: {
    "users.settings": "SqlxJsJson.UserSettings",
    "posts.meta": "SqlxJsJson.PostMeta",
    "posts.attachments": "SqlxJsJson.Attachment",
  },
};

export default config;
