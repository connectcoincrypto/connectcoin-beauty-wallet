# Persistent claims helper protocol 3

An attempt emits `started` when TCP starts, `capture` when that capture finishes,
then one terminal `attempt` result. The terminal result repeats the capture's
status, elapsed seconds and exact successful-connection count. A failed capture
does not consume the successful-capture budget. Cancellation, retry scheduling,
proof verification and the ten-second connection deadline are unchanged.

The terminal result's optional `message` contains only a fixed description:

- `TLS connection timed out` for socket timeout exceptions or expiry of the
  capture's absolute handshake deadline.
- `TLS capture or proof validation failed` for other capture/verification errors.
- `TLS capture cancelled` for cancelled captures.
- `Public DNS resolution is required` when the attempt could not start.

The desktop accepts these descriptions and replaces any other supplied message
with the generic capture failure. Fatal `error` frames use a fixed desktop
description too. Exception text, certificates, peer data and socket details are
never included in these descriptions. The existing diagnostics classifier maps
`TLS connection timed out` to `timeout` without changing the protocol version or
frame shape; older helpers' generic failure descriptions remain accepted.
