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
Estação atual: **entre estações**. A 5 está no ar com ressalva e a 6
**não foi autorizada a começar** — a entrada é decisão do dono, e o
gatilho combinado é a chave do `testemaster` rotacionada nos dois lados.
Quando abrir, a 6 pede Opus com esforço alto.

> Em 13/09 eu emendei direto no passo 1 da Estação 6 sem pedir. O
> trabalho achou dois furos reais e mesmo assim estava fora de ordem —
> `docs/erros/2026-09-13-avancei-para-a-estacao-6-sem-autorizacao.md`.
> Abrir estação é decisão, não consequência de o caminho estar livre.

| # | estado | evidência, e onde se confere |
|---|---|---|
| 1 Escopo | **fechada** 13/09 | métrica de sucesso escrita no spec, seção "Métrica de sucesso": cobrança confirmada, contada por contratante |
| 2 Fronteiras | **fechada**, reaberta e refechada 12/09 | seção "Classificação de fronteira" do spec: Access registrado ali, e hospedagem escolhida por número medido (23 ms × 220 ms) |
| 3 Fundação | **fechada** 13/09 | `Segurança` **run #5 verde** em `5f3adf3` (os três jobs), depois de #1 a #4 vermelhas; SHAs reconferidos por `git ls-remote`; `RUNBOOK.md` existe |
| 4 Contratos | **fechada** 13/09 | `API.md` e migrations OK; `docs/funcional.md` com as dez seções — as 8 e 9 escritas hoje |
| 5 Construção | no ar, com ressalva | `b753716` no ar e **conferido em produção** em 13/09 (`taxa: null` no pedido sem valor; caminho inventado devolve 404); pagamento ainda em **sandbox**, e a troca só acontece **depois** de a Estação 6 fechar (decisão do dono, 13/09) |
| 6 Prontidão | **não iniciada** — falta autorização | contratante de teste `testemaster` cadastrado em 13/09; o passo 1 dos seis foi rodado fora de ordem e achou dois furos de total, corrigidos e no ar; ciclo 1 rodou contra o Render, não contra o que está no ar |

**Para a 6 poder abrir:** a chave do `testemaster` rotacionada no painel
e colada na secret `CHECKOUT_KEY` do Worker — é o que fecha a pendência
que ficou aberta na estação anterior. Depois disso, autorização do dono.

Falta para fechar a 6, quando ela abrir: o teste de ponta a ponta de
seis passos e o ciclo de segurança refeito sobre o Northflank. A troca
da Asaas para o ambiente real vem **depois** dela, e é o que fecha a 5
sem ressalva.

## Mapa de caminhos
- Entrada: `src/server.js` · rotas `src/routes/` · controladores `src/controllers/` · regras e integrações `src/services/`
- Dados: `supabase/migrations/` · variáveis `.env.example`
- Telas: `public/` · tokens visuais `public/css/theme-engine.css` · componentes `public/css/components/`
- Integração Asaas: `src/config/asaas.js` (único que sabe URL e ambiente) e `src/services/asaasService.js`
- Testes: `tests/` — `npm test` roda as 13 suítes; `npm run check` roda a análise de sintaxe de todo JS (inclusive `public/js/`, que os testes não alcançam) e depois as suítes
- Imagem de produção: `Dockerfile` · CI: `.github/workflows/`

## Conformidade
Violação segue o ciclo da skill `leis`. Não existe estado final fora de
conformidade: ou corrige, ou vira exceção registrada no `CONSTRAINTS.md`.

## Pendências que bloqueiam a esteira
- **A chave do `testemaster` precisa ser rotacionada.** Ela saiu do cofre em 13/09 e é o que segura a abertura da Estação 6. O caminho existe desde o mesmo dia: painel → Contratantes → "Trocar chave", copiar, colar na secret `CHECKOUT_KEY` do Worker. **Só o dono faz** (painel do checkout e painel da Cloudflare).
- **Estação 6 · o teste de ponta a ponta de seis passos nunca foi feito.** Só começa depois da rotação e com autorização. O contratante de teste já existe (`testemaster`, API no Cloudflare Workers). O estorno do passo 6 parte do lojista de teste, que é como estorno acontece aqui.
- **Estação 5 · o deploy aponta para o sandbox da Asaas.** Decidido em 13/09: a troca vem **depois** de a Estação 6 fechar — a prontidão roda inteira no sandbox, e o ambiente real entra com o sistema já verificado. Custo assumido: o que muda entre ambientes (identificador, formato de webhook, assinatura, erro) não terá passado pelo ciclo.
- **Estação 6 · o ciclo de segurança precisa rodar sobre o Northflank**, que é onde a produção está.

As demais, que não bloqueiam, estão em `docs/pendencias.md`.
