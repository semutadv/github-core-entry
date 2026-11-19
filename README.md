[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/semutadv/github-core-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/semutadv/github-core-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-forge

A GitHub-compatible git forge in a single Node process — stdlib only
(`node:http`, `node:crypto`, `node:zlib`), no npm dependencies, no git binary.

Entry for make.fun contest **github-core-clone-01** — "Build a GitHub-compatible
git forge" (pot $500, deadline 2026-11-21 13:30 WIB).

Contest page: https://make.fun/bounty/github-core-clone-01

## Surfaces (one in-memory store shared by all four)

- **Smart HTTP git** — `GET info/refs` (v2 advertisement + v0 fallback),
  `POST git-upload-pack` (v2 `ls-refs`/`fetch`, v0 side-band-64k),
  `POST git-receive-pack` v0 (report-status, side-band-64k, delete-refs,
  fast-forward only; non-FF refs get `ng <ref> non-fast-forward`).
  Own SHA-1 object store (commit/tree/blob/tag), packfile writer + reader.
- **REST v3** at `/api/v3` — repos, branches, commits, git refs, contents
  (real blob+tree+commit writes, cloneable via git), labels, issues,
  pull requests, squash merge (3-way merge, conflict → 405).
- **GraphQL** at `/api/graphql` — viewer, repository, issues, pull requests,
  mutations, introspection (`__type`).
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, protocol revision
  `2026-07-28`, 6 tools: `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.

Auth: `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` on `/api/v3`, `/api/graphql`,
`/mcp` (no header → 401). Git endpoints and `/healthz` are unauthenticated.

## Determinism

IDs come from counters, commit timestamps from a fixed epoch + sequence,
responses are in stable order — no wall clock or randomness in scored output.
The viewer login is derived from the published scenario PRNG (kit `wire.ts`).

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port and registers with `$MAKEFUN_ENV_URL`
(the trial harness). For local testing, start the app directly:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types -e "
import('./app.ts').then(({ createApp }) => {
  const s = createApp();
  s.listen(0, () => console.log(s.address().port));
});"
```

Then run the kit conformance suite from the kit directory:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token --perf --json
```

`dev-server.ts` is a local-only helper (not part of the trial entry) that
starts the forge on an ephemeral port for testing.

## Layout

- `main.ts` — entry ↔ env lifecycle (unchanged from the starter).
- `app.ts` — the whole forge (git store + smart HTTP + REST + GraphQL + MCP).
- `package.json`, `tsconfig.json`, `LICENSE` — starter files, unchanged.
