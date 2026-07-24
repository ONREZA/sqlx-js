CREATE TABLE pgschema_probe (
  id bigint PRIMARY KEY,
  name text NOT NULL
);

CREATE FUNCTION pgschema_normalize_name(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT lower(value)
$$;
