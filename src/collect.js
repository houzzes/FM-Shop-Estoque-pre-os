#!/usr/bin/env node
/**
 * FM Shop — coletor de preços/estoque da loja (Loja Integrada).
 *
 * Lê o sitemap de produtos, visita cada página e extrai preço cartão,
 * preço Pix, parcelamento e disponibilidade. Compara com a coleta
 * anterior (data/produtos.json), gera o documento de treinamento da
 * Julia (saida/produtos_fmd_atualizados.txt) e um resumo de mudanças
 * (saida/ultima-mudanca.md). Sai com código:
 *   0 = sem mudanças · 10 = houve mudanças · 1 = erro de coleta
 */

const fs = require("fs");
const path = require("path");

const BASE = "https://loja.fmdobrasil.com.br";
const SITEMAP = `${BASE}/sitemap/product-1.xml`;
const RAIZ = path.join(__dirname, "..");
const ARQ_ESTADO = path.join(RAIZ, "data", "produtos.json");
const ARQ_DOC = path.join(RAIZ, "saida", "produtos_fmd_atualizados.txt");
const ARQ_RESUMO = path.join(RAIZ, "saida", "ultima-mudanca.md");

const UA = "HouzzesPriceBot/1.0 (monitor interno de precos; contato houzzes.adm@gmail.com)";

function brl(n) {
  return "R$ " + n.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

async function fetchTexto(url, tentativas = 3) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      if (i === tentativas) throw new Error(`${url}: ${e.message}`);
      await new Promise((res) => setTimeout(res, 2000 * i));
    }
  }
}

/** Sitemap → lista de URLs, sem dedup por slug: a loja tem páginas de
 * produtos DIFERENTES compartilhando o mesmo slug (URLs trocadas — ex.
 * ISP5 × ISP15 em 20/07/2026, que fazia o dedup por slug engolir a ISP5).
 * Duplicata real de produto é resolvida depois, por SKU (dedupePorCodigo). */
function urlsDoSitemap(xml) {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  return [...new Set(locs)].sort();
}

/** Mesmo SKU em mais de uma URL = mesmo produto duplicado no sitemap;
 * fica a URL mais curta (canônica, sem prefixo tipo /9kbn1v060-/). */
function dedupePorCodigo(produtos) {
  const prof = (p) => new URL(p.link).pathname.split("/").filter(Boolean).length;
  const porCodigo = new Map();
  for (const p of produtos) {
    const atual = porCodigo.get(p.codigo);
    if (!atual || prof(p) < prof(atual)) porCodigo.set(p.codigo, p);
  }
  return [...porCodigo.values()];
}

