# Operations and limits

One process, one access key, one SuperSync account. Do not point two replicas at the same `data/` directory. When you switch to a different SuperSync account, use a new data directory.

`data/operations.sqlite` stores the encrypted operation log, the download cursor, the sync clock, the client id, and the outbox. The outbox holds the encrypted upload body, the request id, an HMAC of the arguments, the task id, and the result.

Reads are cached for 15 seconds. A write syncs before it sends. A gap is repaired only when a full snapshot decrypts and replays. The client id and outbox are kept. A pending upload whose result is unknown is retried with the same request.

## Backups

Back up the SuperSync account and this service's `data/` and `secrets/` separately. Those copies contain credentials, so encrypt them and restrict access. Use the SQLite backup API, or copy the database only while the service is stopped. Do not copy a live database file by itself.

To roll back the service, restore the matching source, `dist/`, and dependency versions, and keep `data/` and `secrets/`. Do not restore an older SuperSync database as part of a normal service rollback. That can discard newer changes from other devices.

## Limits

- Experimental adapter pinned to the Super Productivity revision in `upstream.json` and schema version 4.
- Unknown operations, unsupported schemas, decryption failures, and unrepairable gaps return an error.
- A conflict on the same entity follows the SuperSync rejection. This service does not overwrite it.
- Write operations set `entityId` and do not set `entityIds`. Official clients attach `entityIds` so SuperSync can return conflict metadata for multi-entity operations (planner days, tags, parent and subtask). Concurrent edits can therefore be rejected with less context than the official client would show. This fork does not invent that list.
- A `REPAIR` whose cause cannot be checked stops the projection.
- Browser effects from the official GUI, including external issue updates and notification delivery, are not run.
- Full replay and download have limits. Large or long-lived accounts need their own check.
- Anyone who can read this process can read decrypted sync data. Run it on a host you trust.

## Stopping and credentials

`docker compose stop mcp` stops the service. The access key has no expiry. To revoke it, replace `secrets/access.key`, recreate the container, and update every client. There is no separate write role: `MCP_ALLOW_WRITES` is read at startup.

This service does not call SuperSync replace-token, because that revokes other devices too. Rotate the SuperSync access token with the official client, then update `secrets/supersync.json`.

## Live checks

`src/smoke-read.ts` reads the configured account. `src/smoke-write.ts` creates and changes a real task. It is not part of the test suite. Run it only against an account you mean to modify. The task is left done, and its id is written to `data/last-smoke-task.json`.
