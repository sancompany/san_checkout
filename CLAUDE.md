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

**Estação 3 (Fundação) em andamento** — repositório, árvore de pastas e
segredos conferem (Leis 1 e 3). **CI não está verde** no último push
(`11498e5`) — ver pendência que bloqueia, abaixo. Estação não fecha
enquanto isso não estiver resolvido.

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

- **🔴 CI falhando no `main` (`11498e5`) — trocar `node-version` em
  `ci.yml`.** `@supabase/supabase-js` já exige WebSocket nativo (Node
  22+); o CI fixava Node 20 e caiu com
  `Error: Node.js detected but native WebSocket not found.` na suíte de
  `pedidoService.js`. A produção não sofre disso porque nunca teve
  `engines.node` declarado e o Render escolheu uma versão mais nova por
  conta própria — por sorte, não por decisão. Corrigido o lado que dava
  para corrigir: `package.json` ganhou `"engines": { "node": ">=22" }`.
  `.github/workflows/` é protegido contra escrita remota — colar isto em
  `ci.yml`, substituindo a linha `node-version: '20'`:

  ```yaml
        node-version: '22'
  ```

  Depois de colar e dar push, aviso quando reverifiquei o CI ao vivo.
  Ver `docs/erros/2026-09-11-ci-preso-em-node-20.md`.

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
- **Lei 6 · `supabase/schema.sql` é arquivo único editado a cada versão**,
  em vez de migrations numeradas e imutáveis. Foi esse modelo que
  produziu o erro de `docs/erros/2026-09-11-coluna-nao-criada-...`.
- **Lei 10 · a rotina de expurgo não existe.** O prazo de retenção está
  decidido (5 anos), mas nada apaga nada hoje. Validação jurídica é da
  Estação 7, com a skill `legal`.
