-- Custom SQL (drizzle-kit does not model publications): the publication the stream relay
-- subscribes to (Durable Streams §7). Only inserts: the record is append-only.
CREATE PUBLICATION nylorun_stream_relay
  FOR TABLE nylorun_streams.session_events WITH (publish = 'insert');
