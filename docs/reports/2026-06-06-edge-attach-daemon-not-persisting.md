# 2026-06-06: Edge attach reports success but daemon state is immediately lost

## Context

While debugging Conduit remote-display sessions in Microsoft Edge, Edge was already running with CDP enabled on port `9222`.

Direct CDP was healthy:

```sh
curl -fsS http://127.0.0.1:9222/json/version
```

Returned browser metadata including:

```json
{
  "Browser": "Edg/148.0.3967.96",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/..."
}
```

## Repro

```sh
ghax attach --port 9222
ghax tab 360ECE029D944BF66CD42FB3A14D98AE
```

Observed:

```text
ghax: daemon (pid 82926) is not running — run `ghax attach`
```

After clearing stale state:

```sh
ghax restart
ghax attach --port 9222 --verbose
ghax status --json
```

Observed:

```text
stale state file cleared
attached — pid 86290, port 65154, browser edge
not attached
```

## Expected

After `ghax attach --port 9222`, subsequent `ghax status`, `ghax tab`, `ghax eval`, and `ghax network` commands should use the attached browser until `ghax detach` or `ghax restart`.

## Notes

- The browser target list was available through direct CDP at `http://127.0.0.1:9222/json/list`.
- Direct CDP evaluation against `ws://127.0.0.1:9222/devtools/page/<tab-id>` worked.
- `ghax attach --port 9222 --verbose` reported an unexpected control port (`65154`) and then no persisted attachment.
- This made `ghax network` and other follow-up commands unreliable during Conduit testing.

## Repro Again During Conduit Tile Artifact Hotpatch

Later the same day, after deploying the Conduit relay/dashboard web hotpatch, the
same attach persistence failure reproduced:

```sh
ghax status --json
# not attached

ghax attach --browser edge --port 9222 --verbose
# attached — pid 43179, port 64098, browser edge

ghax tabs
# ghax: daemon (pid 43179) is not running — run `ghax attach`
```

This blocked a post-deploy visual check of the Conduit remote tab through ghax.
