# San Checkout — Documentação de Integração

> Este documento descreve o CONTRATO entre o San Checkout e qualquer
> projeto que queira usá-lo (Trimundi9, Anakor, ou qualquer projeto
> futuro). Um desenvolvedor implementando um projeto novo deve conseguir
> seguir só este arquivo, sem precisar perguntar nada a mais sobre como
> ligar seu projeto ao checkout.
>
> Este NÃO é o documento da arquitetura interna do San Checkout (banco,
> serviços, controllers) — é só o que atravessa a fronteira entre os
> dois sistemas.

---

## 1. Modelo geral — "pull"

O San Checkout **não guarda catálogo de produtos**. Cada projeto é dono
dos próprios dados (o quê está sendo vendido, por quanto, pra quem).

O fluxo é sempre este:

1. O projeto monta um **pedido** no banco dele (itens, valores, quem
   está comprando).
2. O projeto gera um link de checkout carregando só **referências
   opacas** — nunca preço, nunca nome de produto na URL.
3. Quando a pessoa abre o link, o San Checkout **liga de volta** pra
   uma API que o projeto expõe, pedindo os dados reais daquele pedido.
4. O San Checkout cobra o valor que RECEBEU NESSA CHAMADA — nunca um
   valor vindo da URL ou do navegador da pessoa pagando.
5. Quando o pagamento confirma, o San Checkout **chama de volta** uma
   URL de notificação que o projeto também cadastrou, avisando o que
   aconteceu.

---

## 2. Formato do link de checkout

```
https://SEU-DOMINIO-DO-CHECKOUT/index.html?c=SEU_CONTRATANTE_ID&pedido=SEU_PEDIDO_ID
```

| Parâmetro | Obrigatório | Descrição |
|---|---|---|
| `c` | sim | O identificador do seu contratante — combinado manualmente com o San Checkout antes de qualquer integração (ver seção 6) |
| `pedido` | sim | O identificador do pedido no SEU sistema — o San Checkout nunca gera esse id, só repassa |

Nenhum outro parâmetro é lido. Nome, valor, descrição, desconto — nada
disso trafega pela URL. Isso é proposital: qualquer dado sensível na
URL pode ser copiado, compartilhado ou adulterado por quem recebeu o
link.

---

## 3. O que o SEU projeto precisa expor

### 3.1 Endpoint de consulta de pedido

```
GET {sua_base_url}/pedido/{pedidoId}
Header: X-Checkout-Key: <sua chave, combinada na configuração manual>
```

Seu endpoint deve responder em até **45 segundos**. Esse número não é
arbitrário — é calibrado pro pior caso de cold start em hospedagem
gratuita tipo Render (30-50s pra "acordar"). Se você hospeda sua API em
algo que não hiberna, isso nunca chega perto do limite; se hospeda em
plano gratuito, é o tempo que garantimos esperar antes de desistir.

**Resposta esperada (200):**

```json
{
  "pedidoId": "abc123",
  "status": "pendente",
  "itens": [
    { "nome": "Ingresso Pista — Lote 1", "quantidade": 2, "valorUnitario": 80.00 },
    { "nome": "Ingresso VIP — Lote 2", "quantidade": 2, "valorUnitario": 150.00 }
  ],
  "valorCheio": 460.00,
  "desconto": 20.00,
  "cupom": "LOTE1PROMO",
  "valorComDesconto": 440.00,
  "taxaDoProjeto": 0,
  "frete": 0,
  "isentarTaxa": false,
  "descricao": "Trimundi9 — Lote 1",
  "contratanteLogoUrl": "https://trimundi9.com/logo.png",
  "bannerUrl": "https://trimundi9.com/banner-lote1.png",
  "pagador": { "nome": "...", "email": "...", "cpf": "...", "telefone": "..." },
  "expiraEm": "2026-10-01T23:29:59Z"
}
```

