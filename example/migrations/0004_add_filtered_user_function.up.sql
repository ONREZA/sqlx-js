CREATE FUNCTION public.list_users(
  filter_role public.user_role,
  search_text text,
  after_id bigint,
  result_limit integer
)
RETURNS TABLE (
  id bigint,
  name text,
  email text,
  role public.user_role,
  created_at timestamptz
)
LANGUAGE SQL
STABLE
AS $$
  SELECT users.id, users.name, users.email, users.role, users.created_at
  FROM public.users
  WHERE (filter_role IS NULL OR users.role = filter_role)
    AND (search_text IS NULL OR users.name ILIKE '%' || search_text || '%')
    AND (after_id IS NULL OR users.id > after_id)
  ORDER BY users.id ASC
  LIMIT LEAST(GREATEST(COALESCE(result_limit, 50), 1), 100)
$$;
