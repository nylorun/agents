/**
 * Our engine's tool that stores a sandbox file, or inline text, as a file artifact of the session
 * (F8.1). Since protocol 15 it runs in our harness (`@nylorun/harness`), not the Runtime.
 */
export const SAVE_ARTIFACT_TOOL = "save_artifact";
/**
 * Our engine's tool that reads an artifact of the session in pages (R2b C11). Since protocol 15 it
 * runs in our harness, which also names it in a spilled tool result's stub and in a file's
 * reference line.
 */
export const READ_ARTIFACT_TOOL = "read_artifact";
