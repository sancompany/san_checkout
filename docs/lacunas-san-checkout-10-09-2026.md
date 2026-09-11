# San Checkout — Auditoria de lacunas para fechar a versão

> 10/09/2026. Objetivo: responder "o que ainda falta pra esse checkout
> estar pronto e parar de precisar de atualização a cada projeto novo".
>
> **Método:** li o código inteiro (`src/` e `public/`), varri a
> documentação oficial da Asaas (as 470 páginas de referência, extraindo
> os campos direto das definições OpenAPI publicadas), e comparei com o
> que Stripe, Mercado Pago, Pagar.me, PagBank, Yampi e Cartpanda tratam
> como padrão. Cada item abaixo diz de onde veio:
>
> - **[VERIFICADO NO CÓDIGO]** — eu abri o arquivo e conferi. É fato.
> - **[DOC ASAAS]** — está escrito na documentação oficial.
> - **[MERCADO]** — prática dos concorrentes.
> - **[JULGAMENTO]** — minha opinião, e você pode discordar.

---

## 0. A resposta honesta à sua pergunta

Você pediu "total certeza de que não tem mais nenhuma implementação
pra fazer". Não posso dar essa certeza, e quem der está mentindo —
Pix Automático não existia há dois anos, a reforma tributária mudou os
campos de nota fiscal neste ano, e a Asaas publica recurso novo todo
mês. Nenhum checkout do mundo fica pronto pra sempre.

Mas a sua pergunta de verdade não é essa. É: **"por que a Vitrina me
obrigou a mexer no checkout, e como faço pra isso não se repetir?"**
Essa eu consigo responder com precisão, e a resposta está na seção 1.
Ela vale mais que a lista de recursos, porque ataca a causa em vez do
sintoma.

Também dá pra responder com segurança a segunda parte: **um
desenvolvedor contratado olhando isso hoje não diria "está pronto"** —
ele acharia quatro coisas em menos de uma hora, e três delas são de
segurança ou dinheiro, não de funcionalidade. Estão na seção 2.

---

## 1. Por que a Vitrina forçou atualização (e o que vai forçar a próxima)

A Vitrina exigiu quatro mudanças: CPF virou CPF/CNPJ, `cpf` virou
`documento`, entraram os rótulos de ciclo trimestral/semestral/anual, e
o retry de webhook saiu do papel.

Olhando as quatro juntas, **três são a mesma falha, repetida**: o
checkout tinha enumerado só um pedaço de um domínio que a Asaas já
define inteiro.

- A Asaas sempre aceitou CNPJ. O checkout só tinha previsto CPF —
  porque o primeiro projeto vendia ingresso pra pessoa física.
- A Asaas sempre aceitou 7 ciclos de assinatura. O checkout conhecia 1.
- O `INTEGRACAO.md` já prometia retry. O código não fazia.

Ou seja: não apareceu requisito novo no mundo. **O checkout é que
sabia menos do que a Asaas já oferecia**, e cada projeto novo que
usasse um pedaço não mapeado virava uma tarefa de código.

### A prova de que isso ainda está vivo

**[VERIFICADO NO CÓDIGO]** `public/js/modules/assinaturaHandler.js`
linha 11 conhece 4 ciclos:

```js
const ROTULOS_CICLO = {
  MONTHLY: 'mensal', QUARTERLY: 'trimestral',
  SEMIANNUALLY: 'semestral', YEARLY: 'anual'
};
```

**[DOC ASAAS]** A Asaas aceita 7: `WEEKLY, BIWEEKLY, MONTHLY,
BIMONTHLY, QUARTERLY, SEMIANNUALLY, YEARLY`.

Faltam `WEEKLY`, `BIWEEKLY` e `BIMONTHLY`. O backend passa o ciclo
direto pra Asaas (`asaasCheckoutController.js` linha 217), então
tecnicamente funciona — mas o comprador de um plano semanal vê a
palavra **"weekly"** em inglês na tela. É exatamente o mesmo defeito
que a Vitrina te custou uma rodada de desenvolvimento, ainda presente,
esperando o projeto que venda plano quinzenal.

