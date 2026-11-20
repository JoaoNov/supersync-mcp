# Account mapping

The HTTP service checks one static bearer key and uses the single account in `secrets/accounts.json`. The key is not a SuperSync access token. SuperSync credentials stay in the file named by `credentialsPath`.

```json
{
  "accounts": [
    {
      "id": "owner",
      "credentialsPath": "secrets/supersync.json",
      "dataDir": "data"
    }
  ]
}
```

Paths resolve from the service working directory. The service refuses to start when the file does not contain exactly one account. The data directory is bound to that account id on first open. Pointing the same directory at a different id fails closed.

The library can still keep separate caches, outboxes, and device ids when tests construct more than one account. The running server does not select among accounts.

Writes are not a second identity. Set `MCP_ALLOW_WRITES=true` to register write tools, then recreate the container. With the flag unset, write tools are not listed and are not callable.
