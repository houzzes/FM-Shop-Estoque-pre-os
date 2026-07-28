#!/usr/bin/env node
/**
 * FM Shop — sincroniza PREÇO E ESTOQUE de cada produto como treinamento de
 * TEXTO na Julia (GPT Maker), via API oficial (developer.gptmaker.ai).
 *
 * POR QUE ISSO EXISTE
 * -------------------
 * Até 28/07/2026 o preço vivia num único treinamento DOCUMENT com 49
 * produtos (~20 KB). A busca vetorial frequentemente não achava o bloco do
 * produto perguntado e o modelo improvisava: informou o preço de uma pá
 * como preço do forno Macte Smart (incidente real com cliente) e inventou
 * "R$ 8.990,00" para o Witt Etna Rotante (preço real: R$ 8.212,00).
 * Instrução não corrige busca. A correção é dar a cada produto seu próprio
 * texto curto, que a busca consegue achar pelo nome.
 *
 * Bônus: a API oficial SÓ permite atualizar treinamento do tipo TEXT
 * ("para os demais treinamentos, é necessário remover e adicionar
 * novamente"). Ou seja, este formato é o único que permite editar no lugar
 * quando um preço muda.
 *
 * SEGURANÇA
 * ---------
 * 1. Trava de identidade: GET /v2/agent/{id} e o name TEM que ser "Julia".
 *    A chave de API é ÚNICA da conta e abre todos os agentes.
 * 2. O script só enxerga treinamentos de texto que começam com o prefixo
 *    PREFIXO. As afirmações escritas à mão (comportamento, escalonamento,
 *    especificações) são INVISÍVEIS para ele e jamais são alteradas ou
 *    excluídas. Esta é a trava mais importante do arquivo.
 * 3. Sanidade: aborta se a coleta trouxer menos de MIN_PRODUTOS.
 * 4. MODE=dry-run (padrão) não escreve nada.
 * 5. Com FILTRO ativo, exclusões e limpeza de duplicados são DESLIGADAS —
 *    rollout parcial nunca apaga nada fora do escopo.
 *
 * Env:
 *   GPTMAKER_API_KEY — chave de API (secret no GitHub Actions)
 *   MODE             — "preview" | "dry-run" (padrão) | "full"
 *   FILTRO           — regex (case-insensitive) aplicada a nome/código.
 *                      Vazio = todos. Ex.: "^Forno para pizza" para o
 *                      rollout da Fase B (só os 7 fornos).
 *
 *   preview  — gera e imprime os textos a partir de data/produtos.json.
 *              NÃO fala com a API, NÃO precisa de chave. Serve para revisar
 *              o conteúdo antes de qualquer contato com a Julia.
 *   dry-run  — consulta a Julia e imprime o plano (criar/atualizar/excluir)
 *              sem escrever nada.
 *   full     — executa o plano.
 *
 * Sai com 0 em sucesso/preview/dry-run; 1 em qualquer falha.
 */

const fs = require("fs");
const path = require("path");

const API = "https://api.gptmaker.ai/v2";
const AGENT_ID = "3E22C85CD272807E9D886A87BAFD9D52"; // Julia — FM Shop
const NOME_ESPERADO = "julia"; // trava de identidade (case-insensitive)

/** Prefixo que marca um treinamento como GERENCIADO por este script.
 *  Treinamento sem este prefixo é intocável. Não mudar sem migração. */
const PREFIXO = "PREÇO E ESTOQUE — ";
const LIMITE_TEXTO = 1028; // limite de caracteres por treinamento (plataforma)
const MIN_PRODUTOS = 40;

/* O e-mail do comercial NÃO vive aqui de propósito (decisão 28/07/2026).
 * O prompt da Julia (sempre em contexto, sem depender de busca) já manda
 * encaminhar "produtos indisponíveis" por e-mail ao Rafael, na seção
 * INFORMAR E-MAIL. Repetir o endereço em cada treinamento seria duplicar
 * um dado que mudaria em 14 lugares se o contato mudasse — e exporia um
 * e-mail num repositório público sem necessidade. O texto do produto só
 * sinaliza a situação; o endereço fica com o prompt. */