### A regra que fecha isso de vez

> **Onde a Asaas define um conjunto fechado de valores, o checkout tem
> que conhecer o conjunto inteiro — não o pedaço que o projeto da vez
> usa.**

São poucos conjuntos, e mapear todos é trabalho de uma tarde:

| Domínio | Conhece hoje | Asaas define |
|---|---|---|
| Ciclos de assinatura | 4 | 7 |
| Métodos de cobrança | 4 | Pix, Boleto, Cartão (+ Pix Automático) |
| Status de cobrança | 5 mapeados | 14 |
| Eventos de webhook | ~8 escutados | 112 disponíveis |

**[JULGAMENTO]** Se você fizer só isso e mais nada desta auditoria, já
elimina a maior fonte de "precisei mexer no checkout de novo".

---

## 2. O que um desenvolvedor contratado acharia hoje

Estes quatro não são falta de funcionalidade — são defeitos. Ordenados
por gravidade real.

### 2.1 🔴 O webhook que você envia pro contratante não tem autenticação nenhuma

**[VERIFICADO NO CÓDIGO]** `src/controllers/webhookController.js`:

```js
async function tentarNotificar(url, dados) {
  const resposta = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },   // ← só isso
    body: JSON.stringify(dados)
  });
}
```

Nenhum `X-Checkout-Key`, nenhuma assinatura HMAC, nenhum segredo.

**O que isso significa na prática:** qualquer pessoa que descubra a
`webhook_url` de um contratante pode mandar um POST dizendo
`{"pedidoId": "x", "status": "confirmado"}` e **a loja libera o pedido
sem ninguém ter pago**. Não precisa invadir nada — só acertar a URL.

O contraste é o que incomoda: você protegeu certo as outras três
fronteiras. O webhook que a Asaas te manda é verificado por token
(`verificarWebhookAsaas`), o `/estornar` exige `X-Checkout-Key`, o
admin exige usuário e senha com comparação em tempo constante. Só a
seta que sai pro contratante ficou aberta — e é justamente a que
libera mercadoria.

Pior: o `INTEGRACAO.md` seção 4.1 diz ao parceiro só "responda 200".
Não manda ele conferir nada. Então nem o parceiro caprichado se
defende.

**Correção:** assinar o corpo com HMAC-SHA256 usando a `api_key` que o
contratante já tem, mandar no header junto com um timestamp, e
documentar a verificação. É uma função de dez linhas usando `crypto`
do próprio Node, mais um parágrafo no `INTEGRACAO.md`.

### 2.2 🔴 Recarregar a página e clicar de novo gera uma segunda cobrança

**[VERIFICADO NO CÓDIGO]** O front desabilita o botão durante a geração
(`pixHandler.js` linha 48) — isso protege contra duplo clique na mesma
tela. Mas no servidor não existe trava nenhuma: `gerarPix` resolve o
pedido, cria a cobrança na Asaas e insere em `cobrancas`, sem nunca
perguntar se aquele pedido já tem cobrança viva. E o índice
`idx_cobrancas_pedido` (`supabase/schema.sql` linha 89) é índice comum,
**não é `unique`**.

**Consequência:** o comprador gera o Pix, se distrai, recarrega a
página, clica de novo — agora existem dois QR Codes válidos para o
mesmo pedido. Se ele pagar os dois (acontece: gente paga o QR antigo
que ficou no WhatsApp), você tem cobrança em duplicidade e estorno
manual. Em boleto é pior, porque o boleto antigo continua pagável por
dias.

**[MERCADO]** É por isso que idempotência é obrigatória nos gateways
sérios: o Mercado Pago **exige** o header `X-Idempotency-Key` em toda
integração nova desde janeiro de 2024; a Stripe usa `Idempotency-Key`
desde sempre.

