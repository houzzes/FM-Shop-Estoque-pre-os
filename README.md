# FM Shop — monitor de preços/estoque

Coletor diário da loja **loja.fmdobrasil.com.br** (Loja Integrada). Lê o
sitemap de produtos, extrai preço cartão, preço Pix, parcelamento e
disponibilidade de cada item, compara com a coleta anterior e:

- sincroniza **1 treinamento de TEXTO por produto** na **Julia** (agente
  FM Shop no GPT Maker) via `src/sync-precos-texto.js` — a ÚNICA fonte
  de preço da Julia desde 28/07/2026;
- regenera `saida/produtos_fmd_atualizados.txt` (hoje só backup/diff
  versionado — não sobe mais para a Julia);
- grava `saida/ultima-mudanca.md` com o resumo do diff;
- avisa o Guilherme no WhatsApp via **Houzbot** quando algo muda.

(Contexto completo do projeto na documentação interna da Houzzes —
ficha do cliente FM Shop.)

## Rodar local

```
node src/collect.js   # coleta + diff + doc (exit 10 = houve mudança)
node src/notify.js    # envia o resumo via Houzbot (precisa de env vars)
```

## GitHub Actions

`.github/workflows/coleta-diaria.yml` roda todo dia às 07:30 (BRT).
Se houver mudança: commita `data/` + `saida/` e dispara o Houzbot.

Secrets necessários (Settings → Secrets and variables → Actions):

| Secret | Conteúdo |
|---|---|
| `GPTMAKER_API_KEY` | chave da API oficial do GPT Maker (sync da Julia) |
| `HOUZBOT_API_URL` | endpoint de envio da API do Chat Houzzes |
| `HOUZBOT_TOKEN` | token da API |
| `HOUZBOT_DESTINO` | WhatsApp de destino (55DDDNÚMERO) |

Sem os secrets do Houzbot o job roda normalmente e só loga o resumo
(não falha). (Aviso sairá pelo Houzbot na plataforma nova do Atende
Chat, aguardando a conta no ar.)

## Sync de preços por TEXTO na Julia (`src/sync-precos-texto.js`)

Desde 28/07/2026, cada produto vive num **treinamento de TEXTO próprio**
na Julia (prefixo `PREÇO E ESTOQUE — `), porque a busca vetorial não
achava o bloco certo no doc único de 49 produtos e o modelo inventava
preço (caso real: preço de uma pá informado como preço do forno Macte
Smart; "R$ 8.990" inventado para o Etna Rotante, real R$ 8.212).

Ciclo diário (quando a coleta detecta mudança):

1. **Trava de identidade** — `GET /v2/agent/{id}` precisa retornar
   `name: Julia`; caso contrário aborta sem alterar nada (a chave de
   API é única da conta, a trava impede tocar outro agente).
2. Lista os treinamentos TEXT e separa **gerenciados** (com o prefixo)
   dos **intocáveis** (afirmações escritas à mão — o script jamais as
   altera ou exclui).
3. Casa produto ↔ treinamento por **SKU** (`CÓDIGO:` no texto) e faz
   create (`POST`), update no lugar (`PUT /v2/training/{id}` — só TEXT
   aceita update) ou delete de SKU que sumiu da loja.
4. A comparação de mudança ignora a linha `Atualizado em` (senão a data
   do dia reescreveria os 49 textos diariamente) — a data gravada é a da
   última mudança REAL do produto.
5. `FILTRO` (regex) restringe o escopo; com filtro ativo o script nunca
   exclui nada. `MODE`: `preview` (gera textos sem API), `dry-run`
   (plano sem escrever), `full`.

Auditoria: `saida/julia-sync-precos-log.md` (commitado). Execução
manual: Actions → Run workflow → `texto_mode`/`texto_filtro`. Agendado:
`TEXTO_SYNC_AGENDADO` — **LIGADO desde 28/07/2026** (Fases A-C
validadas no mesmo dia; ver o log).

### Sync antigo do documento (`src/update-julia.js`) — DESATIVADO

Subia o `.txt` inteiro como treinamento DOCUMENT (validado 21/07/2026,
runs #6/#7). Em 28/07/2026 o documento foi removido da Julia e
`JULIA_SYNC_AGENDADO` ficou `false` — o prompt e as afirmações da Julia
apontam para os treinamentos PREÇO E ESTOQUE, não mais para o documento.
O script fica no repo como referência; religar só com decisão explícita
(e nesse caso reapontar prompt/afirmações de volta).

## Notas técnicas

- Estoque da Loja Integrada é binário (Disponível/Indisponível).
- Produto com variações de preço → "A partir de R$ X" (menor preço).
- Falha de extração é ruidosa por desenho: se o tema/HTML da loja mudar,
  o job falha avisando — nunca gera doc silenciosamente errado.
- Trava de sanidade: preço Pix maior que cartão = erro de extração.
- Dedup de produtos por **SKU**, nunca por slug: a loja tem slugs TROCADOS
  nas amassadeiras (URL da ISP25 diz "isp5" e vice-versa) — dedup por slug
  engolia a ISP5 (44 de 45 produtos). Corrigido em 20/07 (commit 8315a04).
