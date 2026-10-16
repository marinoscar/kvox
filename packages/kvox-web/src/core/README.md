# core

The web host ports of `@marinoscar/kvox-web`.

## Purpose and scope

What every packaged page needs from the app that mounts it: the API transport, the signed-in viewer and the settings page binding. The app provides them once; the pages read them through hooks. This slice imports no `@marinoscar/platform-web` module.

Status: scaffold. The slice exports one marker, `KVOX_WEB_CORE`; the ports arrive with Epic 7.

## Entry point

`@marinoscar/kvox-web/core`. The slice depends on no other slice.

## Peer dependencies

`@marinoscar/kvox-contract`, `react` and `react-dom`, all required.

## Configuration

None.

## Extension-point catalog

None.
