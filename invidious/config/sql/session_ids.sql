CREATE TABLE IF NOT EXISTS public.session_ids
(
  id text NOT NULL,
  email text,
  issued timestamp with time zone,
  CONSTRAINT session_ids_pkey PRIMARY KEY (id)
);

GRANT ALL ON TABLE public.session_ids TO current_user;

CREATE INDEX IF NOT EXISTS session_ids_id_idx
  ON public.session_ids
  USING btree
  (id COLLATE pg_catalog."default");
