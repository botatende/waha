# Koolaber GOWS 2026.8.1

This branch tracks the official WAHA `2026.8.1` source without WEBJS,
Puppeteer, RemoteAuth, or wa-connect custom patches.

## Source

- Upstream tag: `2026.8.1`
- Upstream commit: `382c1a7e94a07dd1085ee0ad6661fdf1c14cb4e1`
- Runtime engine: `GOWS`
- WAHA tier reported by the official image: `CORE`
- Bundled GOWS asset: `gows-plus v1.0.45`
- Bundled dashboard: `/app/dist/dashboard`

The official image bundles the GOWS binary and Dashboard as build assets.
There is no `src/plus` source directory in the official release or in the
Koolaber frozen backup. Do not create or copy an artificial `src/plus` tree.

## Images

- Official source image: `devlikeapro/waha:gows-2026.8.1`
- Koolaber registry mirror: `registry.botatende.com/waha-gows@sha256:0e9de3859999fde842dbc02a1f4b53ad6d2253ec789e7e6c998592c093247152`
- Current GOWS rollback: `registry.botatende.com/waha-plus-custom@sha256:73d3c01bacb0f26f04c3d63fef8d970e273484f36db0b8c7416a216d26970f61`

## Offline backup

- Server path: `/root/backups/waha-gows-official-2026.8.1/`
- OCI tar: `waha-gows-official-2026.8.1.tar`
- OCI tar SHA-256: `3d37b9c887d71cf24876d896219d5fd746dec74af97092618401360c62f97aad`
- Checksums: `SHA256SUMS.txt`

## Deployment policy

Validate this release first in one isolated managed GOWS canary. Existing GOWS
workers, direct instances, WEBJS workers, wa-connect, sessions, Redis,
PostgreSQL, and PVCs must remain unchanged until the canary is approved.

After approval, `botatende/wahab` is the source of truth for the managed
deployment and must pin `WAHA_IMAGE_GOWS` by immutable digest.
