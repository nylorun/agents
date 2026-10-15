/**
 * What the file systems a workspace lives on take (B15: constants fixed by a standard, not
 * limits): artifact names and folder paths are written as file names and paths there, when an
 * artifact is copied into a sandbox, a folder unpacked, a skill mounted or a file downloaded.
 */

/**
 * The longest file name: `NAME_MAX`, 255 on ext4, XFS, APFS and NTFS (POSIX `<limits.h>`).
 */
export const FILE_NAME_MAX = 255;

/**
 * The longest path: `PATH_MAX` of macOS (1024, `<sys/syslimits.h>`), where a local Runtime's
 * virtual workspace lives, and the smallest of the systems a workspace lives on (Linux's is
 * 4096).
 */
export const FILE_PATH_MAX = 1024;
