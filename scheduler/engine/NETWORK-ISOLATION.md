# Network isolation for the crawler (VPS)

The engine keeps Chrome away from private addresses in software (`src/safe-fetch.ts`, `src/guard-proxy.ts`). On the VPS add the same rule in the
operating system, so that a bug or a Chrome flag change cannot open a way around it. Two rules, both on the server's firewall:

1. **Chrome may talk only to this machine's loopback.** It reaches the internet only through the guard proxy (which runs in the engine's process).
2. **The engine may not connect to private, loopback-other-than-itself, link-local or metadata addresses**, so the proxy cannot be talked into one.

Run Chrome as its own user (for example `socialchrome`) by setting `CHROME_PATH` to a wrapper that does `exec sudo -u socialchrome google-chrome "$@"`, or run the
whole engine under systemd with `User=` and `IPAddressDeny=`. With nftables (adjust the user names):

```
table inet social_auto {
  chain output {
    type filter hook output priority 0; policy accept;

    # Rule 1: the Chrome user may use loopback only (the guard proxy listens there), nothing else.
    meta skuid "socialchrome" oifname "lo" accept
    meta skuid "socialchrome" drop

    # Rule 2: the engine user may not reach private, link-local, metadata or carrier-grade ranges.
    meta skuid "socialauto" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 0.0.0.0/8, 192.0.0.0/24, 198.18.0.0/15 } drop
    meta skuid "socialauto" ip6 daddr { fc00::/7, fe80::/10, ::1, 64:ff9b::/96, 2001::/23, 2001:db8::/32, 2002::/16 } drop
  }
}
```

Check it after every deploy (these must all fail, from the engine host):

```
sudo -u socialchrome curl -m 3 https://example.com        # must fail: Chrome's user has no route out
sudo -u socialchrome curl -m 3 http://169.254.169.254/    # must fail
sudo -u socialauto  curl -m 3 http://169.254.169.254/     # must fail
sudo -u socialauto  curl -m 3 https://example.com         # must work
```

The software tests that prove the in-process half are in `src/safety-gate.test.ts` and `src/guard-proxy.test.ts`. This file is the part the tests cannot prove on a developer's Mac.
