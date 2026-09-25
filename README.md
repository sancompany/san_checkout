# San Checkout — SAN & CO. Pay Engine

Motor de pagamento whitelabel do ecossistema San & Co. Pix, Boleto,
Cartão de Crédito (1 a 12x), Assinatura por cartão e Assinatura por Pix
Automático, sobre a Asaas.

**Modelo *pull*:** o checkout não guarda catálogo. Ele recebe só
referências opacas na URL, pergunta os dados do pedido à API do próprio
contratante e cobra o valor que veio nessa resposta — nunca um valor
vindo do navegador.

> **Vai mexer no projeto?** Comece pelo [`CLAUDE.md`](./CLAUDE.md) — ele
> diz o que ler antes de tocar em qualquer coisa.
>
> **Vai integrar um projeto ao checkout?** O contrato completo está em
> [`API.md`](./API.md).

---

## Como rodar

```bash
npm install
cp .env.example .env      # preencher com valores reais
npm start                 # backend em http://localhost:3001
```

Front-end: servir a pasta `public/` (Live Server na porta 5501, que é o
valor padrão de `ORIGEM_FRONTEND`).

Banco: rodar os arquivos de `supabase/migrations/` **em ordem numérica**
no SQL Editor do Supabase. Banco novo começa no `0001_baseline.sql`, que
é idempotente e pode ser reexecutado.

**Mudança de schema é sempre um arquivo novo** (`0002_…`, `0003_…`),
nunca uma edição num que já rodou — ver `CONSTRAINTS.md`.

## Como ver a tela do checkout sem um pedido real

```bash
node scripts/ver-checkout.mjs              # pedido avulso
node scripts/ver-checkout.mjs assinatura   # mensalidade recorrente
node scripts/ver-checkout.mjs sem-total    # o estado indisponível
```

Sobe um servidor local que serve o `public/` e responde a API com um
pedido de mentira, e imprime o endereço para abrir no navegador. Não
precisa de `.env`, não tem dependência nova, e não toca Asaas, Supabase
nem produção — é para conferir a tela com o olho, que é o que a Lei 5
pede e nenhuma leitura de código substitui.

Roda na porta **3001** de propósito: é a que `public/js/utils/api.js`
procura quando a página é servida de localhost. Se o backend de verdade
estiver rodando aí, pare ele antes.

## Como rodar os testes

```bash
npm test
```

Roda as 66 suítes de uma vez — e este número é **conferido por teste**
(`tests/o-que-os-documentos-afirmam.js`), porque ele já esteve errado
três vezes em 17/09/2026 e corrigir à mão não impede a próxima. Até
aquele dia este parágrafo dizia "dezoito".

A fonte da lista é `tests/executar.js`. O que ela cobre, em grupos:
assinatura HMAC e o caminho crítico do webhook de entrada (guarda de
origem, mapa de evento→status, idempotência, soma de taxas, gravação da
auditoria); a conversão das taxas da Asaas e o piso de valor do
provedor; a allowlist de origem do `returnUrl`, com bypasses reais de
open redirect; a redação do log, que falha se sobreviver dado de
pessoa; as rotas HTTP contra a pilha do Express montada de verdade; e o
que os documentos afirmam.

Não precisa de `.env`: o runner injeta valores falsos só para os módulos
carregarem, e nenhum teste toca banco, rede ou relógio. Os mesmos testes
rodam sozinhos a cada push, em `.github/workflows/ci.yml` — push que
quebra teste não entra.

## Medir acessibilidade e desempenho

Estes dois abrem um **Chromium de verdade** e por isso não entram no
`npm test` — precisam de navegador, e o CI não tem um.

```bash
npm run acessibilidade   # axe-core, WCAG 2.2 AA, falha com violação
npm run desempenho       # LCP, INP e CLS num funil de celular em 4G lento
```

O de desempenho mede **laboratório**, não campo: o "p75" dele é sobre as
rodadas da execução, não sobre usuários. Campo exige visitante real, e é
o painel do Web Analytics da Cloudflare que vai ter isso quando houver
tráfego. Este script serve para outra coisa — orçamento reprodutível,
que cai junto com uma regressão.

Exige **Node 22 ou mais novo** (`engines` no `package.json`, e `.nvmrc`):
`@supabase/supabase-js` usa WebSocket nativo, que não existe no Node 20 —
ver `docs/erros/2026-09-11-ci-preso-em-node-20.md`.

## Antes de empurrar

```bash
npm run check
```

Analisa a sintaxe de **todo** o JavaScript do projeto — inclusive
`public/js/`, que as suítes não alcançam porque elas exercitam o
backend — e depois roda `npm test`. Erro de sintaxe no front não quebra
teste nenhum: aparece no navegador do comprador. Não instala nada e não
toca rede.

## Variáveis de ambiente

Nomes; os valores ficam no `.env` local e no painel do Northflank.

| Variável | Para quê |
|---|---|
| `PORT` | Porta do backend (padrão 3001) |
| `ORIGEM_FRONTEND` | Única origem liberada no CORS |
| `SUPABASE_URL` | Projeto do Supabase |
| `SUPABASE_SERVICE_KEY` | Chave `service_role` — só o backend a usa |
| `ASAAS_API_KEY` | Chave da conta Asaas |
| `ASAAS_AMBIENTE` | `producao` usa a API de produção; qualquer outro valor usa o sandbox |
| `ASAAS_WEBHOOK_TOKEN` | Token que a Asaas reenvia em cada webhook. Sem ele, o endpoint recusa tudo |
| `CHECKOUT_ADMIN_USER` | Usuário do painel administrativo |
| `CHECKOUT_ADMIN_PASS_HASH` | Hash scrypt da senha do painel — gere com `node scripts/gerar-hash-admin.js`. A senha em texto puro não é lida em lugar nenhum |
| `TAXA_PERCENTUAL` / `TAXA_FIXA` | Compõem a taxa própria do checkout |

## Cadastrar um contratante

Pelo painel: `/admin.html` → **Contratantes** → **Novo contratante**. O
painel é alcançado pela própria URL (`checkout.sancocore.com.br/admin.html`)
e protegido na borda — ver `CONSTRAINTS.md` §2.6. Não existe mais atalho
escondido dentro do checkout público.
A `api_key` é gerada pelo backend, nunca aceita do formulário, e fica
visível na linha do contratante para copiar.

Nunca por API pública, e nunca inserindo linha à mão no Supabase.

**Chave vazada?** Aba Contratantes → o ícone de setas em círculo ao lado
da chave (o terceiro, depois do olho e do copiar). A troca é imediata: a
chave antiga morre no ato e a integração do contratante fica parada até
ele colar a nova, então a ordem é trocar, copiar, avisar. Não existe
janela de convivência entre as duas.

## Onde roda

| Camada | Onde |
|---|---|
| Backend | Northflank (América do Sul – Leste, Osasco) — `https://api.sancocore.com.br` |
| Front | Cloudflare Pages — `https://checkout.sancocore.com.br` |
| Banco | Supabase (RLS habilitado; só o backend acessa) |
| Pagamento | Asaas |

`/api/saude` é consultada por um agendador externo a cada 10 minutos:
mantém o Supabase ativo (projeto gratuito pausa com 7 dias de
inatividade) e expõe alerta de chave da Asaas prestes a expirar.
