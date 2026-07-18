# Vera Terminal workspace

This is the IDE's scratch workspace. The file tree, Monaco editor, and
embedded terminal are all scoped to this directory.

- Open files from the Explorer on the left.
- `Ctrl+S` (or the Save button) writes back to disk.
- The bottom panel runs a real PowerShell session rooted here.

## Phase notes

- Phase 2 (this): file tree + editor + PTY terminal.
- Phase 3: AI chat dock on the right, wired to these same fs/pty commands.
