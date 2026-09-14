# San Checkout — SAN & CO. Pay Engine

Estrutura da San & Co. Motor de pagamento whitelabel, modelo pull, Asaas
por baixo. Segue as leis do plugin `san-co`.

> **O plugin é fonte, e a citação dele neste repositório não é.**
> `.claude/settings.json` declara o marketplace, mas plugin só carrega na
> abertura da sessão: `ListPlugins` vazio significa trabalhar de segunda
> mão, e isso já custou uma estação fechada errado em 13/09
> (`docs/erros/2026-09-13-fechei-uma-estacao-contra-a-parafrase-da-lei.md`).
> Sem o plugin carregado, clonar `sancompany/Plugin_san-co` e ler de lá
> antes de fechar qualquer coisa.

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
Estação atual: **6 Prontidão, aberta em 14/09/2026** — autorizada pelo
dono, com as três condições de `varredura-final.md` conferidas no dia
(commit servido = main, migrations aplicadas, árvore limpa). Pede Opus
com esforço alto, e é da sessão por inteiro.

> Em 13/09 eu emendei direto no passo 1 da Estação 6 sem pedir. O
> trabalho achou dois furos reais e mesmo assim estava fora de ordem —
> `docs/erros/2026-09-13-avancei-para-a-estacao-6-sem-autorizacao.md`.
> Abrir estação é decisão, não consequência de o caminho estar livre.

| # | estado | evidência, e onde se confere |
|---|---|---|
| 1 Escopo | **fechada** 13/09 | métrica de sucesso escrita no spec, seção "Métrica de sucesso": cobrança confirmada, contada por contratante |
| 2 Fronteiras | **fechada**, reaberta e refechada 12/09 | seção "Classificação de fronteira" do spec: Access registrado ali, e hospedagem escolhida por número medido (23 ms × 220 ms) |
| 3 Fundação | **fechada** 13/09 | `Segurança` **run #5 verde** em `5f3adf3` (os três jobs), depois de #1 a #4 vermelhas; SHAs reconferidos por `git ls-remote`; `RUNBOOK.md` existe |
| 4 Contratos | **fechada** 13/09, refeita no fim do dia | `API.md` e migrations OK; `docs/funcional.md` reescrito contra `definicao-funcional.md` **lido na fonte** — seis das dez seções divergiam da paráfrase que eu vinha usando (`docs/erros/2026-09-13-fechei-uma-estacao-contra-a-parafrase-da-lei.md`). As quatro perguntas de prontidão respondem "sim" no fim do arquivo |
| 5 Construção | no ar, com **exceção registrada** | `b753716` no ar e **conferido em produção** em 13/09 (`taxa: null` no pedido sem valor; caminho inventado devolve 404). Pagamento em **sandbox** por decisão do dono, registrada em `CONSTRAINTS.md` §3 ("Estação 5 · deploy em produção apontando para o sandbox") com o plano de duas rodadas e o custo escrito |
| 6 Prontidão | **aberta** 14/09 | autorizada pelo dono, com escopo ampliado (`CONSTRAINTS.md` §4). As três condições de `varredura-final.md` conferidas: main = `acbce0b` servido no Northflank (deploy `6431907099` state success), migrations 0001-0003 aplicadas, árvore limpa |

**Escopo da 6, tudo no sandbox** (`CONSTRAINTS.md` §4). Feito em 14/09:
- **Segurança de fora:** limpo (Supabase RLS default-deny, admin
  fail-closed, IDOR 401/403 ao vivo, erro genérico, webhook fail-closed).
  Dois furos corrigidos e no ar: `alvoDeRede` (https+host público em
  apiBaseUrl/webhookUrl) e `search_path` (migration 0004). A hipótese da
  origem-bypass caiu — a API é DNS-only, pública por desenho
  (`docs/erros/2026-09-14-origem-direta-alcancavel-por-fora.md`).
- **Ponta a ponta Pix:** completo (pago→webhook→status→conciliação→estorno,
  negativos 401/403). Assinatura: criação + ciclo auth/404; **falta a
  metade paga** (cartão no pop-up).
- **Prontidão:** scrypt medido (~1–1,3 s, manter N=2^17); métrica
  respondível; e-mail confirmado; alerta de queda com metade de código
  feita (`/api/saude` 503 na queda).

Falta para fechar a 6 (gated no dono / MostrAí / troca para produção):
ciclo de assinatura pago; ligar o monitor externo no `/api/saude`;
backup+restauração (amarrado ao 1º pagamento real, §3); e os demais itens
de prontidão adiados (`docs/pendencias.md`). A troca da Asaas para
produção vem depois e fecha a 5 sem ressalva. O MostrAí retesta o lado
dele em paralelo.

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
- **Estação 6 · não iniciada, esperando autorização.** Ela é da sessão por inteiro (decisão do dono, 13/09): teste de ponta a ponta com todos os meios de pagamento no sandbox, ciclo de segurança sobre o Northflank, e os sete itens de prontidão operacional de `leis/references/prontidao-operacional.md` — cada um com evidência medida, não "configurei". Depois dela, troca das variáveis para produção e segunda rodada sem os testes de pagamento (`CONSTRAINTS.md` §3).
- **Antes de abrir a 6**, a lei pede três condições conferidas (`leis/references/varredura-final.md`): commit servido igual ao da branch principal, migrations aplicadas em produção, nada relevante só no disco.

As demais, que não bloqueiam, estão em `docs/pendencias.md`.
