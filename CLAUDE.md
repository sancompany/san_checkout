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

Estações 1 (Escopo) e 2 (Fronteiras) fechadas. Classificação registrada
em `docs/specs/2026-09-11-san-checkout.md`: San Checkout é **estrutura**,
não projeto — banco próprio e isolado, consome domínio/DNS, GitHub,
Render e Cloudflare Pages da San & Co.; não consome e-mail nem Drive.

**Estação 3 (Fundação) fechada.** Repositório, árvore de pastas, segredo
fora do código (Leis 1, 3, 9) e CI verde num push real (`4c01cda`, run
#5, reverificado ao vivo) — ver
`docs/erros/2026-09-11-ci-preso-em-node-20.md`.

**Estação 4 (Contratos) em andamento.** Conferido e conforme: contrato de
API explícito com entrada, saída e tabela de erros (`API.md`, seções 4-5
e 9-10); RLS habilitada nas quatro tabelas com negação por padrão;
schema alterado só pelo SQL Editor, nunca por `DATABASE_URL` direto;
inventário de dados preenchido e com o caminho de exclusão verificado
contra a modelagem (`docs/inventario-de-dados.md` §6.2). **Três
pendências bloqueantes abertas nesta estação** — ver abaixo.

(A Lei 0 como um todo continua aberta e não bloqueia — ver pendências:
falta a skill `revisar` rodar sobre o que está em produção.)

## Conformidade é obrigatória

Violação encontrada segue o ciclo das leis: corrigir o aditivo na hora,
propor o estrutural, registrar a decisão no documento certo, reverificar.
Não existe estado final fora de conformidade — ou corrige, ou vira
exceção registrada no `CONSTRAINTS.md`.

## Pendências de conformidade abertas

Esta é a lista única. O que não está aqui, está fechado.

### Bloqueiam a esteira — dependem de ação do dono

- **🔴 Lei 6 · tirar o `supabase/schema.sql` antigo do versionamento.**
  A regra nova já vale (`CONSTRAINTS.md` §2.1) e
  `supabase/migrations/0001_baseline.sql` já existe, congelado, com o
  corpo byte a byte igual ao schema antigo. Falta só remover o arquivo
  duplicado — um comando, na raiz do projeto:

  ```
  git rm supabase/schema.sql
  ```

  Enquanto os dois existirem, há duas fontes de verdade para o schema, que
  é exatamente o que a Lei 6 proíbe. **Este comando chegou a ser rodado em
  11/09/2026, mas foi desfeito** pelo `git filter-repo --force` da
  reescrita de histórico, que restaurou a árvore commitada por cima do que
  não tinha sido commitado — ver
  `docs/erros/2026-09-11-filter-repo-apagou-trabalho-nao-commitado.md`.
  Precisa ser rodado de novo, agora com tudo commitado antes.
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
- **Estação 6 · amplificação de memória em `/api/admin`.** Cada tentativa
  de login deriva scrypt a N=2^17, que custa **128 MB**. O rate limit
  atual (10/min por IP) limita a taxa, não a simultaneidade: 10 chamadas
  disparadas juntas pedem 1,28 GB numa instância de 512 MB. Uso normal do
  painel não chega perto (as chamadas são sequenciais, pico de uma
  derivação por vez), mas é vetor de negação de serviço de quem sondar.
  Mitigação provável: limitar derivações concorrentes. Levantado ao subir
  o parâmetro de 2^14 para 2^17 — é consequência direta dessa mudança.
- **Lei 10 · a rotina de expurgo não existe.** O prazo de retenção está
  decidido (5 anos), mas nada apaga nada hoje. A modelagem **suporta** o
  expurgo (verificado na Estação 4 — ver `docs/inventario-de-dados.md`
  §6.2); falta escrever a rotina. Validação jurídica é da Estação 7, com
  a skill `legal`.
- **Lei 10 · log de produção grava dado pessoal em texto puro.** O
  `webhookController.js` registra o payload cru dos webhooks da Asaas,
  que contém dado do comprador (não contém dado de cartão), retido pelo
  Render. Estava só no `docs/inventario-de-dados.md` §7 e não nesta
  lista — a lista é uma só, então passa a constar aqui. Reduzir aos
  campos de diagnóstico assim que o formato dos eventos estiver
  confirmado ao vivo.