**Correção:** antes de criar, procurar cobrança pendente do mesmo
`(contratante_id, pedido_id, metodo)`; se existir e ainda for válida,
devolver a que já existe em vez de criar outra. Isso conserta os dois
problemas de uma vez — porque é exatamente o que faz o comprador
recuperar o Pix dele ao voltar na página (ver 3.1).

### 2.3 🟠 A Asaas está mandando e-mail e SMS pros seus clientes, em nome dela

**[VERIFICADO NO CÓDIGO]** `asaasService.js`, `buscarOuCriarCliente`:

```js
body: JSON.stringify({ name: nome, email, cpfCnpj: documento, externalReference: documento })
```

**[DOC ASAAS]** Ao criar um cliente, a Asaas cria automaticamente 8
notificações — e-mail ligado e SMS ligado pro cliente por padrão
(eventos `PAYMENT_CREATED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`,
`PAYMENT_DUEDATE_WARNING`, `SEND_LINHA_DIGITAVEL` e outros). Para
desligar, existe o campo `notificationDisabled: true` na criação do
cliente, ou `PUT /v3/notifications/batch` depois.

**Dois problemas, ambos concretos:**

1. **Quebra o whitelabel.** O comprador da Trimundi paga e recebe
   e-mail da *Asaas* falando de cobrança. Ele nunca ouviu falar da
   Asaas. Isso gera dúvida, ticket de suporte e, no caso do vencimento
   de boleto, cobrança em nome de uma empresa que não é a do parceiro.
2. **Custa dinheiro.** SMS e ligação de voz são tarifados —
   `PAYMENT_SMS_NOTIFICATION_FEE` e `PHONE_CALL_NOTIFICATION_FEE`
   aparecem como tipos de lançamento no extrato da Asaas.

E é redundante com a arquitetura que você escolheu: você decidiu
explicitamente que **o e-mail ao pagador é responsabilidade de cada
contratante** (foi por isso que o `emailService.js` foi removido). A
Asaas está mandando e-mail por baixo, contrariando essa decisão.

**Correção:** uma linha — `notificationDisabled: true` na criação do
cliente. Vale conferir no painel da Asaas se já saiu SMS cobrado.

### 2.4 🟠 As taxas da Asaas estão fixas no código

**[VERIFICADO NO CÓDIGO]** `src/services/taxaService.js` linha 12 tem
uma tabela hardcoded (`cartao_credito_avista: { fixa: 0.49, percentual:
0.0299 }` etc.).

**[DOC ASAAS]** Existe `GET /v3/myAccount/fees` que devolve as taxas
reais da sua conta, e `POST /v3/payments/simulate`, que dado valor,
parcelas e método devolve `netValue`, `feeValue` e `feePercentage`.

**Por que importa:** essa tabela é a taxa *pública* da Asaas. No dia em
que a Asaas reajustar, ou no dia em que você negociar taxa melhor por
volume (o que é o objetivo do negócio), **o checkout vai continuar
cobrando o número velho do comprador e repassando o número velho pro
contratante** — silenciosamente, sem erro nenhum. Erra pra mais e você
cobra a mais do cliente; erra pra menos e você paga a diferença.

**Correção:** buscar as taxas da API e guardar em cache (uma vez por
dia basta), mantendo a tabela atual como fallback se a chamada falhar.

---

## 3. Lacunas de funcionalidade que valem a pena

### 3.1 🔴 O comprador não consegue recuperar um Pix ou boleto

**[VERIFICADO NO CÓDIGO]** Não existe nenhuma rota que devolva uma
cobrança já criada. As rotas de status
(`/api/checkout/pix/status/:chargeId`) exigem o `chargeId`, que o
comprador nunca vê. Recarregar a página do checkout não recupera nada —
gera cobrança nova (item 2.2).

**Por que isso é o item de melhor custo-benefício da lista inteira:**
Pix e boleto são assíncronos por natureza. A pessoa fecha a aba, o QR
some. O boleto vence em 3 dias e ela quer a segunda via. Hoje o único
caminho é ela ligar pro parceiro, e o parceiro ligar pra você. **Cada
venda em boleto é um ticket de suporte em potencial.**

