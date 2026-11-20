# SuperSync MCP

Private Docker bridge that decrypts one Super Productivity SuperSync account and serves MCP tools over stateless Streamable HTTP at `/mcp`. It does not run the Super Productivity GUI.

This tree is a private adaptation of the MIT-licensed project [yamichi77/supersync-mcp](https://github.com/yamichi77/supersync-mcp) at commit `6eec7c2c69e3741c11745b8a8dd34ca063d78f43`. That commit is recorded in [docs/bridge-upstream.json](docs/bridge-upstream.json) so a later upstream update can be diffed. The original MIT notice is [LICENSE](LICENSE). Third-party Super Productivity code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

It is not part of the official Super Productivity project. It is a single-account service: one bearer key, one SuperSync account, read-only unless writes are turned on.

## Tools

| Kind | Tools |
|---|---|
| Status and lookup | get_sync_status / list_tasks / get_task |
| Lists | list_projects / list_tags / list_archived_tasks |
| Boards | get_board |
| Create and edit | create_task / update_task |
| Done and reopen | complete_task / reopen_task |
| Tags | update_task_tags |
| Standard Kanban | set_task_kanban_status |
| Projects | create_project / move_task |
| Boards | create_board / update_board |

Version 0.3.0 defines 17 tools. With writes off, only the 7 read tools are registered. Successful results use `structuredContent` and a JSON text fallback.

- Tag updates keep tags that are not named. TODAY follows the due day and is not a normal tag.
- Standard Kanban accepts `todo`, `in_progress`, and `done`. In progress uses the `KANBAN_IN_PROGRESS` tag.
- `update_task` does not change `projectId`. `move_task` sends `[Task Shared] moveToOtherProject` for a top-level task and its subtasks.
- Task text updates change `title` and `notes`. Archive restore, delete, and card reordering are not provided.
- Boards take a name, 1 to 50 columns, existing tags, and done, schedule, or backlog filters. They do not force eight states or mutual exclusion.
- `update_board` changes settings of existing columns and keeps column order, card placement, project scope, and task bodies.
- Argument limits are in [docs/BOARD-API-REVIEW.md](docs/BOARD-API-REVIEW.md).
- MCP is stateless Streamable HTTP on `POST /mcp`.

## What you need

- An Ubuntu host with Docker Compose. Node.js 24 and tar are enough to build and test.
- One encrypted SuperSync account, its access token, and its encryption password.
- A local access key of at least 32 random bytes. Clients send it as `Authorization: Bearer <key>`.
- A listen address and port. The default publish is `127.0.0.1:1901`.

Server setup is in [SETUP.md](SETUP.md).

## First build

From this directory:

```sh
cp .env.example .env
mkdir -p secrets data
chmod 700 secrets data
cp examples/supersync.json secrets/supersync.json
cp examples/accounts.json secrets/accounts.json
openssl rand -base64 32 > secrets/access.key
chmod 600 secrets/*.json secrets/access.key

# Replace the placeholders in secrets/supersync.json.
# If this host's uid/gid is not 1000, set LOCAL_UID and LOCAL_GID in .env.
docker compose run --rm dev npm ci
docker compose run --rm dev npm run setup
docker compose run --rm dev npm run build
docker compose run --rm dev npm run check
docker compose run --rm dev npm test
```

`npm run setup` downloads the Super Productivity revision pinned in [upstream.json](upstream.json), checks its SHA-256, and unpacks it into `vendor-source/`. It stops when the download or the checksum fails. Do not edit `vendor-source/` or mix another revision into that directory. A Super Productivity update has to move the pin, `vendor/`, the extracted adapter, and the regression tests together.

Then:

```sh
docker compose up -d mcp
docker compose exec -T mcp node --import tsx src/smoke-read.ts
```

`smoke-read.ts` needs the real SuperSync credentials. The unit tests do not.

## Configuration

| Item | Meaning |
|---|---|
| `MCP_BIND_ADDRESS`, `MCP_HOST_PORT` | Host interface and port published by Docker. Default `127.0.0.1:1901`. |
| `LISTEN_HOST`, `PORT` | Address and port inside the container. Default `0.0.0.0:1901`. |
| `ALLOWED_HOSTS` | `Host` values accepted for DNS-rebinding protection. Loopback is always included. |
| `MCP_ALLOW_WRITES` | Default `false`. Write tools are registered only when this is `true`. |
| `TZ` | Timezone for calendar days. Default `Europe/Brussels`. |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | Per-client-address limit. Default 120 requests per 60 seconds. |
| `secrets/access.key` | Bearer key, mode `0600`. A trailing newline is ignored. `ACCESS_KEY` is accepted when the file is absent. |
| `secrets/supersync.json` | SuperSync URL, access token, and encryption password. Mode `0600`. |
| `secrets/accounts.json` | The one local account id, credential path, and data directory. |

Secrets and real environment files are not in git. Do not paste tokens, the encryption password, the database, or backups into an issue or a log. On Linux, a credential or key file that is readable by group or other is refused. Native Windows file modes are not what this service checks. Use the Linux container.

## Writes and retries

Each write needs a unique `requestId` and the `expectedServerSeq` from the latest read. When the result is unknown, retry with the **same request id and the same arguments**.

- `STALE_REVISION_READ_AGAIN`: read the latest state, check the intent, and send a new request id.
- `WRITE_PENDING_RETRY_SAME_REQUEST`: the previous upload is still unresolved. Retry that request. Do not start a different write.
- `WRITE_REJECTED`: the server rejected the operation. Nothing is overwritten automatically.

The encrypted body is stored in the SQLite outbox before it is sent. A request that already succeeded returns the stored result and is not sent again. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

Write operations set `entityId` and do not set `entityIds`. Official clients attach `entityIds` so SuperSync can describe conflicts that touch more than one entity. Concurrent edits can be rejected with less context than the official app would show. This fork records that limit and does not rewrite the upload path.

## Develop and test

With Node.js 24 and tar:

```sh
npm ci
npm run setup
npm run build
npm run check
npm test
```

Tests use public fixtures and fake HTTP. They do not need personal credentials. GitHub Actions runs the same sequence.

**`src/smoke-write.ts` creates and changes tasks on the real account.** It is not part of the tests or CI. Run it only on an account you intend to modify. `src/probe.ts` and `src/inspect-shapes.ts` are diagnostic scripts. Read their output before sharing it.

## Scope

Create and update cover [schedules and deadlines](docs/TASK-DATES.md), [standard reminders](docs/TASK-REMINDERS.md), and [subtasks](docs/TASK-SUBTASKS.md). Calendar days use `TZ`, default `Europe/Brussels`. Whether a reminder is shown depends on the Super Productivity app that syncs this account and on that device's notification permission.

The adapter targets the Super Productivity revision in [upstream.json](upstream.json) and schema version 4. It does not promise compatibility with other versions or every official operation.

It stops on an unknown operation, a new schema, a decryption failure, a gap it cannot repair, or a repair whose cause it cannot check. It does not run browser effects such as GUI notifications or external issue updates. The encrypted log is on disk. Decrypted state stays in process memory. Run this process only on a host you trust.

## Secret scanning before commit

`.pre-commit-config.yaml` pins Betterleaks v1.9.0 at commit `81aff7a638638aae3a659845d089043e1d8fe9ac`. Install pre-commit in each clone and run `pre-commit install --install-hooks`. Later commits scan the staged diff and stop when it matches. The first run needs a network connection to fetch the scanner. Cloning the config does not enable the git hook by itself.

That hook scans the staged diff. `pre-commit run --all-files` does not become a scan of every unstaged file under this config. Before the first publish, also run the same Betterleaks version as `betterleaks dir --redact` on the directory you intend to publish and `betterleaks git --log-opts="--all" --redact` on the repository. Do not treat a working tree that contains build output or real data as the publish set. Keep `.gitignore` in force. Do not force-add tokens, keys, `data/`, or `secrets/`. Skipping the hook does not mean every secret type will be detected.

## License

MIT. See [LICENSE](LICENSE). Copyright notices on code imported from Super Productivity are kept. Sources are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The bridge itself remains under the upstream MIT license; this adaptation does not relicense it.
