# FM Shop — monitor de preços/estoque (Fase 1)

Coletor diário da loja **loja.fmdobrasil.com.br** (Loja Integrada). Lê o
sitemap de produtos, extrai preço cartão, preço Pix, parcelamento e
disponibilidade de cada item, compara com a coleta anterior e:

- regenera `saida/produtos_fmd_atualizados.txt` — o documento de
  treinamento da **Julia** (agente FM Shop no GPT Maker), no mesmo formato
  do doc original da Manos;
- grava `saida/ultima-mudanca.md` com o resumo do diff;
- avisa o Guilherme no WhatsApp via **Houzbot** quando algo muda.

Contexto completo do projeto:
`D:\Houzzes\Clientes\FM Shop\automacao-estoque-precos-plano.md`.

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
| `HOUZBOT_API_URL` | endpoint de envio da API do Chat Houzzes |
| `HOUZBOT_TOKEN` | token da API |
| `HOUZBOT_DESTINO` | WhatsApp de destino (55DDDNÚMERO) |

Sem os secrets o job roda normalmente e só loga o resumo (não falha).
(20/07/2026: secrets ainda não configurados — decisão: o aviso sai pelo
Houzbot na plataforma nova do Atende Chat, aguardando a conta no ar.)

## Fase 2 (manual por decisão)

Quando chegar aviso de mudança: baixar `saida/produtos_fmd_atualizados.txt`,
remover o documento antigo no treinamento da Julia (painel GPT Maker) e
subir o novo. Automatizar só depois de confiar no dado.

## Notas técnicas

- Estoque da Loja Integrada é binário (Disponível/Indisponível).
- Produto com variações de preço → "A partir de R$ X" (menor preço).
- Falha de extração é ruidosa por desenho: se o tema/HTML da loja mudar,
  o job falha avisando — nunca gera doc silenciosamente errado.
- Trava de sanidade: preço Pix maior que cartão = erro de extração.
- Dedup de produtos por **SKU**, nunca por slug: a loja tem slugs TROCADOS
  nas amassadeiras (URL da ISP25 diz "isp5" e vice-versa) — dedup por slug
  engolia a ISP5 (44 de 45 produtos). Corrigido em 20/07 (commit 8315a04).