**Correção:** uma página pública por cobrança
(`/pedido/{contratante}/{pedido}`) que mostra o estado atual — QR ainda
válido, linha digitável, "pago", "vencido" — e reexibe a cobrança
existente em vez de criar outra. Cai junto com a correção de 2.2:
é a mesma consulta.

### 3.2 🔴 O contratante não tem como consultar status (só receber push)

**[VERIFICADO NO CÓDIGO]** Não existe `GET /cobranca/:pedidoId`
autenticado. O `INTEGRACAO.md` seção 4.3 admite isso em voz alta: *"vale
ter uma forma manual de conferir isso (ex.: uma tela sua que consulta o
San Checkout por pedidoId, se algum dia precisar)"* — a doc reconhece a
lacuna e passa a responsabilidade adiante.

**Por que importa:** o retry do webhook é 3 tentativas em memória. Se o
servidor do parceiro estiver fora por 20 minutos, ou se o Render
reiniciar no meio, **a notificação se perde pra sempre e o pagamento
fica confirmado só do seu lado**. O dinheiro entrou e o pedido nunca foi
liberado. Sem endpoint de consulta, o parceiro não tem como descobrir
sozinho — nem como conciliar no fim do dia.

**[MERCADO]** Push sem pull é considerado incompleto em qualquer
gateway: webhook é otimização, a consulta é a rede de segurança.

**Correção:** `GET /api/checkout/cobranca/:contratanteId/:pedidoId`
autenticado por `X-Checkout-Key` (a mesma que o `/estornar` já usa).

### 3.3 🟠 Pix Automático — a lacuna mais datada da stack

**[DOC ASAAS]** A Asaas já expõe: `POST /v3/pix/automatic/authorizations`,
instruções de pagamento, retentativas, 10 eventos de webhook, e o campo
`pixAutomaticAuthorizationId` em `POST /v3/payments`.

É débito recorrente autorizado pelo banco do pagador — assinatura sem
cartão, sem chargeback e sem churn por cartão vencido.

**[JULGAMENTO]** Hoje sua assinatura só existe no cartão de crédito.
Isso exclui quem não tem cartão e sofre com a maior causa de perda
silenciosa de receita em recorrência: cartão expirado ou sem limite.
Se você fosse implementar **um** recurso novo desta auditoria inteira,
eu escolheria esse — é o que mais muda o alcance do produto, e o PSP já
entrega pronto. Como a Vitrina é justamente um produto de assinatura
B2B, provavelmente é o próximo pedido que vai chegar.

### 3.4 🟠 Assinatura só sabe criar e cancelar

**[DOC ASAAS]** Existe muito mais, e nada disso está implementado:

| O que | Como |
|---|---|
| Pausar e retomar | `PUT /v3/subscriptions/{id}` com `status: INACTIVE` / `ACTIVE` |
| Trocar o cartão sem cobrar | `PUT /v3/subscriptions/{id}/creditCard` |
| Mudar valor ou ciclo | `PUT /v3/subscriptions/{id}` (+ `updatePendingPayments`) |
| Plano com prazo determinado | campo `maxPayments` |
| Nota fiscal automática por ciclo | `/v3/subscriptions/{id}/invoiceSettings` |

**[JULGAMENTO]** "Trocar o cartão" é o mais importante: sem isso, um
assinante cujo cartão venceu **não tem como continuar assinante** — tem
que cancelar e assinar de novo, o que na prática vira cancelamento. Pra
um produto B2B recorrente como a Vitrina, isso é perda de receita
garantida no primeiro vencimento de cartão da base.

### 3.5 🟠 Cartão recusado deixa o comprador na rua

**[JULGAMENTO + MERCADO]** Quando o cartão é negado dentro da pop-up da
Asaas, o comprador volta pro checkout sem caminho. Não existe "tentar
outro cartão" nem "pagar com Pix" oferecido no momento da recusa.

