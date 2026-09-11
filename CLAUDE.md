# San Checkout — SAN & CO. Pay Engine

Projeto da San & Co. Segue as leis de construção do plugin `san-co`.

Motor de pagamento whitelabel, modelo *pull*: o checkout não guarda
catálogo — pergunta os dados de cada pedido à API do próprio contratante
e cobra o valor que recebeu nessa resposta.

## Antes de propor ou escrever qualquer coisa, leia

- `CONSTRAINTS.md` — o que este projeto deliberadamente NÃO faz, e os limites assumidos
- `docs/specs/2026-09-11-san-checkout.md` — por que existe, para quem, e o veredito dos contrapontos
- `docs/erros/` — o que já deu errado aqui; não repita
- `README.md` — como rodar e como executar os testes
- `API.md` — o contrato com quem integra (fica na raiz de propósito: é o documento mais lido do repositório)
- `docs/inventario-de-dados.md` — que dado de pessoa este projeto coleta

## Classificação

Porte: plataforma multi-inquilino (contratantes, painel administrativo,
5 métodos de pagamento, recorrência, webhooks de saída) ·
Dado: **alto** — nome, e-mail, CPF/CNPJ, telefone e endereço completo de
compradores terceiros, mais histórico financeiro; cartão nunca toca o
servidor (delegado à Asaas) ·
Vida útil: **longa e declarada** — infraestrutura compartilhada do
ecossistema, com exigência explícita de não precisar de atualização
constante
→ rigor **topo da escala**. Nenhuma lei é dispensável por
proporcionalidade.

## Onde a esteira está

Estação 1 (Escopo) fechada. **Estação 2 (Fronteiras) é a próxima** — a
skill `classificar` ainda não rodou neste projeto.

## Conformidade é obrigatória

Violação encontrada segue o ciclo das leis: corrigir o aditivo na hora,
propor o estrutural, registrar a decisão no documento certo, reverificar.
Não existe estado final fora de conformidade — ou corrige, ou vira
exceção registrada no `CONSTRAINTS.md`.

## Pendências de conformidade abertas

Esta é a lista única. O que não está aqui, está fechado.

### Bloqueiam a esteira — dependem de ação do dono

- **🔴 `CHECKOUT_ADMIN_PASS_HASH` não configurada em produção.** A senha
  do admin passou a ser conferida por hash scrypt
  (`src/utils/senhaAdmin.js`). Enquanto a variável nova não existir no
  Render, **o painel responde 503**. Gerar com
  `node scripts/gerar-hash-admin.js` e remover a `CHECKOUT_ADMIN_PASS`
  antiga.
- **4 movimentações estruturais aprovadas, ainda não executadas.**
  Apagar `src/services/driveService.js`, `src/services/emailService.js`,
  `src/config/googleDrive.js`; mover `mock/` para `tests/`; mover
  `lacunas-san-checkout-10-09-2026.md`, `plano-execucao.md`,
  `relatorio-seguranca-09-09-2026.md` e `TESTES.md` para `docs/`; parar
  de rastrear `Claude outputs/`. O `.gitignore` já cobre o último.

### Abertas, não bloqueiam

- **Lei 0 · a skill `revisar` nunca rodou** sobre o que está em produção.
- **Lei 0 · cobertura de teste é rasa.** As 4 suítes cobrem assinatura de
  webhook, conversão de taxa, id imprevisível e hash de senha. Não há
  teste de rota, de webhook de entrada, nem de fluxo de pagamento.
- **Estação 6 · a senha do admin trafega em todo request** (`X-Admin-Pass`)
  e fica no `sessionStorage` do navegador. O hash protege o repouso, não
  o trânsito. Um XSS no painel entrega a senha. Correção é token de
  sessão de curta duração — arquitetura de acesso, avaliada pela skill
  `seguranca-san`.
- **Lei 6 · `supabase/schema.sql` é arquivo único editado a cada versão**,
  em vez de migrations numeradas e imutáveis. Foi esse modelo que
  produziu o erro de `docs/erros/2026-09-11-coluna-nao-criada-...`.
- **Lei 10 · a rotina de expurgo não existe.** O prazo de retenção está
  decidido (5 anos), mas nada apaga nada hoje. Validação jurídica é da
  Estação 7, com a skill `legal`.
