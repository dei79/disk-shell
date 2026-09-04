# Changelog

v1.2.0

- Fixed Escape handling so closing terminal search does not close the DSM window.
- Added the installed package version to the shell footer.
- Changed drag-and-drop uploads to use the shell's current directory without inserting file paths into the terminal.
- Added filename checks before uploading, with Override, Keep both, and Cancel choices for conflicts.
- Upload files individually; a later failure no longer deletes previously completed uploads.
- Bound upload authorization to the user, session, and checked directory; changing directories requires a new upload check.
- Hardened upload commits against directory targets and filename options, and added process timeouts and cleanup for write failures.
- Route drops to the hovered split pane, with animated target highlighting, shell name, and pane-local upload progress.
- Removed the old 100 MiB cumulative upload quota; per-file and per-request limits remain.

v1.1.1

- Added a package icon and clickable maintainer, project, and support links for Package Center.
- Corrected the package maintainer and canonical Go module path.

v1.1.0

- Added renameable shell sessions, terminal search, secure file uploads, and split views.
- Hardened uploads and polished the shell workspace controls.

v1.0.1

- Added multiple shell tabs and persistent shell sessions.

v0.1.0

- First release of DiskShell.
- Added automated SPK releases with checksums.
