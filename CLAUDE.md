# San Checkout — SAN & CO. Pay Engine

Estrutura da San & Co. Motor de pagamento whitelabel, modelo pull, Asaas
por baixo. Segue as leis do plugin `san-co`.

## Antes de propor ou escrever qualquer coisa, leia
- `CONSTRAINTS.md` — o que NÃO se faz aqui, os limites e as exceções
- `docs/funcional.md` — o que o sistema faz, tela por tela. Comportamento alterado se reescreve ali, na mesma tarefa
- `docs/specs/2026-09-11-san-checkout.md` — por que existe, e os contrapontos
- `docs/erros/` — o que já deu errado aqui; não repita
- `docs/pendencias.md` — o trabalho que falta, e o que só o dono faz
- `RUNBOOK.md` — como operar, reverter, restaurar e responder a incidente
- `API.md` — o contrato que os contratantes consomem
- `README.md` — como rodar e testar

## Classificação
Porte: multi-inquilino · Dado: de terceiro, com dinheiro · Vida útil: longa
→ **topo da escala de rigor** (Lei 0: nada aqui se dispensa por proporcionalidade)

## Estado na esteira
Estação atual: **6 — Prontidão** (destravada em 13/09/2026, quando a CI
de segurança ficou verde pela primeira vez). Pede Opus com esforço alto.

| # | estado | evidência, e onde se confere |
|---|---|---|
| 1 Escopo | **fechada** 13/09 | métrica de sucesso escrita no spec, seção "Métrica de sucesso": cobrança confirmada, contada por contratante |
| 2 Fronteiras | **fechada**, reaberta e refechada 12/09 | seção "Classificação de fronteira" do spec: Access registrado ali, e hospedagem escolhida por número medido (23 ms × 220 ms) |
| 3 Fundação | **fechada** 13/09 | `Segurança` **run #5 verde** em `5f3adf3` (os três jobs), depois de #1 a #4 vermelhas; SHAs reconferidos por `git ls-remote`; `RUNBOOK.md` existe |
| 4 Contratos | **fechada** 13/09 | `API.md` e migrations OK; `docs/funcional.md` com as dez seções — as 8 e 9 escritas hoje |
| 5 Construção | no ar, com ressalva | `5f3adf3` no ar, `testes #22` verde; pagamento ainda em **sandbox**, e a troca só acontece **depois** de a Estação 6 fechar (decisão do dono, 13/09) |
| 6 Prontidão | **em curso** | contratante de teste `testemaster` cadastrado em 13/09; ciclo 1 rodou contra o Render, não contra o que está no ar; falta refazer no Northflank |

Falta para fechar a 6: o teste de ponta a ponta de seis passos e o ciclo
de segurança refeito sobre o Northflank. A troca da Asaas para o
ambiente real vem **depois** dela, e é o que fecha a 5 sem ressalva.

## Mapa de caminhos
- Entrada: `src/server.js` · rotas `src/routes/` · controladores `src/controllers/` · regras e integrações `src/services/`
- Dados: `supabase/migrations/` · variáveis `.env.example`
- Telas: `public/` · tokens visuais `public/css/theme-engine.css` · componentes `public/css/components/`
- Integração Asaas: `src/config/asaas.js` (único que sabe URL e ambiente) e `src/services/asaasService.js`
- Testes: `tests/` — `npm test` roda as 12 suítes; `npm run check` roda a análise de sintaxe de todo JS (inclusive `public/js/`, que os testes não alcançam) e depois as suítes
- Imagem de produção: `Dockerfile` · CI: `.github/workflows/`

## Conformidade
Violação segue o ciclo da skill `leis`. Não existe estado final fora de
conformidade: ou corrige, ou vira exceção registrada no `CONSTRAINTS.md`.

## Pendências que bloqueiam a esteira
- **Estação 6 · o teste de ponta a ponta de seis passos nunca foi feito.** É o próximo item da fila. O contratante de teste já existe (`testemaster`, API no Cloudflare Workers); falta percorrer os seis passos. O estorno do passo 6 parte do lojista de teste, que é como estorno acontece aqui.
- **Estação 5 · o deploy aponta para o sandbox da Asaas.** Decidido em 13/09: a troca vem **depois** de a Estação 6 fechar — a prontidão roda inteira no sandbox, e o ambiente real entra com o sistema já verificado. Custo assumido: o que muda entre ambientes (identificador, formato de webhook, assinatura, erro) não terá passado pelo ciclo.
- **Estação 6 · o ciclo de segurança precisa rodar sobre o Northflank**, que é onde a produção está.

As demais, que não bloqueiam, estão em `docs/pendencias.md`.
