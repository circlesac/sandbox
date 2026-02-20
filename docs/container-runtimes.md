# Container Runtimes

## Summary

**Start with Docker. Switch to Podman later if needed — switching cost is one line.**

Both work for our use case. Docker wins on ecosystem maturity and simplicity during initial implementation. Podman wins on security and architecture. Since we use `dockerode` (Docker API), switching is a socket path change.

## Production (Linux)

Docker Engine is **free and open source** (Apache-2.0) on Linux. No VM, no licensing, no desktop app — containers run natively on the kernel. `apt install docker-ce` and done.

Licensing only applies to **Docker Desktop** (the macOS/Windows GUI app that wraps Docker Engine inside a VM). Our production server runs Linux, so this is irrelevant.

## macOS (Development)

All options run Linux containers inside a VM — none are native. Choose based on cost and developer experience.

| | Docker Desktop | OrbStack | Colima | Podman | Rancher Desktop |
|---|---|---|---|---|---|
| **VM** | Custom Linux VM | Apple Virtualization | Lima (Apple Virt / QEMU) | `podman machine` (Apple Virt / QEMU) | Lima |
| **Apple Silicon** | Yes | Yes (optimized) | Yes | Yes | Yes |
| **License** | Paid for orgs >250 employees or >$10M revenue | Free personal, paid commercial | Free (MIT) | Free (Apache-2.0) | Free (Apache-2.0) |
| **Docker API** | Native | Native (drop-in replacement) | Native (runs dockerd) | Compat layer | Native (dockerd mode) |
| **Performance** | Baseline | Faster startup, lower resource usage | Similar to Docker Desktop | Similar | Heavier (bundles Kubernetes) |
| **`dockerode` works** | Yes | Yes | Yes | Yes (via compat socket) | Yes |

**Recommendation:** OrbStack if budget allows (best DX), Colima if free is required.

## Architecture

| | Docker | Podman |
|---|---|---|
| **Model** | Client/server: long-running `dockerd` daemon (root) | Daemonless: fork/exec, no persistent daemon |
| **Socket** | `/var/run/docker.sock` (always on) | `podman system service` on-demand or socket-activated |
| **Root** | Daemon runs as root by default | Rootless by default |
| **Runtime** | containerd + runc (OCI) | conmon + crun/runc (OCI) |
| **State** | Daemon holds state in memory + on disk | Disk only; no daemon state to lose |

## API Compatibility

Podman provides a Docker-compatible API layer. All operations our control plane needs are covered:

| Operation | Docker API | Podman Compat | Status |
|---|---|---|---|
| Container create/run | `POST /containers/create` | Supported | Works |
| Container stop (pause) | `POST /containers/{id}/stop` | Supported | Works |
| Container start (resume) | `POST /containers/{id}/start` | Supported | Works |
| Container inspect | `GET /containers/{id}/json` | Supported | Works |
| Container remove | `DELETE /containers/{id}` | Supported | Works |
| Labels at create time | `Labels` in create body | Supported | Works |
| Label filtering | `?filters={"label":["k=v"]}` | Supported | Historical bugs, mostly fixed |
| Port mapping (`-p 0:49983`) | `PortBindings` | Supported | Works |
| Dynamic port retrieval | `NetworkSettings.Ports` | Supported | Works |

## TypeScript SDK

Use `dockerode` regardless of choice — it works with all options:

```typescript
// Docker / OrbStack / Colima / Rancher Desktop
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Podman (one-line switch)
const docker = new Docker({ socketPath: '/run/podman/podman.sock' });
```

`dockerode`: 4M+ weekly npm downloads, full TypeScript types, covers every API endpoint.

## Docker Advantages (why we start here)

**Ecosystem maturity:** `dockerode` is battle-tested with Docker's native socket. Using it with Podman's compat layer adds a translation layer that could have subtle bugs.

**Simpler networking:** Docker's bridge networking "just works" for port mapping. `docker run -p 0:49983` reliably assigns a random host port. Podman rootless uses `pasta` which has more edge cases.

**No socket activation complexity:** Docker daemon is always listening. Podman requires `podman system service` running — idle timeout (default 5s) means next API call triggers socket activation with ~200-500ms latency. Workaround: `podman system service --time=0` (negates "daemonless" advantage).

**Community resources:** Every tutorial, StackOverflow answer, and blog post assumes Docker. E2B's own infra uses Docker.

**One less variable:** We're building a control plane with envd lifecycle, cloudflared routing, and E2B SDK compatibility to get right. Docker is the known quantity.

## Podman Advantages (why we might switch later)

**Daemonless (no SPOF):** If Docker daemon crashes, all containers lose their parent process. Podman containers are independent processes — if control plane crashes, existing containers keep running.

**Rootless security:** Sandbox containers run without root. If an envd container is compromised, attacker gets an unprivileged host user. For a system where untrusted code runs inside containers, this is a real security win.

**systemd integration (Quadlet):** Containers declared as `.container` unit files with `Restart=always`. Control plane itself could be a Quadlet unit — auto-restart, journald logging, dependency ordering.

## Gotchas with Podman

**API version mismatch:** Podman compat layer has historically advertised Docker API v1.40. Docker client v29 requires minimum v1.44. Affects Docker CLI, not `dockerode` directly (it does version negotiation).

**Socket activation latency:** `podman system service` idle timeout means API calls after idle period add ~200-500ms. Run with `--time=0` to keep service alive.

**Container inspect JSON differences:** Minor structural differences in Podman vs Docker inspect output. Only rely on well-documented fields (`Config.Labels`, `NetworkSettings.Ports`, `State.Running`, `Id`).

**Label filtering edge cases:** Historical bugs in compat API label filtering. Most fixed in Podman 4.x/5.x, but test specific filter patterns.

## Decision

| Factor | Docker | Podman | Winner |
|---|---|---|---|
| Matches existing plan | Yes | Requires changes | Docker |
| SDK maturity | Native | Compat layer | Docker |
| Community resources | Vast | Growing | Docker |
| Daemonless (no SPOF) | No | Yes | Podman |
| Rootless security | Optional | Default | Podman |
| systemd integration | Basic | Quadlet | Podman |
| Switching cost | — | One line change | Tie |

**Use Docker now. Evaluate Podman when:**
- Moving to multi-tenant model where sandbox isolation is critical
- Want systemd-native lifecycle management instead of custom TTL logic
- Running on systems where Docker is unavailable (RHEL 9+ ships Podman)
- Docker daemon restarts become a pain point