| Campo | Tipo | Obrigatório | Observação |
|---|---|---|---|
| `pedidoId` | string | sim | Deve bater com o `?pedido=` da URL |
| `status` | string | sim | `pendente`, `pago`, `cancelado`, ou `expirado`. Ver 3.1.1 |
| `itens` | array | sim | Só exibição — o San Checkout não soma isso, você já manda o total pronto |
| `itens[].nome` | string | sim | |
| `itens[].quantidade` | number | sim | |
| `itens[].valorUnitario` | number | sim | Em reais, com centavos (`80.00`, não `8000`) |
| `valorCheio` | number | sim | Valor antes de qualquer desconto |
| `desconto` | number | não (default `0`) | |
| `cupom` | string ou `null` | não | Guardado só como referência — o San Checkout não valida cupom |
| `valorComDesconto` | number | sim | `valorCheio - desconto` |
| `taxaDoProjeto` | number | não (default `0`) | Se o SEU projeto cobra alguma taxa própria, separada da do checkout |
| `frete` | number | não (default `0`) | `0` se não for produto físico |
| `isentarTaxa` | boolean | não (default `false`) | `true` = essa venda específica não paga a taxa do San Checkout (ex.: promoção pontual "taxa zero" que o SEU projeto decidiu). `false`/omitido = cobra normalmente. Ver seção 8 |
| `descricao` | string | sim | Aparece no resumo do pedido pro pagador |
| `contratanteLogoUrl` | string (URL) | não | Logo do SEU projeto — aparece no cabeçalho ao lado da logo do San Checkout, com um ícone de "duas setas" entre elas. Sem esse campo, aparece só a logo do San Checkout |
| `bannerUrl` | string (URL) | não | Imagem retangular (banner/anúncio) — aparece entre o cabeçalho e o resumo do pedido. Pode ser algo ligado ao pedido, ou uma promoção qualquer do seu projeto. Sem esse campo, o espaço simplesmente não existe |
| `pagador` | object | não | Se enviado, pré-preenche nome/e-mail/CPF/telefone na tela — a pessoa ainda pode editar. Ver `pagador.telefone` abaixo — desde que o Cartão de Crédito passou a exigir telefone, vale a pena mandar esse campo pra poupar o pagador de digitar de novo |
| `pagador.telefone` | string | não | Adicionado nesta versão: a Asaas passou a exigir telefone (`customerData.phoneNumber`) pra criar a sessão de pagamento por Cartão/Assinatura. Se o SEU projeto já tem o telefone do cliente, mandar aqui pré-preenche e evita repetição — se não mandar, o próprio checkout pede na tela (campo obrigatório lá, independente do `pedido`) |
| `expiraEm` | string (ISO 8601) | não | Se passar dessa data/hora, o San Checkout recusa cobrar, mesmo que o status ainda diga "pendente" |

#### 3.1.1 Sobre `status`

Isso é proteção, não só metadado:

- Se `status` vier `"pago"` ou `"cancelado"`, o San Checkout **recusa
  cobrar de novo** — é o que evita cobrança duplicada se a pessoa
  atualizar a página ou abrir em duas abas.
- Se vier `"pendente"` mas `expiraEm` já passou, o San Checkout trata
  como expirado, mesmo sem você ter atualizado o status ainda.

### 3.2 Respostas de erro esperadas

| Situação | O que seu endpoint deve responder | O que a pessoa pagando vê |
|---|---|---|
| Pedido não existe | `404` | "Pedido não encontrado" |
| Pedido já foi cancelado por você | `200` com `status: "cancelado"` | "Este pedido foi cancelado" |
| Erro interno seu | `500` (ou qualquer 5xx) | "Não foi possível carregar os dados do pedido, tente novamente" |
| Sem resposta em 45s | (timeout do nosso lado) | Mesma mensagem de erro interno acima |

O San Checkout **não tenta de novo automaticamente** se seu endpoint
falhar — a pessoa vê o erro e pode recarregar a página, o que gera uma
nova tentativa.

---

## 4. Confirmação de pagamento (o San Checkout te avisa)

### 4.1 O que você precisa expor

```
POST {seu_webhook_url}
Content-Type: application/json
```

Você deve responder **200** rapidamente (não precisa processar antes de
responder — responda 200 e processe depois, se quiser).

### 4.2 Payload que você recebe

```json
{
  "pedidoId": "abc123",
  "chargeId": "pay_xxx",
  "status": "confirmado",
  "valorCheio": 460.00,
  "desconto": 20.00,
  "cupom": "LOTE1PROMO",
  "valorComDesconto": 440.00,
  "frete": 0,
  "taxaDoProjeto": 0,
  "taxaAsaas": 8.80,
  "taxaPropria": 0.50,
  "taxaIsenta": false,
  "taxasTotais": 9.30,
  "metodoPagamento": "cartao_credito",
  "valorCobrado": 449.30
}
```

`taxaAsaas` é o custo real que a Asaas cobra do San Checkout naquele
método (Pix, Cartão, Boleto têm tabelas diferentes — ver seção 8).
`taxaPropria` é a margem do San Checkout, sempre igual não importa o
método. Se você mandou `isentarTaxa: true` no pedido, `taxaIsenta` vem
`true`, `taxaAsaas`/`taxaPropria` vêm `0`, e `taxasTotais` vira só o
que o SEU projeto cobra (`taxaDoProjeto`, se houver) — a isenção é só
da taxa do checkout, não da taxa própria do seu projeto.

`status` reflete toda mudança que a cobrança sofrer, não só a
confirmação:

