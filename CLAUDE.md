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
Estação atual: **3 — Fundação, REABERTA em 13/09/2026** (a CI de segurança
nunca passou). A 6 estava em curso e volta a esperar.

| # | estado | evidência, e onde se confere |
|---|---|---|
| 1 Escopo | **reaberta** 13/09 | spec existe, mas sem a métrica de sucesso que a lei nova exige |
| 2 Fronteiras | **fechada**, reaberta e refechada 12/09 | seção "Classificação de fronteira" do spec: Access registrado ali, e hospedagem escolhida por número medido (23 ms × 220 ms) |
| 3 Fundação | **REABERTA** 13/09 | `Segurança` runs #1 a #4 **falharam** (semgrep, 6 achados); `RUNBOOK.md` criado hoje |
| 4 Contratos | **reaberta** 13/09 | `API.md` e migrations OK; `docs/funcional.md` sem as seções 8 e 9 do modelo novo |
| 5 Construção | no ar, com ressalva | commit `d696aa4` no ar, `testes #21` verde; pagamento ainda em **sandbox** |
| 6 Prontidão | esperando a 3 | ciclo 1 rodou contra o Render, não contra o que está no ar |

Falta para fechar a 3: os dois workflows com SHA fixo (só o dono aplica),
e uma execução verde.
Próxima estação depois dela: **6 — Prontidão**, pede Opus com esforço alto.

## Mapa de caminhos
- Entrada: `src/server.js` · rotas `src/routes/` · controladores `src/controllers/` · regras e integrações `src/services/`
- Dados: `supabase/migrations/` · variáveis `.env.example`
- Telas: `public/` · tokens visuais `public/css/theme-engine.css` · componentes `public/css/components/`
- Integração Asaas: `src/config/asaas.js` (único que sabe URL e ambiente) e `src/services/asaasService.js`
- Testes: `tests/` — `npm test` roda as 11 suítes
- Imagem de produção: `Dockerfile` · CI: `.github/workflows/`

## Conformidade
Violação segue o ciclo da skill `leis`. Não existe estado final fora de
conformidade: ou corrige, ou vira exceção registrada no `CONSTRAINTS.md`.

## Pendências que bloqueiam a esteira
- **Estação 3 · a CI `Segurança` está vermelha desde o primeiro push.** Semgrep, 6 achados, todos `actions/*@v4` sem SHA fixo. Conteúdo pronto entregue; só o dono aplica em `.github/workflows/`.
- **Estação 1 · o spec não tem métrica de sucesso**, e a Estação 4 depende dela para nomear os eventos.
- **Estação 4 · `docs/funcional.md` não tem as seções "Direitos e obrigações que viram tela" nem "Métrica de sucesso e eventos".**
- **Estação 5 · o deploy aponta para o sandbox da Asaas**, e a lei nova pede ambiente real dos provedores. Decisão do dono.
- **Estação 6 · o ciclo de segurança precisa rodar sobre o Northflank**, que é onde a produção está.

As demais, que não bloqueiam, estão em `docs/pendencias.md`.
