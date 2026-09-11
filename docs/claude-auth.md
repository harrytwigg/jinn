# Claude authentication on a gateway host

How the Claude engine stays logged in on an unattended gateway, what the gateway
does when it stops being logged in, and the one step it cannot do for you.

## What Claude Code keeps, and who refreshes it

Claude Code stores an OAuth pair per profile — on Linux in
`$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude/.credentials.json`),
on macOS in the login Keychain:

| field | lifetime | what it is for |
|---|---|---|
| `accessToken` / `expiresAt` | hours | every API request |
| `refreshToken` / `refreshTokenExpiresAt` | weeks | minting the next access token |

**Claude Code refreshes the pair itself.** When a `claude` process starts, or
gets a 401, it exchanges the refresh token for a new pair and rewrites the file.
Refresh tokens rotate: the old one is consumed by the exchange. The gateway
never calls the refresh endpoint — a second refresher racing the CLI's own is
exactly how a refresh token gets consumed by one process and lost by the file.

Two consequences shape everything below:

- An **expired access token on disk is routine.** Between launches the file
  spends most of its time expired; the next launch fixes it. It is not a fault
  and the gateway does not treat it as one.
- A **refresh that fails is fatal and unattended-unfixable.** The CLI reports
  `authentication_failed` ("Login expired · Please run /login") and every
  further launch does the same until a human runs `claude auth login`.

## What the gateway does

`packages/jinn/src/sessions/claude-auth-watch.ts` (side effects) over
`packages/jinn/src/shared/claude-auth.ts` (reads the file) and
`claude-auth-outage.ts` (the ledger, at `$JINN_HOME/tmp/claude-auth-outage.json`).

1. **Observe.** Every Claude turn reports how it ended. `authentication_failed`
   or `oauth_org_not_allowed` opens an outage for the session's *scope* — the
   gateway host, or a remote employee's `user@host[:profile]`. A turn that
   authenticated closes it.
2. **Alert once.** The first failure of an outage sends one operator message
   naming the host, the reason, what it costs (every Claude turn and cron job
   there), and the fix. The outage then counts; it does not re-send. Recovery
   sends one message with the duration and the tally. An outage survives
   `jinn restart` without re-alerting.
3. **Refuse doomed launches.** Turn preflight refuses a *local* Claude launch
   when the disk states outright that it cannot work (no credentials file;
   refresh token past its own expiry) or when a launch already proved it and
   nothing has changed since (access token expired, same pair failed within the
   last hour). The refusal settles the session as failed with the fix in the
   error, so cron history records a failed run without spawning a CLI. It is a
   cooldown, not a lock: one launch per hour re-probes, and a login lifts it
   immediately because the pair on disk changes. Remote employees are never
   refused — their credentials are on a host the gateway cannot read.
4. **Prefer a fallback engine.** The failure also records `claude` as
   unavailable in engine health for the recheck window, so new sessions with an
   engine chain start on the next healthy engine and the dashboard shows why.
5. **Warn ahead of the predictable expiry.** The 15-minute engine-health tick
   checks `refreshTokenExpiresAt` and sends one warning 48 hours before it — the
   only credential expiry that is both foreseeable from the file and fatal.
6. **Read the catalog honestly.** Model discovery returning 0 models no longer
   says "run `claude login`" unless logging in is the fix; an expired access
   token is logged at info as what it is, and the last discovered catalog is
   kept rather than replaced with offline aliases.

### Where alerts go

`notifyOperatorChannel` resolves its target in this order:

1. `notifications.connector` + `notifications.channel`
2. `cron.alertConnector` + `cron.alertChannel`
3. a Telegram connector whose `allowFrom` lists exactly one user

With none of those, alerts are logged at warn and dropped. Set `notifications`
explicitly; the fallbacks exist so a working connector is used rather than
nothing, not as a recommendation.

## The manual step

On the gateway host, as the user the gateway runs as:

```
claude auth status      # loggedIn:false, or a failing turn, means the next line
claude auth login
```

If the Telegram connector has `telegramAuth.enabled: true` with the operator in
`ownerUserIds`, `/auth claude` to the bot runs the same login from the phone,
and the outage alert says so.

There is no unattended equivalent. `claude auth login` is a browser OAuth
flow; a refresh token that has been consumed or revoked cannot be recovered by
software on the host.

## Incident: 2026-09-11, 02:00–07:19 UTC

Every Claude turn launched from the gateway (a Raspberry Pi) failed with
`authentication_failed` for five hours; six hourly cron fires, the nightly
memory sweep and the morning inbox triage did nothing, and four sessions parked
on a usage limit woke at 02:00 as designed and died on auth. Nothing told the
operator; he found it and ran `claude auth login` at 07:19 UTC.

What the evidence establishes:

- The access token on disk was valid at 01:00:05 UTC (model discovery: 14
  models) and expired by 02:00:03 (0 models) — an ordinary end-of-lifetime.
- The **first** launch after that, at 02:00:00, failed in 3.7 s with "Login
  expired · Please run /login": Claude Code attempted its refresh and the
  refresh token was refused. This was before the parked sessions retried at
  02:00:09, so whatever consumed the refresh token had done so before 02:00 —
  it was not a race between those retries.
- Every launch for the next five hours failed identically; only a fresh login
  (new pair, `profileFetchedAt` 07:19:00 UTC, `claude auth login` in shell
  history) fixed it.
- Nothing else on the host reads or refreshes that file: no OpenClaw process,
  no other consumer of the refresh token; the gateway's own readers use the
  access token only. Remote employees log in on their own host.

What it does not establish is *why* the refresh token was refused at 02:00.
Claude Code was not running with debug logging, so the refresh response is not
recorded. The two candidates are a rotation race — four long-lived `claude` processes
parked on the usage limit since 21:23–01:00 shared the file through the hour
in which the access token expired, and Claude Code runs a proactive refresh
ahead of expiry; a process refreshing from stale in-memory credentials after
another had already rotated the pair would be refused, and some providers
revoke the whole token family on reuse — and a server-side revocation.
The evidence cannot separate them. That is why the fix is built around
*detecting* the refusal, refusing further launches on the same dead pair, and
alerting with the fix, rather than around a cause we would be guessing at.

Two things that were **not** the cause, and are worth not re-investigating:
the "0 models — no usable OAuth token" warning (it fires whenever the access
token is merely expired between launches, and had fired every six hours for a
month on a healthy gateway), and the sub-agent stall tracked as GEN-52, which
began at 23:01 while auth was fine.