| `status` | Quando chega |
|---|---|
| `confirmado` | Pagamento caiu — é o gatilho pra você emitir a nota fiscal e avisar o pagador (ver nota abaixo) |
| `estornado` | Estorno concluído (Pix/Cartão são síncronos, chegam direto aqui) |
| `estorno_solicitado` | Só pra Boleto — estorno iniciado mas ainda depende do pagador preencher um link bancário (ver seção 7) |
| `estorno_negado` | A Asaas recusou o estorno |
| `vencido` | Cobrança passou do vencimento sem pagar (só relevante pra Boleto) |

> **Nota fiscal e e-mail de confirmação são responsabilidade do SEU
> projeto.** O San Checkout só processa o pagamento e te avisa da
> mudança de status — ele não emite nota fiscal nem manda e-mail ao
> pagador. Use o `confirmado` acima como gatilho pra fazer isso do seu
> lado.

### 4.3 Política de novas tentativas

Se seu endpoint não responder 200 (erro, timeout, ou fora do ar), o San
Checkout tenta de novo **3 vezes, espaçadas em alguns minutos**. Depois
disso, desiste e só registra no próprio log — não existe fila
persistente de retry indefinido nesta versão. Se seu servidor cair bem
na hora, e as 3 tentativas esgotarem, o pagamento **continua confirmado
do lado do San Checkout** (o dinheiro entrou), só a notificação que se
perde — vale ter uma forma manual de conferir isso (ex.: uma tela sua
que consulta o San Checkout por `pedidoId`, se algum dia precisar).

---

## 5. Moeda

Sempre BRL. Não existe parâmetro de moeda — se um dia isso mudar, é uma
versão nova deste contrato, não um campo opcional adicionado.

---

## 6. O que precisa ser combinado manualmente (nunca por API)

Estes dados são sensíveis o bastante pra nunca trafegarem por endpoint
público ou parâmetro de URL — são combinados diretamente entre você e
quem administra o San Checkout, cadastrados pela tela `/admin.html`
(ver `README.md`):

| Dado | Pra que serve |
|---|---|
| `contratante_id` | O valor que vai no `?c=` do link |
| URL base da sua API de pedidos | Pra onde o San Checkout liga na consulta (seção 3.1) |
| Sua chave (`X-Checkout-Key`) | Autentica a consulta de pedido — sem ela, sua API deveria recusar a chamada |
| `webhook_url` | Pra onde a confirmação de pagamento é enviada (seção 4) |
| `wallet_id` da Asaas (se for usar split) | Pra onde sua parte do dinheiro vai automaticamente |

Se algum desses precisar mudar, é pedido feito diretamente, não
autoatendimento — não existe (ainda) painel de login pra você mesmo
editar.

---

## 6.1 Assinatura (recorrência) — modelo separado do pedido avulso

Diferente do fluxo de `pedido` (compra avulsa, único pagamento),
**assinatura é uma relação contínua** — cartão digitado uma vez, a
Asaas cobra automaticamente todo ciclo. Link de checkout próprio:

```
https://SEU-DOMINIO-DO-CHECKOUT/index.html?c=SEU_CONTRATANTE_ID&assinatura=SEU_PLANO_ID
```

Mesma regra de segurança do pedido — **nunca confiar em valor vindo da
URL** — então seu projeto expõe um endpoint próprio de plano:

```
GET {sua_base_url}/plano/{planoId}
Header: X-Checkout-Key: <sua chave>
```

**Resposta esperada (200):**
```json
{
  "planoId": "mensal-basico",
  "nome": "Plano Mensal",
  "descricao": "Acesso completo, cobrança mensal",
  "valor": 49.90,
  "ciclo": "MONTHLY",
  "contratanteLogoUrl": "https://trimundi9.com/logo.png",
  "bannerUrl": "https://trimundi9.com/banner-plano.png",
  "pagador": { "nome": "...", "email": "...", "cpf": "...", "telefone": "..." }
}
```

| Campo | Tipo | Obrigatório |
|---|---|---|
| `planoId` | string | sim — deve bater com `?assinatura=` |
| `nome` | string | sim |
| `descricao` | string | não |
| `valor` | number | sim |
| `ciclo` | string | sim — `MONTHLY` (por enquanto o único ciclo suportado) |
| `contratanteLogoUrl` | string (URL) | não — mesmo comportamento do `pedido` |
| `bannerUrl` | string (URL) | não — mesmo comportamento do `pedido` |
| `pagador` | objeto | não — pré-preenche nome/e-mail/CPF/telefone, mesmo comportamento do `pedido` (ver seção 3.1 sobre `pagador.telefone`) |

