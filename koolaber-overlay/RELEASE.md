# Release WEBJS WAHA 85f16dc4 (tabs visiveis + WhatsApp foreground)

Data: 2026-08-12 | Autor: Koolb | Registo imutavel.

## Resumo
Imagem `registry.botatende.com/waha-plus-custom@sha256:85f16dc4...`
(cumulativa EXATAMENTE sobre `817dcc38`). Corrige a barra de abas do Chromium
sem tocar na logica funcional/midia/persistencia.

## Cadeia de imagem (lineage)
- Base virtual: `registry.botatende.com/waha-plus-custom@sha256:817dcc38...`
  (engine WEBJS v7.1 + patches refreshQR/id-guard/auth180 + overlay webjs-browser-tabs).
- Base engine (source): branch `core` do repo botatende/waha.
- Overlay aplicado (este release): `koolaber-overlay/core/engines/webjs/webjs-browser-tabs.{ts,js}`.

## Overlay (o que este release muda)
Unico modulo alterado em relacao a 817dcc38:
- `webjs-browser-tabs.ts/.js`:
  - Removido `--kiosk` incondicional.
  - `--start-maximized` quando `openGoogle===true` (WAHA_WEBJS_OPEN_GOOGLE_TAB=true):
    barra de abas do Chromium VISIVEL.
  - Apos abrir a aba Google em background (idempotente via `openGoogleTabInBackground`),
    re-foca a aba WhatsApp (`Page.bringToFront` padrao, nao experimental/destrutiva):
    WhatsApp permanece a aba ativa de primeiro plano.
  - Sem Google habilitado => `--kiosk` (fallback/contrato original).
  - Nada de Target.createTarget manual, bringToFront experimental, ou manipulacao
    destrutiva de abas.

## Checksums (arquivos exatos no binario 85f16dc4)
- `webjs-browser-tabs.ts` (source, vivo) sha256=`e598777dc9b9c4a37b857b98e61509a8c38881d23796679122c23f3c908ff01a`
- `webjs-browser-tabs.js` (compilado, vivo) sha256=`084f7b44d0f14880a08b8f9eaabb6c3a9c9f032ccfa38e155a65acdfcd3939fb`

## Receita de build (cumulativa)
1. `docker pull registry.botatende.com/waha-plus-custom@sha256:817dcc38...`
2. Overlay `koolaber-overlay/core/engines/webjs/webjs-browser-tabs.{ts,js}` -> `/app/dist/core/engines/webjs/`
3. Build/tag final -> push -> resolver digest.
Digest imutavel final: `sha256:85f16dc4...`.

## Rollback
- WAHA: `817dcc38`. wa-connect `ec379b3b` e bridge `c96d04f9` INTOCADOS nesse release.
