# Darwin envd source

This directory contains the `packages/envd` and `packages/shared` source from
E2B runtime commit `f2233c5e3f39e6b2be9d158138df898ea561ecf`.

The source remains under the upstream Apache-2.0 license. Keep this commit
updated deliberately, run the Darwin build and Tart compatibility checks, and
record the new upstream commit here when syncing.

The module layout is preserved so the upstream `packages/envd` build and its
`../shared` replacement continue to work without rewriting import paths.

The local Darwin patch uses `os.Executable()` for re-exec helpers because
macOS does not provide `/proc/self/exe`. Linux keeps the upstream path.