**Confirmação:** eventos de assinatura chegam no mesmo `webhook_url`
já cadastrado, com um campo `tipo` pra diferenciar do webhook de
pedido:
```json
{
  "tipo": "assinatura",
  "planoId": "mensal-basico",
  "cpf": "...",
  "evento": "criada" | "cobranca_confirmada" | "cobranca_falhou" | "cobranca_estornada" | "cancelada"
}
```

Nota fiscal e e-mail de confirmação de cada ciclo cobrado também são
responsabilidade do SEU projeto, disparados por `cobranca_confirmada`
— mesma regra da seção 4.2.

**Cancelamento:** só o projeto aciona (nunca o pagador direto no
checkout) — `POST {base_do_checkout}/cancelar-assinatura`, mesma
autenticação por `X-Checkout-Key` do `/estornar`.

---

## 7. Estorno

Você aciona, o San Checkout executa — nunca o contrário.

```
POST {base_do_checkout}/estornar
Header: X-Checkout-Key: <sua chave>
Body: { "pedidoId": "abc123" }
```

- **Sempre tudo ou nada** — não existe estorno parcial de um item
  dentro de um pedido com vários itens. Se precisar cancelar só parte,
  cancele o pedido inteiro e crie um novo com o que sobrou.
- Depois do estorno bem-sucedido, você recebe um webhook de
  confirmação (seção 4) com `status: "estornado"`.

**Exceção — Boleto não é instantâneo.** Pix e Cartão estornam numa
chamada só. Boleto **não**: a Asaas devolve um `requestUrl` que o
**pagador** precisa preencher (dados bancários + documentos) antes do
dinheiro voltar de verdade. Isso significa que, pra pedido pago por
boleto, você recebe primeiro `status: "estorno_solicitado"` (não
`"estornado"` ainda) — o webhook com `status: "estornado"` só chega
depois, quando o pagador concluir o processo dele. Trate isso como um
estado intermediário real, não como erro.

---

## 8. Taxas e split — como o valor cobrado é calculado

```
taxaAsaas   = tabela por MÉTODO de pagamento, taxa real (não
              promocional — promoções expiram sozinhas):

  Pix ................... R$1,99 fixo
  Boleto ................. R$1,99 fixo
  Cartão de Débito ....... R$0,35 + 1,89%
  Cartão Crédito à vista . R$0,49 + 2,99%
  Cartão Crédito 2-6x .... R$0,49 + 3,49%
  Cartão Crédito 7-12x ... R$0,49 + 3,99%

taxaPropria = percentual + valor fixo ÚNICO do San Checkout, igual
              pra qualquer método — não varia por Pix/Cartão/Boleto

SE pedido.isentarTaxa = true:
    taxasTotais  = taxaDoProjeto
SENÃO (padrão — não existe toggle fixo por contratante, só por pedido):
    taxasTotais  = taxaDoProjeto + taxaAsaas + taxaPropria

valorCobrado = valorComDesconto + frete + taxasTotais
```

A taxa do San Checkout é **somada por cima**, nunca descontada do que
você configurou — você sempre recebe `valorComDesconto + frete`
integral (via split, se tiver `wallet_id` configurado; direto na sua
conta, se não tiver).

**Isenção pontual (`isentarTaxa`):** é você, projeto, quem decide, pedido
a pedido, se uma venda específica fica sem taxa do checkout (ex.:
campanha "taxa zero" por tempo limitado). Não existe configuração fixa
de "este contratante nunca paga taxa" — a flexibilidade é só por pedido.

`TAXA_PERCENTUAL`/`TAXA_FIXA` (o que compõe `taxaPropria`) são globais
do San Checkout — combine o valor vigente com quem administra.

---

## 9. Resumo rápido pra quem só quer o checklist

- [ ] Expor `GET /pedido/{pedidoId}`, autenticado por `X-Checkout-Key`, respondendo em até 45s
- [ ] Expor `POST` num `webhook_url` que responde 200 rápido
- [ ] Gerar `pedidoId` únicos, controlar `status` (pendente/pago/cancelado) do seu lado
- [ ] Se tiver reserva com expiração (ex.: ingresso), preencher `expiraEm`
- [ ] Combinar manualmente: `contratante_id`, URL da sua API, sua chave, `webhook_url`, `wallet_id` (se for usar split)
- [ ] Se quiser poupar o pagador de redigitar, mande `pagador.telefone` também (novo campo — Cartão de Crédito passou a exigir telefone)
- [ ] Nunca esperar que preço/desconto/nome de produto cheguem pela URL do link — tudo vem da sua própria API
- [ ] Emitir sua própria nota fiscal e mandar seu próprio e-mail de confirmação ao pagador quando o `status`/`evento` de confirmação chegar — o San Checkout não faz mais isso
