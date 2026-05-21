# bearly tools

CLI scripts that live in `tools/`, run directly with `bun tools/<name>.ts`,
and have not yet been packaged into a `plugins/` directory. They cover daily
maintenance, watchdog, and research tasks for the bearly + tribe family.

## memwatch — external RSS watchdog

`tools/memwatch.ts` is an opt-in external watcher for a target pid and its
parent. It samples both processes every N seconds (default 10s), writes a
rotating log, and trips a panic-dump pipeline when either crosses an
RSS threshold.

### Why this exists

Heap-only profilers (Node `process.memoryUsage`, Bun `--inspect`) cannot see
bytes that have already left the process via stdout. When a TUI bun process
runs under a pty parent — `cmux`, `tmux`, an iTerm/Ghostty pane, or
`claude-code`'s integrated terminal — a leaky write loop or runaway
error-handler inflates the _parent_'s scrollback buffer. The bun process's
own heap looks healthy throughout, and macOS OOM-kills the pty parent (with
the largest resident set), not the script that caused the growth.

memwatch fills that gap as an EXTERNAL safety net — it doesn't care about
heap, only RSS, and it watches both the target and its parent so the trip
fires regardless of which side is bloating.

The motivating incident: 2026-05-13 silvercode under cmux pumped multi-GB
through stdout; the OOM popup blamed cmux, not silvercode.

### Usage

```bash
# Watch silvercode (pid 12345), defaults: 4 GB target / 8 GB parent / 10 s
bun tools/memwatch.ts 12345

# Tighter thresholds for a known-fragile session
bun tools/memwatch.ts 12345 \
  --threshold-rss-mb 2048 \
  --threshold-parent-rss-mb 4096 \
  --interval-sec 5

# Last-resort cleanup: also SIGINT the pty parent on parent-threshold trip
bun tools/memwatch.ts 12345 --allow-kill-parent

# Custom log + snapshot locations
bun tools/memwatch.ts 12345 \
  --log-path /tmp/silvercode-watch.log \
  --snapshot-dir /tmp/silvercode-snapshots
```

Send `SIGINT` to memwatch to stop it cleanly. It also exits automatically
when the target process is gone.

### Options

| Flag                          | Default                   | Meaning                                                |
| ----------------------------- | ------------------------- | ------------------------------------------------------ |
| `--threshold-rss-mb N`        | 4096                      | Trip when target RSS exceeds N MB                      |
| `--threshold-parent-rss-mb N` | 8192                      | Trip when parent RSS exceeds N MB                      |
| `--snapshot-dir DIR`          | `/tmp`                    | Write snapshot summary files here                      |
| `--allow-kill-parent`         | off                       | Also send SIGINT to parent on parent-threshold trip    |
| `--interval-sec N`            | 10                        | Sample interval (seconds)                              |
| `--log-path PATH`             | `/tmp/memwatch-<pid>.log` | Rotating log file                                      |
| `--max-log-bytes N`           | 10 MB                     | Rotate when log exceeds N bytes (one `.1` backup kept) |
| `--panic-cooldown-sec N`      | 60                        | Suppress repeat panics for N seconds after a trip      |

### What happens on a trip

1. **Log a banner** to the rotating log (and to stderr): `PANIC: <which> RSS = <N>MB exceeds threshold <T>MB`.
2. **Write a snapshot summary** to `<snapshot-dir>/memwatch-<pid>-<ts>.summary.txt` with the last 100 samples.
3. **Send `SIGUSR2` to the target.** Targets that ship a handler (silvery L1
   intends to dump a heap snapshot here) take the signal; targets that don't
   exit cleanly, which is acceptable cleanup before the OOM-kill arrives.
4. **If `--allow-kill-parent` and the parent tripped**, send `SIGINT` to the
   parent to free the pty buffer. This is destructive — opt-in only.
5. **Suppress repeat panics** for `panic-cooldown-sec` (60 s by default) so a
   single growth spike doesn't blast the log + signals.

The loop keeps sampling after the trip — it doesn't exit until the target
dies or you send SIGINT to memwatch.

### Log format

The log is grep-friendly. Each line:

```
2026-05-13T22:13:45.123Z 12345 target_rss_mb=523 target_vsz_mb=4192 target_cpu=0.4 target_name=bun children=2 parent_pid=12300 parent_rss_mb=1024 parent_name=cmux
```

Panic lines are easy to spot:

```
2026-05-13T22:14:55.001Z 12345 PANIC: target RSS = 4150MB exceeds threshold 4096MB
2026-05-13T22:14:55.002Z 12345 snapshot=/tmp/memwatch-12345-2026-05-13T22-14-55-002Z.summary.txt
2026-05-13T22:14:55.003Z 12345 signal=SIGUSR2 delivered=true
```

### Layer 4 of the silvery memory-observability stack

memwatch is the external safety net — Layer 4. The other layers live in
silvery and ship independently:

- **Layer 1** — `SILVERY_STRICT=bytes_out` instruments bytes-out throughput
  inside the renderer.
- **Layer 2** — heap snapshot endpoint inside the bun process.
- **Layer 3** — log-side framing for the panic events.
- **Layer 4** — memwatch (this tool).

memwatch is independent of the other layers and can ship standalone.

## Other tools

| Tool           | Description                                                 | Entry Point                 |
| -------------- | ----------------------------------------------------------- | --------------------------- |
| `memwatch`     | External RSS watchdog for a target pid + parent             | `bun tools/memwatch.ts`     |
| `refactor`     | Batch rename, replace, API migration                        | `bun tools/refactor.ts`     |
| `llm`          | Multi-LLM research, consensus, deep research                | `bun tools/llm.ts`          |
| `recall`       | Session history search, LLM synthesis                       | `bun tools/recall.ts`       |
| `worktree`     | Git worktree management with submodules                     | `bun tools/worktree.ts`     |
| `qmd-watchdog` | Supervise `qmd embed` runs — RSS ceiling, no-progress timer | `bun tools/qmd-watchdog.ts` |

See the parent README and `CLAUDE.md` for the tribe + plugin packages.
