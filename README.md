# FM Shop — monitor de preços/estoque (Fase 1)

Coletor diário da loja **loja.fmdobrasil.com.br** (Loja Integrada). Lê o
sitemap de produtos, extrai preço cartão, preço Pix, parcelamento e
disponibilidade de cada item, compara com a coleta anterior e:

- regenera `saida/produtos_fmd_atualizados.txt` — o documento de
  treinamento da **Julia** (agente FM Shop no GPT Maker), no mesmo formato
  do doc original da Manos;
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

## Sync automático do doc na Julia (`src/update-julia.js`)

Quando a coleta detecta mudança, o workflow sincroniza o doc no
treinamento da Julia pela API oficial (developer.gptmaker.ai):

1. **Trava de identidade** — `GET /v2/agent/{id}` precisa retornar
   `name: Julia`; caso contrário aborta sem alterar nada (a chave de
   API é única da conta, a trava impede tocar outro agente).
2. Cria o treinamento novo (`POST /v2/agent/{id}/trainings`, tipo
   DOCUMENT, `documentUrl` = raw do GitHub pinado no SHA do commit).
3. Espera o novo aparecer na listagem (+60s de folga de treino).
4. Só então exclui os antigos de mesmo `documentName`
   (`DELETE /v2/training/{id}`). Falha em qualquer passo = job
   vermelho e doc antigo preservado (a Julia nunca fica sem doc).

Auditoria permanente: cada sync escreve em `saida/julia-sync-log.md`
(commitado). Teste manual: Actions → Run workflow → `julia_mode`
(`dry-run` ou `full`). O sync nas rodadas agendadas é controlado por
`JULIA_SYNC_AGENDADO` no workflow (ligar só após teste validado).

## Notas técnicas

- Estoque da Loja Integrada é binário (Disponível/Indisponível).
- Produto com variações de preço → "A partir de R$ X" (menor preço).
- Falha de extração é ruidosa por desenho: se o tema/HTML da loja mudar,
  o job falha avisando — nunca gera doc silenciosamente errado.
- Trava de sanidade: preço Pix maior que cartão = erro de extração.
- Dedup de produtos por **SKU**, nunca por slug: a loja tem slugs TROCADOS
  nas amassadeiras (URL da ISP25 diz "isp5" e vice-versa) — dedup por slug
  engolia a ISP5 (44 de 45 produtos). Corrigido em 20/07 (commit 8315a04).
