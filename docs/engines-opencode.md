# opencode Engine

[opencode](https://opencode.ai) is an open-source terminal coding agent that brings its own provider. Jinn wires it in as a batch engine: one `opencode run` per turn, JSON on stdout, no PTY.

> **Metered cost.** Like Pi and Hermes, and unlike the subscription-wrapped engines (claude, codex, grok), opencode bills on whichever provider you authenticate. `opencode auth login` supports an Anthropic Claude Pro/Max login as well as API keys — check which one you signed in with before running opencode on high-volume work.

---

## Installation

```bash
curl -fsSL https://opencode.ai/install | bash
```

Then sign in:

```bash
opencode auth login
```

Credentials live in opencode's own data directory (`~/.local/share/opencode/auth.json` on Linux/macOS). Jinn only resolves the binary from `PATH`; every provider decision is the CLI's own.

Check what the gateway will see:

```bash
opencode models
```

---

## Configuration

```yaml
engines:
  opencode:
    bin: opencode          # optional — PATH-resolved when absent
    model: anthropic/claude-sonnet-5
    fallback: [pi]         # engines to try when opencode cannot serve a turn
```

Model ids are opencode's own `provider/model` form, exactly as `opencode models` prints them. The model half may contain further slashes (`openrouter/meta-llama/llama-4`); only the first one is structural.

**No effort levels.** opencode has a `--variant` flag for provider-specific reasoning effort, but reports no list of which models accept which variants — so jinn offers no effort picker for opencode rather than offering one that silently does nothing.

---

## Invocation contract

```
opencode run --format json --dangerously-skip-permissions \
  [-m provider/model] [-s <session>]
```

The prompt goes on **stdin**, never argv: `run` takes its message as trailing positionals, so a prompt beginning with a dash would be read as a flag, and a long one would run into `ARG_MAX`.

opencode emits one JSON event per stdout line:

| event | what jinn takes from it |
| --- | --- |
| `step_start` | nothing — a model round trip began |
| `tool_use` | `part.tool`, `part.callID`, `part.state` → the live tool view |
| `text` | `part.text` → the answer (the last text part wins) |
| `step_finish` | `part.tokens`, `part.cost` → accounting |
| `error` | `error.name` + `error.data.message` → the turn's error |

Two things about that table are easy to get wrong and are worth stating plainly:

- **A turn is several steps.** One `step_finish` arrives per model round trip, and its `tokens` and `cost` are for that step alone. Cost is summed across the turn; the context reading is the last step's `input + cache.read + cache.write`, because that is how full the window is now.
- **Failures arrive on stdout as JSON**, not on stderr, and the process exits 1. An engine that reads only the exit code and stderr reports a turn that produced nothing, with no reason attached.

### Sessions and resume

opencode assigns the session id (`ses_…`) and reports it on every event, including the `error` one. Jinn captures it as `EngineResult.sessionId` and continues the conversation with `-s` on the next turn — the same contract codex uses, and the opposite of Pi, whose session id is jinn's own.

### Permissions

`--dangerously-skip-permissions` is the only approval lever jinn pulls. It auto-approves everything **not explicitly denied**, so an operator who denied `bash` in their own opencode config keeps that deny. Jinn deliberately does not write a `permission` block into the staged config, which would silently take that away.

---

## The company toolset (MCP)

opencode reads a real MCP config, which makes this the cheapest wiring of any engine here — no generated extension module (Pi), no config dialect of its own (Claude). Jinn projects the session's already-resolved server set into opencode's `mcp` block and points the CLI at it with `OPENCODE_CONFIG`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "jinn": {
      "type": "local",
      "command": ["/usr/bin/node", "/…/server.js", "--home", "/…/.jinn"],
      "environment": { "JINN_SESSION_ID": "…", "JINN_SESSION_CAPABILITY": "…" },
      "enabled": true
    }
  }
}
```

The file is written mode 0600 under `$JINN_HOME/tmp/opencode/<session>/` and removed when the turn settles. It carries the session's capability because opencode launches the server as a real subprocess with that `environment` — the same place Claude's staged `mcp.json` carries it. The gateway **bearer** is not in it: the built-in server resolves that from `<JINN_HOME>/gateway.json`.

`OPENCODE_CONFIG` **merges** with the operator's own config rather than replacing it, so this file carries only what jinn adds.

A session with no MCP servers stages no file and sets no `OPENCODE_CONFIG` at all — opencode's own config on that machine is left entirely alone.

---

## Remote employees

opencode is one of the three engines that can relocate a turn to another machine over SSH (`REMOTE_ENGINE_NAMES`), alongside Claude Code and Pi. See [remote-execution.md](remote-execution.md) for the whole picture; the opencode-specific parts:

- The prerequisite on the remote host is `opencode` on the **non-interactive** PATH, signed in there. `jinn remote status` reports which binary it found.
- No remote tty (`ssh -T`). opencode's stdout is a JSON stream jinn parses line by line, and a tty would fold the remote stderr into it.
- **Nothing relocates opencode's data directory.** Its session store and its `auth.json` sit side by side under the remote user's home, so moving the store would take the login with it and every turn would start unauthenticated. opencode generates its own session ids, so sessions sharing that one store cannot collide the way Pi's would — which is why there is no opencode equivalent of Pi's staged `--session-dir`.
- `OPENCODE_DISABLE_AUTOUPDATE=1` is set on every turn, local and remote: a self-upgrade between two turns of one session would swap the binary under a conversation opencode is still holding in its own store.
- **Provider keys in the remote login environment are left alone.** This is deliberate, and the opposite of the Claude engine's rule: Claude Code runs on subscription auth, where an inherited `ANTHROPIC_API_KEY` would silently move the session onto metered billing, so it is stripped. opencode drives whichever provider the operator authenticated on that machine, and for a key-authenticated provider an inherited key is how it works at all. Only the markers that tell a nested CLI it is running inside another agent are stripped (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `JINN_HOME_IDENTITY`, `JINN_TAKE_PORT`).
- **Attachments are refused** on a remote turn, the same as Pi and remote Claude: the file paths are the gateway's and name nothing on the other machine.

---

## Model discovery

`opencode models` prints one `provider/model` per line — every model the installed CLI can actually reach. Jinn refreshes this on the background timer and on `POST /api/engines/refresh`.

The catalog exists **only** once discovery has run: opencode ships no offline list, and what it reports depends entirely on which providers the operator configured on that machine. So an unrecognised model id is allowed through with a warning rather than refused — the same treatment Pi gets — because refusing it would reject an employee's own configured model for reasons that have nothing to do with the model.

---

## Known limits

- No PTY view. opencode is a batch engine here; there is no `/ws/pty` terminal for an opencode session.
- No effort/`--variant` support (see Configuration above).
- No aggregate quota reporting. `jinn limits` lists opencode as unsupported: any allowance belongs to whichever provider the operator authenticated, and opencode has none of its own to report.
- Attachments are named in the prompt text on a local turn and refused outright on a remote one. opencode's own `-f` flag is not wired up yet — Pi behaves the same way.