Cascata de adquirentes (o que Yampi e Pagar.me vendem) **você não
consegue fazer** — precisaria ser gateway, e o cartão passa pela pop-up
da Asaas. Isso é honestamente inviável e eu não recomendo perseguir.

Mas oferecer o Pix na hora da recusa custa quase nada e recupera venda
que hoje some. Esse é o recorte que cabe na sua arquitetura.

### 3.6 🟡 Só 8 dos 112 eventos de webhook da Asaas são escutados

**[DOC ASAAS]** Destes, três valem de verdade pra você:

- **`ACCESS_TOKEN_EXPIRING_SOON`** — a Asaas expira chave de API por
  inatividade. Sem escutar isso, **a integração morre sozinha um dia,
  sem aviso**. Baratíssimo de ligar, e evita um incidente do tipo
  "parou tudo e ninguém sabe por quê".
- **`ACCOUNT_STATUS_*`** (18 eventos) — você agora cria subcontas via
  API, mas não tem como saber quando a Asaas aprovou cada uma. Hoje
  isso é conferido na mão.
- **`PAYMENT_CHECKOUT_VIEWED`** / **`PAYMENT_BANK_SLIP_VIEWED`** — o
  comprador abriu a cobrança e não pagou. É o gatilho de recuperação
  mais honesto que existe, e você pode só repassar como evento pro
  contratante decidir o que fazer.

### 3.7 🟡 Sem métricas de funil

**[VERIFICADO NO CÓDIGO]** A tabela `cobrancas` guarda a cobrança
criada, mas não há registro de quem abriu o checkout e não gerou
cobrança, nem de quantos Pix gerados viraram Pix pagos.

**[JULGAMENTO]** **Taxa de pagamento do Pix gerado** é a métrica que
mais diz sobre a saúde de um checkout brasileiro, e hoje ela não existe.
Sem ela, qualquer decisão futura sobre o checkout — inclusive quais
itens desta auditoria priorizar — é chute. Não precisa de BI: duas
colunas de timestamp e uma query.

---

## 4. O que eu recomendo NÃO fazer

Estes aparecem em toda lista de "checkout completo" e eu acho que no seu
caso são erro. Registrando pra você não ser convencido depois.

- **Upsell one-click pós-compra.** Exige você guardar o cartão
  tokenizado. Hoje o cartão passa pela pop-up da Asaas, e é justamente
  isso que te mantém **fora do escopo PCI-DSS**. Trazer cartão pra
  dentro troca um ganho incerto por auditoria de segurança, custo
  recorrente e responsabilidade legal. Não vale.
- **Prova social sintética** ("237 pessoas compraram hoje"). Não achei
  nenhuma fonte séria de ganho de conversão *na etapa de checkout* — a
  decisão social acontece na página de produto. E você não tem os dados
  reais pra gerar isso com honestidade, o que empurra pra número
  inventado.
- **Timer de escassez falso.** Risco de publicidade enganosa (CDC art.
  37). Mas note: você **já tem** expiração de pedido de verdade —
  mostrar o tempo real restante é legítimo e útil. Use o que é real.
- **Multimoeda e internacionalização.** Asaas é BRL, parceiros são BR,
  métodos são Pix e boleto. É resolver problema que você não tem.
- **Cashback, desconto progressivo, order bump com catálogo próprio.**
  Regra de preço pertence ao contratante. Sua arquitetura acertou ao
  manter cupom e desconto vindo da API dele — não quebre isso. Se um dia
  precisar de order bump, faça o parceiro devolver as ofertas no próprio
  `GET /pedido/{id}`, nunca guardando produto do seu lado.

---

## 5. Uma lacuna que não é de código

**[MERCADO + JULGAMENTO]** Seu produto exige que **o parceiro escreva
código** — ele tem que expor `GET /pedido/{id}` e receber webhook. Isso
significa que a documentação e o ambiente de teste não são "nice to
have": são parte do produto.

