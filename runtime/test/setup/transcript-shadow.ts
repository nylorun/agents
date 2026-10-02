/**
 * One history (blueprint P0.3): every runtime test that runs a turn keeps the transcript on the
 * session row too and checks the fold of the record against it at every segment start, so the
 * test suites are the fold's parity corpus. Tests of lean rows switch it off themselves.
 */
import { setTranscriptShadow } from "../../src/tenant/history.js";

setTranscriptShadow(true);