function limpar(s) {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Extrai os campos de uma página de produto. Lança erro se algo essencial faltar. */
function extrair(html, url) {
  const nome = html.match(/<h1[^>]*itemprop="name"[^>]*>([^<]+)<\/h1>/);
  const sku = html.match(/<span itemprop="sku">([^<]+)<\/span>/);
  const marca = html.match(/itemprop="brand"[\s\S]{0,400}?<meta itemprop="name" content="([^"]+)"/);
  const sobConsulta = /var produto_preco_sob_consulta = (true|false)/.exec(html);

  // Categoria = primeiro item do breadcrumb depois de "Início".
  const bloco = html.match(/class="breadcrumbs[\s\S]*?<\/div>/);
  let categoria = "OUTROS";
  if (bloco) {
    const cats = [...bloco[0].matchAll(/<a href="[^"]+">(?:<i[^>]*><\/i>)?([^<]+)<\/a>/g)]
      .map((m) => limpar(m[1]))
      .filter((c) => c && c.toLowerCase() !== "início");
    if (cats.length) categoria = cats[0];
  }

  if (!nome || !sku) throw new Error(`extração falhou em ${url} (nome/sku ausentes)`);
  const codigo = sku[1].trim();

  // Bloco principal de ações: class="acoes-produto ... SKU-<codigo>" com data-variacao-id=""
  // Termina no DelimiterFloat (logo após o bloco) para não vazar para os
  // produtos relacionados, que também têm data-sell-price.
  const re = new RegExp(
    `<div class="acoes-produto[^"]*SKU-${codigo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*data-variacao-id=""[\\s\\S]*?(?=<span id="DelimiterFloat"|<div class="acoes-produto|<div id="descricao|$)`
  );
  const principal = re.exec(html);
  const ehSobConsulta = sobConsulta ? sobConsulta[1] === "true" : false;
  if (!principal && !ehSobConsulta) {
    throw new Error(`extração falhou em ${url} (bloco principal de preço não encontrado)`);
  }
  const trecho = principal ? principal[0] : "";

  const numero = (s) => parseFloat(s.replace(/\./g, "").replace(",", "."));

  // Preço fixo (data-sell-price) OU "A partir de R$ X" quando variações têm preços diferentes.
  const precoFixo = trecho.match(/data-sell-price="([\d.]+)"/);
  const precoAPartir = trecho.match(/preco-a-partir[\s\S]{0,300}?R\$\s*([\d.,]+)/);
  const aPartirDe = !precoFixo && !!precoAPartir;
  const precoCartao = precoFixo ? parseFloat(precoFixo[1]) : precoAPartir ? numero(precoAPartir[1]) : null;

  const pix = trecho.match(/desconto-a-vista">[\s\S]*?<strong[^>]*>\s*R\$\s*([\d.,]+)\s*<\/strong>[\s\S]*?via Pix/);
  const parcela = trecho.match(/até\s*<strong[^>]*>(\d+)x<\/strong>[\s\S]*?de\s*<strong[^>]*>R\$\s*([\d.,]+)<\/strong>/);

  // Estoque: bloco principal; sem ele (produto com variações), qualquer
  // variação disponível conta como Disponível.
  const estoquePrincipal = trecho.match(/Estoque:\s*<b[^>]*>\s*([^<]+?)\s*<\/b>/);
  let estoque;
  if (estoquePrincipal) {
    estoque = limpar(estoquePrincipal[1]);
  } else {
    const variacoes = [...html.matchAll(/<div class="acoes-produto hide[\s\S]*?Estoque:\s*<b[^>]*>\s*([^<]+?)\s*<\/b>/g)];
    if (variacoes.length) {
      estoque = variacoes.some((v) => /Dispon/i.test(v[1])) ? "Disponível" : "Indisponível";
    } else {
      estoque = /avise-me|produto-indisponivel/i.test(trecho) ? "Indisponível" : "Disponível";
    }
  }

  const pixNum = pix ? numero(pix[1]) : null;
  if (precoCartao && pixNum && pixNum > precoCartao) {
    throw new Error(`extração inconsistente em ${url} (Pix ${pixNum} > cartão ${precoCartao})`);
  }

  return {
    nome: limpar(nome[1]),
    codigo,
    marca: marca ? marca[1].trim() : null,
    link: url,
    categoria: categoria.toUpperCase(),
    sobConsulta: ehSobConsulta,
    aPartirDe,
    precoCartao,
    precoPix: pixNum,
    parcelamento: parcela ? `até ${parcela[1]}x de R$ ${parcela[2]}` : null,
    estoque,
  };
}

function carregarEstado() {
  try {
    return JSON.parse(fs.readFileSync(ARQ_ESTADO, "utf8"));
  } catch {
    return null;
  }
}

/** Compara coleta nova com anterior → lista de mudanças legíveis. */
function diff(antes, agora) {
  const mudancas = [];
  if (!antes) return mudancas;
  const mapaAntes = new Map(antes.produtos.map((p) => [p.codigo, p]));
  const mapaAgora = new Map(agora.produtos.map((p) => [p.codigo, p]));

  for (const [codigo, novo] of mapaAgora) {
    const velho = mapaAntes.get(codigo);
    if (!velho) {
      mudancas.push(`🆕 Produto NOVO: ${novo.nome} — ${novo.precoCartao ? brl(novo.precoCartao) : "sob consulta"}`);
      continue;
    }
    if (velho.precoCartao !== novo.precoCartao && novo.precoCartao && velho.precoCartao) {
      const d = novo.precoCartao - velho.precoCartao;
      const pct = ((d / velho.precoCartao) * 100).toFixed(1);
      mudancas.push(
        `${d > 0 ? "⬆️" : "⬇️"} ${novo.nome}: ${brl(velho.precoCartao)} → ${brl(novo.precoCartao)} (${d > 0 ? "+" : ""}${pct}%)`
      );
    }
    if (velho.precoPix !== novo.precoPix && novo.precoPix && velho.precoPix && velho.precoCartao === novo.precoCartao) {
      mudancas.push(`💠 ${novo.nome}: Pix ${brl(velho.precoPix)} → ${brl(novo.precoPix)}`);
    }
    if (velho.estoque !== novo.estoque) {
      mudancas.push(`📦 ${novo.nome}: estoque ${velho.estoque} → ${novo.estoque}`);
    }
  }
  for (const [codigo, velho] of mapaAntes) {
    if (!mapaAgora.has(codigo)) mudancas.push(`❌ Produto REMOVIDO do site: ${velho.nome}`);
  }
  return mudancas;
}

/** Gera o .txt no formato do documento da Manos. */
function gerarDoc(agora, antes) {
  const dataBR = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const mapaAntes = antes ? new Map(antes.produtos.map((p) => [p.codigo, p])) : new Map();

  const linhas = [
    "PRODUTOS DO E-COMMERCE FM DO BRASIL - PREÇOS ATUALIZADOS",
    "==========================================================",
    `Site: ${BASE}/`,
    `Data de atualização: ${dataBR}`,
    "",
    "⚠️ IMPORTANTE: Esta listagem contém os PREÇOS ATUALIZADOS coletados diretamente do site.",
    "Gerada automaticamente pelo monitor de preços da Houzzes.",
    "",
    "=====================================",
  ];

  const categorias = [...new Set(agora.produtos.map((p) => p.categoria))].sort();
  let n = 0;
  for (const cat of categorias) {
    linhas.push("", `CATEGORIA: ${cat}`, "=".repeat(`CATEGORIA: ${cat}`.length));
    for (const p of agora.produtos.filter((x) => x.categoria === cat)) {
      n++;
      linhas.push("", `${n}. PRODUTO: ${p.nome}`);
      linhas.push(`   CÓDIGO: ${p.codigo}`);
      if (p.marca) linhas.push(`   MARCA: ${p.marca}`);
      linhas.push(`   LINK: ${p.link}`);
      if (p.sobConsulta || !p.precoCartao) {
        linhas.push("   PREÇO: SOB CONSULTA (falar com o comercial)");
      } else {
        const prefixo = p.aPartirDe ? "A partir de " : "";
        linhas.push(`   PREÇO ATUAL: ${prefixo}${brl(p.precoCartao)}${p.precoPix ? ` (ou ${prefixo.toLowerCase()}${brl(p.precoPix)} via Pix)` : ""}`);
        const velho = mapaAntes.get(p.codigo);
        if (velho && velho.precoCartao && velho.precoCartao !== p.precoCartao) {
          const d = p.precoCartao - velho.precoCartao;
          const pct = ((d / velho.precoCartao) * 100).toFixed(1);
          linhas.push(`   PREÇO ANTERIOR: ${brl(velho.precoCartao)}${velho.precoPix ? ` (ou ${brl(velho.precoPix)} via Pix)` : ""}`);
          linhas.push(`   VARIAÇÃO: ${d > 0 ? "+" : "-"}${brl(Math.abs(d)).slice(3)} (${d > 0 ? "+" : ""}${pct}%) ${d > 0 ? "⬆️" : "⬇️"}`);
        }
        if (p.parcelamento) linhas.push(`   PARCELAMENTO: ${p.parcelamento}`);
      }
      linhas.push(`   ESTOQUE: ${p.estoque}`);
    }
  }
  linhas.push("");
  return linhas.join("\n");
}

async function main() {
  console.log("Lendo sitemap…");
  const urls = urlsDoSitemap(await fetchTexto(SITEMAP));
  console.log(`${urls.length} produtos no sitemap.`);

  const produtos = [];
  const erros = [];
  for (const url of urls) {
    try {
      const html = await fetchTexto(url);
      produtos.push(extrair(html, url));
      process.stdout.write(".");
    } catch (e) {
      erros.push(e.message);
      process.stdout.write("x");
    }
    await new Promise((r) => setTimeout(r, 400)); // educado com o servidor
  }
  console.log("");

  if (erros.length) {
    console.error(`\n⚠️ ${erros.length} produto(s) com falha de extração:`);
    erros.forEach((e) => console.error("  - " + e));
  }
  // Falha total ou majoritária = não sobrescrever estado (site pode ter mudado de tema).
  if (produtos.length === 0 || erros.length > produtos.length) {
    console.error("Coleta abortada: falhas demais. Estado anterior preservado.");
    process.exit(1);
  }

  const unicos = dedupePorCodigo(produtos);
  const antes = carregarEstado();
  const agora = {
    coletadoEm: new Date().toISOString(),
    total: unicos.length,
    produtos: unicos.sort((a, b) => a.categoria.localeCompare(b.categoria) || a.nome.localeCompare(b.nome)),
  };

  const mudancas = diff(antes, agora);

  fs.mkdirSync(path.dirname(ARQ_ESTADO), { recursive: true });
  fs.mkdirSync(path.dirname(ARQ_DOC), { recursive: true });
  fs.writeFileSync(ARQ_ESTADO, JSON.stringify(agora, null, 2));
  fs.writeFileSync(ARQ_DOC, gerarDoc(agora, antes));

  const dataBR = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  if (mudancas.length) {
    const resumo = [
      `# Mudanças detectadas — ${dataBR}`,
      "",
      ...mudancas.map((m) => `- ${m}`),
      "",
      erros.length ? `⚠️ ${erros.length} produto(s) com falha de extração nesta coleta.` : "",
    ].join("\n");
    fs.writeFileSync(ARQ_RESUMO, resumo);
    console.log(`\n${mudancas.length} mudança(s):`);
    mudancas.forEach((m) => console.log("  " + m));
    process.exit(10);
  } else {
    console.log("\nSem mudanças desde a última coleta.");
    if (!antes) {
      fs.writeFileSync(ARQ_RESUMO, `# Primeira coleta — ${dataBR}\n\n${agora.total} produtos registrados.`);
      process.exit(10);
    }
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("Erro fatal:", e);
  process.exit(1);
});
