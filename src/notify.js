#!/usr/bin/env node
/**
 * Envia o resumo de mudanças (saida/ultima-mudanca.md) para o WhatsApp do
 * Guilherme via Houzbot (API do Chat Houzzes / Atende Chat).
 *
 * Configuração por variáveis de ambiente (secrets no GitHub Actions):
 *   HOUZBOT_API_URL — endpoint de envio de mensagem da API do Chat Houzzes
 *   HOUZBOT_TOKEN   — token de autenticação
 *   HOUZBOT_DESTINO — número de WhatsApp de destino (ex.: 55DDDNÚMERO)
 *
 * Sem as variáveis, apenas loga o resumo e sai com 0 (não derruba o job).
 */

const fs = require("fs");
const path = require("path");

const ARQ_RESUMO = path.join(__dirname, "..", "saida", "ultima-mudanca.md");

async function main() {
  let resumo;
  try {
    resumo = fs.readFileSync(ARQ_RESUMO, "utf8");
  } catch {
    console.log("Sem resumo de mudanças — nada a notificar.");
    return;
  }

  const { HOUZBOT_API_URL, HOUZBOT_TOKEN, HOUZBOT_DESTINO } = process.env;
  const mensagem = `🛒 *FM Shop — monitor de preços/estoque*\n\n${resumo}\n\nDoc novo pronto para subir na Julia (repo fmshop-estoque-precos, saida/).`;

  if (!HOUZBOT_API_URL || !HOUZBOT_TOKEN || !HOUZBOT_DESTINO) {
    console.log("Houzbot não configurado (secrets ausentes). Resumo:\n\n" + mensagem);
    return;
  }

  // [AJUSTAR quando os dados da API do Chat Houzzes forem confirmados —
  //  formato do body/headers pode divergir.]
  const r = await fetch(HOUZBOT_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HOUZBOT_TOKEN}`,
    },
    body: JSON.stringify({ number: HOUZBOT_DESTINO, body: mensagem }),
  });
  if (!r.ok) {
    console.error(`Falha no envio Houzbot: HTTP ${r.status} — ${await r.text()}`);
    process.exit(1);
  }
  console.log("Notificação enviada via Houzbot.");
}

main().catch((e) => {
  console.error("Erro no notificador:", e);
  process.exit(1);
});
