# San Checkout — SAN & CO. Pay Engine

Estrutura da San & Co. Motor de pagamento whitelabel, modelo pull, Asaas
por baixo. Segue as leis do plugin `san-co`.

**Classificação:** multi-inquilino · dado de terceiro · dinheiro · vida
longa → topo da escala de rigor.

## Leia antes de propor ou escrever qualquer coisa

- `CONSTRAINTS.md` — o que NÃO se faz aqui, e os limites assumidos
- `docs/funcional.md` — o que o sistema faz, tela por tela. Comportamento alterado se reescreve ali, na mesma tarefa
- `docs/specs/2026-09-11-san-checkout.md` — por que existe, e os contrapontos
- `docs/erros/` — o que já deu errado aqui; não repita
- `docs/pendencias.md` — a lista de trabalho completa
- `API.md` — o contrato que os contratantes consomem
- `README.md` — como rodar e testar

## Estado na esteira

Estação atual: **6 — Prontidão**, aberta em 11/09/2026.

| # | fechada | evidência |
|---|---|---|
| 1 Escopo | 11/09 | `docs/specs/2026-09-11-san-checkout.md` |
| 2 Fronteiras | 11/09 | seção "Classificação de fronteira" do spec |
| 3 Fundação | 12/09 | `.github/workflows/`, este arquivo |
| 4 Contratos | 12/09 | `API.md`, `supabase/migrations/`, `docs/funcional.md` |
| 5 Construção | 12/09 | v1 no ar, `npm test` verde, Access antes do deploy |

Falta para fechar a 6: ciclo de segurança limpo sobre o que está no ar, e
erro em produção visível (Lei 8). Depois vem a **7 — Lançamento**, que
pede Sonnet para os documentos legais e Fable para a varredura final.

## Mapa de caminhos

- Entrada: `src/server.js` · rotas `src/routes/` · controladores `src/controllers/` · regras e integrações `src/services/`
- Dados: `supabase/migrations/` · variáveis `.env.example`
- Telas e tokens visuais: `public/`, `public/css/`
- Testes: `tests/` — `npm test` roda todas
- Imagem de produção: `Dockerfile`, `.dockerignore`

## Conformidade é obrigatória

Violação encontrada segue o ciclo das leis: corrigir o aditivo na hora,
propor o estrutural, registrar no documento certo, reverificar. Não
existe estado final fora de conformidade — ou corrige, ou vira exceção
registrada no `CONSTRAINTS.md`.

## Pendências que bloqueiam a esteira

- **Estação 6 · o Cloudflare Access caiu da frente do `/admin`** (confirmado de fora em 12/09). Só o dono recria, no Zero Trust.
- **Estação 6 · o ciclo de segurança precisa rodar sobre o Northflank**, que é onde a produção vai ficar. O ciclo 1 rodou contra o Render.
- **Estação 6 · o teste de ponta a ponta de seis passos** (`API.md`), no sandbox, antes do ciclo de segurança. Depende de contratante de teste cadastrado pelo dono.

As demais, que não bloqueiam, estão em `docs/pendencias.md`.
