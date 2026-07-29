# Repository instructions

Read `README.md` before changing or operating this repository.

For a persistent macOS control plane, use the Docker Desktop Compose setup in
the README. Do not replace it with `sandbox service install` or a host
`sandbox serve` process unless the user explicitly asks for launchd.

When exposing the local sandbox control plane, follow
`README.md#public-endpoint-for-a-local-control-plane`. Use the documented
hardware-derived `sandbox-<DEVICE_HASH>.crcl.es` hostname and the Docker Compose
`cloudflared` service. Do not replace it with a host `cgrok` process, a shared
name such as `sandbox-local.crcl.es`, or a random hostname: the container restart
policy keeps the endpoint available after reboot, while the stable per-device
name prevents collisions when more than one machine runs the control plane.

`AGENTS.md` is the canonical agent-instruction file. Keep `CLAUDE.md` as a
symlink to this file rather than maintaining a second copy.
