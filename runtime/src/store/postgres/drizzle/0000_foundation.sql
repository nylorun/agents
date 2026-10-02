-- Custom SQL (drizzle-kit does not model it): the two schemas and `nylorun.doc(body)`, which
-- the generated columns of the baseline (0001) read. Its snapshot declares the schemas, so
-- the baseline does not create them again.
--
-- doc(body) casts a `json` body to `jsonb` for the generated columns. `jsonb` rejects the
-- escapes \u0000 and unpaired surrogates, which `json` keeps verbatim: they are replaced with
-- \ufffd first (the stored body is untouched). A body with no \u escape takes the plain cast.
CREATE SCHEMA IF NOT EXISTS nylorun;
--> statement-breakpoint
CREATE SCHEMA nylorun_streams;
--> statement-breakpoint
CREATE FUNCTION nylorun.doc(body json) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT CASE WHEN strpos(body::text, '\u') = 0 THEN body::jsonb
        ELSE regexp_replace(
          body::text,
          '(?<!\\)((?:\\\\)*)\\u(0000|[dD][89a-fA-F][0-9a-fA-F]{2})',
          '\1\\ufffd',
          'g'
        )::jsonb
      END
    $$;
