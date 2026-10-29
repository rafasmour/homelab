# Pi-hole

## Description

Network DNS filtering with its web interface at `https://pihole.${DOMAIN}`.

## Setup

Copy `.env.example` to `.env`, set `PIHOLE_BIND_IP` to the Docker host's LAN address and `PIHOLE_WIREGUARD_BIND_IP` to its WireGuard address, replace both credentials, and run `docker compose --env-file .env up -d`. TCP and UDP port 53 are published only on those two addresses; the web interface is exposed through Traefik on the external `webgateway` network and is not published directly on the host.

Bring `wg0` up before this stack. Docker binds DNS to `PIHOLE_WIREGUARD_BIND_IP` at container start. If that address is missing, the daemon fails with exit 255 (`cannot assign requested address`) and does not retry, even with `restart: unless-stopped`. After WireGuard is assigned, recreate:

```bash
docker compose --env-file .env up -d --force-recreate
```

## Backup and important notes

Pi-hole authentication and the Homepage widget both use the double-hashed `WEBPASSWORD`. Back up `.env` and `etc-pihole`.

The upstream image reissues its self-signed `tls.pem` two days before expiry
only when FTL still recognises it as its own. Under image 2025.11.1, FTL
did not recognise its own certificate and logged `not a Pi-hole certificate. Please renew it
manually!`. To renew the certificate, move `etc-pihole/tls.pem`, `tls.crt` and
`tls_ca.crt` out of the way and recreate the container. FTL then generates a
new certificate for `webserver.tls.validity` days (47 by default). Traefik talks
to port 8080 over plain HTTP, so this certificate only matters for direct
connections to port 8443.

The service sets `oom_score_adj: -500` and `mem_reservation: 64m`, so under
memory pressure the kernel kills model servers before it kills DNS.

## Network notes: WireGuard and large downloads

All WireGuard clients (`10.15.0.x`) resolve through this Pi-hole on
`PIHOLE_WIREGUARD_BIND_IP`. The host's `wg0` is a full tunnel to the VPS, so a
multi-gigabyte model download can saturate it. Clients then time out on DNS and
everything else, even though Pi-hole itself is healthy. A DNS query sent from
the host to its own `10.15.0.3` also times out because the reply is routed into
the tunnel. Test from the host with the LAN address (`dig @192.168.10.2
example.com`) or from a real WireGuard peer.

### Shape wg0 so DNS and interactive traffic survive downloads

CAKE caps egress on `wg0` and keeps small flows, such as DNS and SSH, ahead of
bulk transfers. Choose a value somewhat below the VPS link's real throughput.
Run once (temporary until reboot or until `wg0` is recreated):

```bash
sudo tc qdisc replace dev wg0 root cake bandwidth 40mbit
tc -s qdisc show dev wg0      # verify
```

To make it persistent, add the following lines to the `[Interface]` section of
`/etc/wireguard/wg0.conf` and restart the tunnel. This briefly interrupts every
WireGuard client.

```ini
PostUp = tc qdisc replace dev %i root cake bandwidth 40mbit
PreDown = tc qdisc del dev %i root || true
```

```bash
sudo systemctl restart wg-quick@wg0
```

To undo, remove both lines, then run:

```bash
sudo tc qdisc del dev wg0 root
```

`tc` on `wg0` shapes only what the host sends into the tunnel. A download comes
back into the tunnel from the VPS, so the hard limit for downloads belongs on
the VPS end of the tunnel, in its own `wg0.conf`, using the same lines.
Alternatively, limit the downloader itself.

### Limit Hugging Face download concurrency

```bash
# One file at a time (default 8) and a fixed, small Xet connection count
# instead of the adaptive one. Leave HF_XET_HIGH_PERFORMANCE unset.
HF_XET_FIXED_DOWNLOAD_CONCURRENCY=4 \
  hf download <repo> <file.gguf> --local-dir <dir> --max-workers 1
```

From Python, use the same environment variable and
`snapshot_download(..., max_workers=1)`. Running large pulls overnight, such as
with `systemd-run --on-calendar=03:00` or `at 03:00`, avoids the problem
entirely. Model pulls by the llama.cpp router run inside its container and
ignore these flags, so only `tc` (preferably on the VPS) limits them.

### Fallback DNS for WireGuard clients

In each client's `[Interface]` section, add a second resolver:

```ini
DNS = 10.15.0.3, 1.1.1.1
```

Re-import or reconnect the client afterwards. Trade-off: when Pi-hole is slow or
unreachable, the client falls back to `1.1.1.1`, and those queries are not
ad-blocked or logged. Some operating systems also send queries to both resolvers
in parallel, so blocking becomes best-effort. Local names served only by
Pi-hole will not resolve through the fallback. Keep a single DNS entry if
filtering must be strict.
