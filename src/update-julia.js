#!/usr/bin/env node
/**
 * FM Shop — sincroniza o doc de preços com a Julia (GPT Maker) via API
 * OFICIAL (developer.gptmaker.ai). Fluxo seguro:
 *
 *   1. Confirma a identidade do agente (GET /v2/agent/{id} → name tem
 *      que ser "Julia"). A chave de API é única da conta — esta trava
 *      garante que NUNCA tocamos outro agente por engano.
 *   2. Lista os treinamentos DOCUMENT atuais da Julia.
 *   3. MODE=dry-run: só loga o que faria e sai.
 *      MODE=full: cria o treinamento novo (documentUrl público),
 *      espera ele aparecer treinado e SÓ ENTÃO exclui os antigos de
 *      mesmo nome. Qualquer falha antes disso preserva o doc antigo.
 *   4. Registra tudo em saida/julia-sync-log.md (o workflow commita).
 *
 * Env:
 *   GPTMAKER_API_KEY  — chave de API (secret no GitHub Actions)
 *   DOC_URL           — URL pública IMUTÁVEL do doc (raw pinado no SHA)
 *   MODE              — "dry-run" (padrão) | "full"
 *
 * Sai com 0 em sucesso/dry-run; 1 em qualquer falha (job fica vermelho).
 */

const fs = require("fs");
const path = require("path");

const API = "https://api.gptmaker.ai/v2";
const AGENT_ID = "3E22C85CD272807E9D886A87BAFD9D52"; // Julia — FM Shop
const NOME_ESPERADO = "julia"; // trava de identidade (case-insensitive)
const DOC_NAME = "produtos_fmd_atualizados.txt";
const ARQ_LOG = path.join(__dirname, "..", "saida", "julia-sync-log.md");

const { GPTMAKER_API_KEY, DOC_URL, MODE = "dry-run" } = process.env;

const linhasLog = [];
function log(msg) {
  console.log(msg);
  linhasLog.push(`- ${msg}`);
}

function gravarLog(resultado) {
  const dataBR = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const bloco = [`## ${dataBR} — MODE=${MODE} — ${resultado}`, "", ...linhasLog, "", ""].join("\n");
  fs.mkdirSync(path.dirname(ARQ_LOG), { recursive: true });
  fs.appendFileSync(ARQ_LOG, bloco);
}

async function api(metodo, rota, body) {
  const r = await fetch(`${API}${rota}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${GPTMAKER_API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texto = await r.text();
  let json;
  try { json = JSON.parse(texto); } catch { json = texto; }
  if (!r.ok) throw new Error(`${metodo} ${rota} → HTTP ${r.status}: ${texto.slice(0, 300)}`);
  return json;
}

async function listarDocs() {
  const r = await api("GET", `/agent/${AGENT_ID}/trainings?type=DOCUMENT&page=1&pageSize=100`);
  const itens = Array.isArray(r) ? r : r.data || [];
  return itens.filter((t) => (t.documentName || "") === DOC_NAME);
}

async function main() {
  if (!GPTMAKER_API_KEY) throw new Error("GPTMAKER_API_KEY ausente.");
  if (!DOC_URL) throw new Error("DOC_URL ausente.");

  // 1. Trava de identidade — jamais mexer em agente que não seja a Julia.
  const agente = await api("GET", `/agent/${AGENT_ID}`);
  const nome = (agente.name || "").trim();
  log(`Agente ${AGENT_ID}: name="${nome}" jobName="${agente.jobName || ""}"`);
  if (nome.toLowerCase() !== NOME_ESPERADO) {
    throw new Error(`TRAVA DE IDENTIDADE: esperava "Julia", veio "${nome}". Nada foi alterado.`);
  }

  // 2. Estado atual.
  const antes = await listarDocs();
  log(`Docs "${DOC_NAME}" existentes: ${antes.length} [${antes.map((t) => t.id).join(", ")}]`);
  const idsAntes = new Set(antes.map((t) => t.id));

  // 3. Confere que a DOC_URL responde antes de criar o treinamento.
  const head = await fetch(DOC_URL);
  if (!head.ok) throw new Error(`DOC_URL inacessível (HTTP ${head.status}): ${DOC_URL}`);
  const conteudo = await head.text();
  const nProdutos = (conteudo.match(/PRODUTO:/g) || []).length;
  log(`DOC_URL ok (${conteudo.length} bytes, ${nProdutos} produtos)`);
  if (nProdutos < 40) throw new Error(`Sanidade: só ${nProdutos} produtos no doc (<40). Abortado.`);

  if (MODE !== "full") {
    log(`DRY-RUN: criaria treinamento novo com ${DOC_URL} e depois excluiria ${antes.length} antigo(s). Nada foi alterado.`);
    return "DRY-RUN OK";
  }

  // 4. Cria o treinamento novo.
  await api("POST", `/agent/${AGENT_ID}/trainings`, {
    type: "DOCUMENT",
    documentUrl: DOC_URL,
    documentName: DOC_NAME,
    documentMimetype: "text/plain",
  });
  log("Treinamento novo criado (POST ok). Aguardando aparecer na listagem…");

  // 5. Espera o novo aparecer (até 5 min) + folga p/ treinar.
  let novo = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const agora = await listarDocs();
    novo = agora.find((t) => !idsAntes.has(t.id));
    if (novo) break;
  }
  if (!novo) throw new Error("Novo treinamento não apareceu na listagem em 5 min. Antigos preservados.");
  log(`Novo treinamento na listagem: ${novo.id}. Folga de 60s para o treino concluir…`);
  await new Promise((r) => setTimeout(r, 60000));

  const confirma = await listarDocs();
  if (!confirma.some((t) => t.id === novo.id)) {
    throw new Error(`Novo treinamento ${novo.id} sumiu da listagem (treino falhou?). Antigos preservados.`);
  }

  // 6. Exclui os antigos (somente os listados ANTES, mesmo nome, dentro da Julia).
  for (const velho of antes) {
    await api("DELETE", `/training/${velho.id}`);
    log(`Excluído doc antigo: ${velho.id}`);
  }

  const fim = await listarDocs();
  log(`Estado final: ${fim.length} doc(s) [${fim.map((t) => t.id).join(", ")}]`);
  if (fim.length !== 1) throw new Error(`Esperava exatamente 1 doc ao final, há ${fim.length}. VERIFICAR NO PAINEL.`);
  return "SUCESSO";
}

main()
  .then((resultado) => {
    gravarLog(resultado);
    console.log(`\n${resultado}`);
  })
  .catch((e) => {
    log(`ERRO: ${e.message}`);
    gravarLog("FALHA");
    console.error(`\nFALHA: ${e.message}`);
    process.exit(1);
  });