const RAIZ = path.join(__dirname, "..");
const ARQ_ESTADO = path.join(RAIZ, "data", "produtos.json");
const ARQ_LOG = path.join(RAIZ, "saida", "julia-sync-precos-log.md");

const { GPTMAKER_API_KEY, MODE = "dry-run", FILTRO = "" } = process.env;

const linhasLog = [];
function log(msg) {
  console.log(msg);
  linhasLog.push(`- ${msg}`);
}

function gravarLog(resultado) {
  const dataBR = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const bloco = [`## ${dataBR} — MODE=${MODE}${FILTRO ? ` — FILTRO=${FILTRO}` : ""} — ${resultado}`, "", ...linhasLog, "", ""].join("\n");
  fs.mkdirSync(path.dirname(ARQ_LOG), { recursive: true });
  fs.appendFileSync(ARQ_LOG, bloco);
}

function brl(n) {
  return "R$ " + n.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
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

/** Monta o texto do treinamento de UM produto.
 *  Formato pensado para a busca achar pelo nome do produto e para o modelo
 *  não conseguir confundir com outro item. */
function textoDoProduto(p, dataBR) {
  const marca = p.marca ? ` (${p.marca})` : "";
  const linhas = [`${PREFIXO}${p.nome}${marca}`, `CÓDIGO: ${p.codigo}`];

  if (p.sobConsulta || !p.precoCartao) {
    // Mesma condição do gerarDoc() em collect.js:221 — mantidas em sincronia.
    linhas.push(
      `PREÇO: não publicado no site. ESTOQUE: ${p.estoque}.`,
      "Não informe preço deste produto, não o recomende e não o use em comparações de valor. Avise que está sem estoque no momento e siga a regra de encaminhamento por e-mail ao comercial."
    );
  } else {
    const prefixo = p.aPartirDe ? "A partir de " : "";
    const pix = p.precoPix ? ` (ou ${prefixo.toLowerCase()}${brl(p.precoPix)} via Pix)` : "";
    const parc = p.parcelamento ? `, ${p.parcelamento}` : "";
    linhas.push(
      `PREÇO: ${prefixo}${brl(p.precoCartao)} no cartão${pix}${parc}`,
      `ESTOQUE: ${p.estoque}`,
      "Este é o único preço válido deste produto. Não use valor de outro produto nem de acessório."
    );
  }

  linhas.push(`LINK: ${p.link}`, `Atualizado em ${dataBR}.`);
  const texto = linhas.join("\n");

  if (texto.length > LIMITE_TEXTO) {
    throw new Error(`Texto do produto ${p.codigo} tem ${texto.length} chars (limite ${LIMITE_TEXTO}).`);
  }
  return texto;
}

/** Normaliza um texto para COMPARAÇÃO de mudança:
 *  - iguala quebras de linha (\r\n → \n);
 *  - descarta a linha "Atualizado em …", senão a data do dia faria todos
 *    os textos parecerem alterados e o sync reescreveria os 49 diariamente.
 *  A data só é reescrita quando o CONTEÚDO muda — é a data da última
 *  mudança real, não do último sync. */
function normalizar(s) {
  return s.replace(/\r\n/g, "\n").replace(/^Atualizado em .*$/m, "").trim();
}

/** Lista TODOS os treinamentos de texto, paginando. */
async function listarTextos() {
  const itens = [];
  for (let page = 1; page <= 20; page++) {
    const r = await api("GET", `/agent/${AGENT_ID}/trainings?type=TEXT&page=${page}&pageSize=100`);
    const lote = Array.isArray(r) ? r : r.data || [];
    itens.push(...lote);
    if (lote.length < 100) break;
  }
  // Diagnóstico de formato: se a API mudar o nome do campo do texto, o
  // sintoma seria "0 gerenciados" — este log entrega a causa na hora.
  if (itens.length) log(`Campos do 1º treinamento retornado: ${Object.keys(itens[0]).join(", ")}`);
  // O campo do texto varia entre a API do painel (description) e a v2 (text).
  return itens.map((t) => ({ id: t.id, texto: t.text ?? t.description ?? "" }));
}

/** SKU declarado dentro de um treinamento gerenciado. */
function codigoDoTexto(texto) {
  const m = texto.match(/^CÓDIGO: (.+)$/m);
  return m ? m[1].trim() : null;
}

/** Carrega e valida o estado da coleta. */
function carregarProdutos() {
  const estado = JSON.parse(fs.readFileSync(ARQ_ESTADO, "utf8"));
  const produtos = estado.produtos || [];
  if (produtos.length < MIN_PRODUTOS) {
    throw new Error(`Sanidade: só ${produtos.length} produtos na coleta (<${MIN_PRODUTOS}). Abortado.`);
  }
  return produtos;
}

/** Aplica o FILTRO (se houver) sobre a lista completa da coleta. */
function aplicarFiltro(produtos) {
  if (!FILTRO) return { alvo: produtos, reFiltro: null };
  const reFiltro = new RegExp(FILTRO, "i");
  const alvo = produtos.filter((p) => reFiltro.test(p.nome) || reFiltro.test(p.codigo));
  log(`FILTRO="${FILTRO}" → ${alvo.length} de ${produtos.length} produtos no escopo.`);
  if (!alvo.length) throw new Error("FILTRO não casou nenhum produto. Abortado.");
  return { alvo, reFiltro };
}

/** MODE=preview — só gera os textos, sem tocar na API. */
function preview() {
  const produtos = carregarProdutos();
  const { alvo } = aplicarFiltro(produtos);
  const dataBR = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const textos = alvo.map((p) => textoDoProduto(p, dataBR));

  const comPreco = alvo.filter((p) => !p.sobConsulta && p.precoCartao).length;
  const maior = Math.max(...textos.map((t) => t.length));
  log(`Preview: ${alvo.length} produtos (${comPreco} com preço, ${alvo.length - comPreco} sem preço publicado).`);
  log(`Maior texto: ${maior} chars (limite ${LIMITE_TEXTO}).`);

  textos.forEach((t, i) => console.log(`\n===== ${i + 1}/${textos.length} (${t.length} chars) =====\n${t}`));
  return "PREVIEW OK";
}

async function main() {
  if (MODE === "preview") return preview();
  if (!GPTMAKER_API_KEY) throw new Error("GPTMAKER_API_KEY ausente.");

  // 1. Trava de identidade — jamais mexer em agente que não seja a Julia.
  const agente = await api("GET", `/agent/${AGENT_ID}`);
  const nome = (agente.name || "").trim();
  log(`Agente ${AGENT_ID}: name="${nome}"`);
  if (nome.toLowerCase() !== NOME_ESPERADO) {
    throw new Error(`TRAVA DE IDENTIDADE: esperava "Julia", veio "${nome}". Nada foi alterado.`);
  }

  // 2. Estado da coleta.
  const produtos = carregarProdutos();
  const { alvo, reFiltro } = aplicarFiltro(produtos);
  const dataBR = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  log(`Coleta: ${produtos.length} produtos${reFiltro ? `; escopo desta execução: ${alvo.length}` : ""}.`);

  // 3. Estado atual na Julia, separando gerenciados de intocáveis.
  const todos = await listarTextos();
  const gerenciados = todos.filter((t) => t.texto.startsWith(PREFIXO));
  log(`Treinamentos de texto na Julia: ${todos.length} (gerenciados: ${gerenciados.length}, intocáveis: ${todos.length - gerenciados.length}).`);

  const porCodigo = new Map();
  const duplicados = [];
  for (const t of gerenciados) {
    const codigo = codigoDoTexto(t.texto);
    if (!codigo) continue;
    if (porCodigo.has(codigo)) duplicados.push(t); // sobra de sync interrompido
    else porCodigo.set(codigo, t);
  }

  // 4. Plano — criar/atualizar SÓ dentro do escopo (alvo).
  const criar = [];
  const atualizar = [];
  const inalterados = [];
  for (const p of alvo) {
    const texto = textoDoProduto(p, dataBR);
    const atual = porCodigo.get(p.codigo);
    if (!atual) criar.push({ p, texto });
    else if (normalizar(atual.texto) !== normalizar(texto)) atualizar.push({ p, texto, id: atual.id });
    else inalterados.push(p.codigo);
  }

  // Exclusão de SKU que sumiu da loja e limpeza de duplicados: SÓ sem
  // FILTRO. Com escopo parcial, o script não tem visão do todo e não
  // apaga nada.
  let excluir = [];
  let limparDuplicados = [];
  if (!reFiltro) {
    const codigosColeta = new Set(produtos.map((p) => p.codigo));
    excluir = [...porCodigo.entries()]
      .filter(([codigo]) => !codigosColeta.has(codigo))
      .map(([codigo, t]) => ({ codigo, id: t.id }));
    limparDuplicados = duplicados;
  } else if (duplicados.length) {
    log(`Aviso: ${duplicados.length} duplicado(s) detectado(s); limpeza adiada (FILTRO ativo).`);
  }

  log(`Plano: criar ${criar.length}, atualizar ${atualizar.length}, excluir ${excluir.length}, sem mudança ${inalterados.length}, duplicados a limpar ${limparDuplicados.length}.`);
  criar.forEach((c) => log(`  + CRIAR  ${c.p.codigo} — ${c.p.nome}`));
  atualizar.forEach((a) => log(`  ~ ATUALIZAR ${a.p.codigo} — ${a.p.nome}`));
  excluir.forEach((e) => log(`  - EXCLUIR ${e.codigo} (sumiu da loja)`));
  limparDuplicados.forEach((d) => log(`  - EXCLUIR duplicado ${d.id}`));

  if (MODE !== "full") {
    log("DRY-RUN: nada foi alterado.");
    console.log("\n--- AMOSTRA DOS TEXTOS GERADOS ---\n");
    for (const p of alvo.slice(0, 3)) console.log(textoDoProduto(p, dataBR) + "\n---");
    return "DRY-RUN OK";
  }

  // 5. Execução. Criar e atualizar antes de excluir: se algo falhar no meio,
  //    o pior cenário é sobra, nunca falta.
  for (const c of criar) {
    await api("POST", `/agent/${AGENT_ID}/trainings`, { type: "TEXT", text: c.texto });
    log(`CRIADO ${c.p.codigo}`);
  }
  for (const a of atualizar) {
    await api("PUT", `/training/${a.id}`, { type: "TEXT", text: a.texto });
    log(`ATUALIZADO ${a.p.codigo} (${a.id})`);
  }
  for (const e of [...excluir, ...limparDuplicados.map((d) => ({ codigo: "duplicado", id: d.id }))]) {
    await api("DELETE", `/training/${e.id}`);
    log(`EXCLUÍDO ${e.codigo} (${e.id})`);
  }

  // 6. Conferência final.
  const depoisMapa = new Map();
  for (const t of (await listarTextos()).filter((t) => t.texto.startsWith(PREFIXO))) {
    const c = codigoDoTexto(t.texto);
    if (c && !depoisMapa.has(c)) depoisMapa.set(c, t);
  }
  const faltando = alvo.filter((p) => !depoisMapa.has(p.codigo)).map((p) => p.codigo);
  if (faltando.length) {
    throw new Error(`Após execução, SKU(s) sem treinamento: ${faltando.join(", ")}. VERIFICAR NO PAINEL.`);
  }
  if (!reFiltro && depoisMapa.size !== produtos.length) {
    throw new Error(`Esperava ${produtos.length} gerenciados, há ${depoisMapa.size}. VERIFICAR NO PAINEL.`);
  }
  log(`Estado final OK: ${depoisMapa.size} treinamento(s) gerenciado(s).`);
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
