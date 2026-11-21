# Deployment

Run the service with Docker Compose. Authentication is a static bearer access key, not an identity provider. There is no issuer, audience, or client-role configuration.

Follow [SETUP.md](../SETUP.md) for the key file, the listen address and port, and how a client connects.

The process listens on `LISTEN_HOST`:`PORT` inside the container (default `0.0.0.0:1901`). Compose publishes that port on `MCP_BIND_ADDRESS`:`MCP_HOST_PORT` (default `127.0.0.1:1901`). Change the bind address when a private network interface should accept connections. Do not publish `0.0.0.0` unless the host firewall already drops every other source.

`/healthz` is for the container healthcheck. Clients use `POST /mcp` with `Authorization: Bearer <key>`.

An optional same-host proxy is sketched in [examples/nginx.conf](../examples/nginx.conf). The `Host` header it forwards must be listed in `ALLOWED_HOSTS`.

To publish the loopback listener through a Cloudflare Tunnel, keep `MCP_BIND_ADDRESS=127.0.0.1`, add the public hostname (for example `mcp.example.com`) to `ALLOWED_HOSTS`, and send `CF-Access-Client-Id`, `CF-Access-Client-Secret`, and `Authorization: Bearer <key>`. The steps are in the README. The Access service token does not replace the bearer key.