Hoje existe o `INTEGRACAO.md`, que é bom. Faltam duas coisas:

1. **Modo sandbox seu.** O parceiro precisa conseguir testar o fluxo
   inteiro — pedido, pagamento, webhook — sem mover dinheiro. Você já
   tem o sandbox da Asaas embaixo; falta expor isso como um modo que o
   parceiro possa usar sozinho.
2. **Regra de compatibilidade escrita.** Uma linha no `INTEGRACAO.md`:
   *"só adicionamos campos ao payload, nunca removemos nem renomeamos"*.
   Isso é o que impede que a próxima Vitrina quebre a Trimundi. Custa
   uma frase agora; é impossível de introduzir depois que houver cinco
   parceiros.

E uma correção pequena no contrato, ligada a segurança: o
`INTEGRACAO.md` **não exige que o `pedidoId` seja imprevisível**
[VERIFICADO — não há menção]. Se um parceiro usar id sequencial
(`1`, `2`, `3`), qualquer um pode varrer `?c=parceiro&pedido=N` e ver
valor, itens e os dados do pagador que vierem pré-preenchidos. A
consulta é pública por necessidade — o comprador precisa dela. A defesa
tem que ser o id opaco, e isso precisa estar escrito como obrigação.

---

## 6. Ordem que eu seguiria

**Antes de considerar a versão fechada** (defeito, não funcionalidade):

1. Assinar o webhook de saída com HMAC + documentar a verificação (2.1)
2. Não gerar cobrança duplicada — reaproveitar a pendente (2.2)
3. `notificationDisabled: true` no cliente Asaas (2.3)
4. Completar os conjuntos que a Asaas define — começando pelos 3 ciclos
   faltando (seção 1)
5. Exigir `pedidoId` imprevisível no `INTEGRACAO.md` (seção 5)

**Fecham o produto de verdade:**

6. Página pública de status + segunda via de Pix/boleto (3.1)
7. `GET /cobranca/:pedidoId` autenticado pro parceiro conciliar (3.2)
8. Taxas vindas da API da Asaas com cache (2.4)
9. Trocar cartão da assinatura (3.4)
10. Pix na recusa do cartão (3.5)
11. `ACCESS_TOKEN_EXPIRING_SOON` e `ACCOUNT_STATUS_*` (3.6)

**Próximo salto de alcance, quando fizer sentido comercial:**

12. Pix Automático (3.3)
13. Métricas de funil (3.7)
14. Sandbox para o parceiro (seção 5)

Os cinco primeiros são o que separa "um dev olha e aprova" de "um dev
olha e faz cara feia". Nenhum deles é grande: o maior é o item 2, e
mesmo ele é uma consulta antes de criar.

---

## 7. O que já está certo (e um dev vai notar)

Pra não parecer que só tem problema — isso aqui está acima da média e
vale saber que está:

- **Modelo pull.** O checkout nunca confia em valor vindo do navegador,
  e re-resolve o pedido na hora de cobrar. É a decisão de arquitetura
  mais importante do projeto e está certa.
- **Isolamento entre contratantes.** [VERIFICADO] O `contratanteId` da
  URL não é autoridade: o pedido é buscado na API *daquele* contratante,
  com a chave *dele*. Não existe caminho pra ler pedido de outro. Esse é
  o primeiro teste que um auditor faria, e passa.
- **Cartão fora do escopo PCI**, via pop-up hospedada.
- **Rate limiting** com instância por rota (10/min em criação) — e o
  comentário no `server.js` mostra que o bug de balde compartilhado já
  foi encontrado e corrigido.
- **Comparação de credencial em tempo constante**, fail-closed quando
  falta variável de ambiente.
- **Taxa recalculada no servidor**, nunca aceita do cliente.
- **CEP → endereço** e **CPF/CNPJ no mesmo campo**: os dois maiores
  ganhos de UX brasileira, já feitos.

O checkout não está mal construído. Ele está **incompleto em pontos
específicos e identificáveis** — que é uma situação muito melhor.
