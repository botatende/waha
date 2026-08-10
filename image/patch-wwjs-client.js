#!/usr/bin/env node
/*
 * patch-wwjs-client.js - Aplica fix refreshQR com fallback condicional.
 * Corrige o bug onde `Cmd.refreshQR()` era chamado incondicionalmente.
 * - Torna a arrow function async (para permitir await).
 * - Usa launchUtils?.refreshQR() se existir; NUNCA Cmd sem verificar funcao.
 * Idempotente.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'Client.js'
);

if (!fs.existsSync(target)) {
  console.error('Client.js nao encontrado: ' + target);
  process.exit(1);
}
let code = fs.readFileSync(target, 'utf8');

if (code.includes('launchUtils?.refreshQR')) {
  console.log('patch-wwjs-client: ja aplicado. Nada a fazer.');
  process.exit(0);
}

const oldSeq = "window.require('WAWebCmd').Cmd.refreshQR();";
if (!code.includes(oldSeq)) {
  console.error('patch-wwjs-client: chamada nao encontrada (formato inesperado).');
  process.exit(1);
}

// Torna a arrow function async (o bloco de refresh usa await).
code = code.replace('await this.pupPage.evaluate(() => {', 'await this.pupPage.evaluate(async () => {');

const newSeq =
  "const launchUtils = window.require('WAWebLaunchSocketUtils');\n" +
  "if (typeof launchUtils?.refreshQR === 'function') {\n" +
  "  await launchUtils.refreshQR();\n" +
  "} else if (window.require('WAWebCmd').Cmd &&\n" +
  "           typeof window.require('WAWebCmd').Cmd.refreshQR === 'function') {\n" +
  "  await window.require('WAWebCmd').Cmd.refreshQR();\n" +
  "}";

code = code.replace(oldSeq, newSeq);
fs.writeFileSync(target, code, 'utf8');
console.log('patch-wwjs-client: FIX APLICADO (async + launchUtils fallback condicional).');
process.exit(0);
