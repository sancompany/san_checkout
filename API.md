# San Checkout — Documentação da API

**SAN & CO. Pay Engine** — referência completa de integração.
Versão do contrato: **1** · Atualizado em 16/09/2026 (correção de segurança em `&renovar=`, ver seção 7.3)

> Este é o documento **de fronteira**: tudo que atravessa a linha entre o
> San Checkout e o seu projeto. Um desenvolvedor que nunca viu este
> sistema deve conseguir integrar do zero lendo só este arquivo.
>
> Não descreve a arquitetura interna do checkout (banco, serviços,
> controllers) — nada disso é contrato e pode mudar sem aviso.

> ### ⚠️ Este arquivo é a fonte única. Não integre a partir de cópia.
> Integre lendo **este `API.md`, na versão do repositório do San
> Checkout** — nunca um resumo herdado de outro projeto nem uma cópia
> local. Contrato paráfraseado envelhece calado: em 14/09/2026 um
> integrador construiu contra um resumo herdado e implementou coisas que
> este contrato nunca descreveu. Todo payload carrega `versao` (hoje
> `1`); se a sua cópia não fala de `versao`, ela não é este contrato.
>
> ### Implementação de referência — leia o código, não só a prosa
> Existe um **contratante de teste** completo, versionado e no ar, que
> exercita este contrato inteiro: repositório
> [`sancompany/contratante-teste`](https://github.com/sancompany/contratante-teste).
> Ele mostra a ordem real das chamadas, o formato do corpo e **como a
> assinatura do webhook é conferida na prática** (a seção 4.3.1 abaixo).
> Quando a prosa e o código divergirem na sua cabeça, o código dele é o
> desempate.

---

## Índice

1. [Como funciona — o modelo pull](#1-como-funciona--o-modelo-pull)
2. [Antes de começar — o que é combinado manualmente](#2-antes-de-começar--o-que-é-combinado-manualmente)
   - 2.0 [Quem opera o checkout hoje](#20-quem-opera-o-checkout-hoje)
   - 2.1 [Os dois endereços do checkout](#21-os-dois-endereços-do-checkout)
3. [Links de checkout](#3-links-de-checkout)
   - 3.1 [`returnUrl` — o caminho de volta para a sua loja](#31-returnurl--o-caminho-de-volta-para-a-sua-loja)
4. [O que o SEU projeto precisa expor](#4-o-que-o-seu-projeto-precisa-expor)
   - 4.1 [`GET /pedido/{pedidoId}`](#41-get-pedidopedidoid)
   - 4.2 [`GET /plano/{planoId}`](#42-get-planoplanoid)
   - 4.3 [`POST {webhook_url}` — receber as notificações](#43-post-webhook_url--receber-as-notificações)
5. [A API que VOCÊ chama](#5-a-api-que-você-chama)
   - 5.1 [Convenções gerais](#51-convenções-gerais)
   - 5.2 [Consultar uma cobrança (conciliação)](#52-consultar-uma-cobrança-conciliação)
   - 5.3 [Conciliar uma assinatura](#53-conciliar-uma-assinatura)
   - 5.4 [Estornar](#54-estornar)
   - 5.5 [Cancelar, pausar e retomar assinatura](#55-cancelar-pausar-e-retomar-assinatura)
   - 5.6 [Trocar de plano (upgrade e downgrade)](#56-trocar-de-plano-upgrade-e-downgrade)
   - 5.7 [Página pública de status do comprador](#57-página-pública-de-status-do-comprador)
   - 5.8 [Saúde do serviço](#58-saúde-do-serviço)
6. [Métodos de pagamento](#6-métodos-de-pagamento)
7. [Assinaturas em detalhe](#7-assinaturas-em-detalhe)
   - 7.1 [Ciclos aceitos](#71-ciclos-aceitos)
   - 7.2 [Assinatura por Pix Automático](#72-assinatura-por-pix-automático)
   - 7.3 [Renovação — cartão vencido ou troca de cartão](#73-renovação--cartão-vencido-ou-troca-de-cartão)
   - 7.4 [Ciclo de vida completo](#74-ciclo-de-vida-completo)
   - 7.5 [Mudar o preço de quem já assinou](#75-mudar-o-preço-de-quem-já-assinou--o-que-dá-o-que-não-dá-e-o-que-o-checkout-não-faz)
   - 7.6 [O que a assinatura NÃO faz — leia antes de prometer benefício](#76-o-que-a-assinatura-não-faz--leia-antes-de-prometer-benefício)
8. [Taxas, split e o valor cobrado](#8-taxas-split-e-o-valor-cobrado)
9. [Limites e validações do sistema](#9-limites-e-validações-do-sistema)
   - 9.0 [A resposta da sua API: redirecionamento e tamanho](#90-a-resposta-da-sua-api-redirecionamento-e-tamanho)
   - 9.1 [O piso de R$ 5,00](#91-o-piso-de-r-500--e-por-que-ele-não-é-o-mesmo-que-o-valor-do-pedido)
   - 9.2 [O que o telefone precisa ter](#92-o-que-o-telefone-precisa-ter)
10. [Compatibilidade e versionamento](#10-compatibilidade-e-versionamento)
11. [Checklist de integração](#11-checklist-de-integração)
    - 11.1 [A troca de sandbox para produção — o que NÃO atravessa](#111-a-troca-de-sandbox-para-produção--o-que-não-atravessa)
12. [Referência rápida](#12-referência-rápida)

---

## 1. Como funciona — o modelo pull

O San Checkout **não guarda catálogo**. Ele não sabe o que você vende,
por quanto, nem para quem — e isso é proposital: você continua dono dos
seus dados, e nada de valor trafega por onde o comprador possa mexer.

```
  SEU PROJETO                   SAN CHECKOUT                    ASAAS
      │                              │                            │
 (1)  │ cria o pedido no seu banco   │                            │
      │                              │                            │
 (2)  │ manda o comprador pro link ─►│                            │
      │                              │                            │
 (3)  │◄── GET /pedido/{id} ─────────│  "o que é esse pedido?"    │
      │    X-Checkout-Key            │                            │
      │                              │                            │
 (4)  │ ─── itens, valores ─────────►│                            │
      │                              │                            │
 (5)  │                              │ cobra o valor que RECEBEU ►│
      │                              │                            │
 (6)  │                              │◄── webhook de pagamento ───│
      │                              │                            │
 (7)  │◄── POST {webhook_url} ───────│  assinado (HMAC)           │
      │    "status: confirmado"      │                            │
      │                              │                            │
 (8)  │ libera o pedido, emite NF,   │                            │
      │ avisa o cliente              │                            │
```

Três consequências que valem entender antes de escrever qualquer linha:

- **O valor cobrado vem sempre da sua API**, nunca da URL nem do
  navegador. Se alguém adulterar o link, não muda nada.
- **Seu endpoint de pedido é consultado mais de uma vez** — quando a
  tela abre e de novo no instante de cobrar. Ele precisa responder a
  mesma coisa nas duas vezes (ou refletir uma mudança real: um pedido
  que virou `pago` no intervalo faz o checkout recusar a cobrança).
- **A notificação é a via rápida, não a única.** Existe consulta de
  conciliação (seção 5.2) para quando o webhook se perder.

---

## 2. Antes de começar — o que é combinado manualmente

Nada disso é autoatendimento: são dados sensíveis, cadastrados por quem
administra o San Checkout, no painel `/admin.html`.

| Dado | Para que serve |
|---|---|
| `contratante_id` | O valor que vai no `?c=` do link |
| URL base da sua API | Para onde o checkout liga (seções 4.1 e 4.2) |
| `X-Checkout-Key` | Sua chave. Autentica as chamadas **nas duas direções**: o checkout a envia ao consultar você, e você a envia ao chamar a API dele. É também o segredo que assina os webhooks |
| `webhook_url` | Para onde as notificações são enviadas (seção 4.3) |
| `wallet_id` da Asaas | Opcional — se informado, sua parte do dinheiro é separada por split automaticamente |
| Métodos habilitados | Quais formas de pagamento aparecem para os seus compradores (seção 6.4) |

> **A `X-Checkout-Key` é um segredo de servidor.** Nunca a coloque em
> código de front-end, em variável de build de site estático, nem em
> repositório público. Quem tem a chave pode consultar e **estornar**
> cobranças suas, e forjar webhooks assinados.

Para trocar qualquer um desses dados, fale com quem administra o
checkout. A URL base da sua API e o `webhook_url` podem ser alterados
sem quebrar nada; o `contratante_id` e a chave, não — os links já
distribuídos param de funcionar.

### 2.0 Quem opera o checkout hoje

O San Checkout é operado por **Bruno Henrique Sanches**, sob o nome
comercial **SAN & CO.**, como **pessoa física** — e não como pessoa
jurídica. A identificação completa (nome, CPF e endereço) está nos
Termos de Uso e na Política de Privacidade, e é o Decreto 7.962/2013,
art. 2º, que pede a inscrição no CPF **ou** no CNPJ.

**Operação em transição para pessoa jurídica.** Três coisas dependem
disso, e valem ser sabidas antes de integrar:

- **Não há `split`** enquanto a conta da Asaas for de pessoa física
  (conta PF não cria subconta). O valor que lhe cabe passa pela conta do
  operador e o repasse é manual — ver a seção 8.
- **A nota fiscal do serviço tecnológico** sai na inscrição vigente do
  operador. A nota do **seu** produto continua sendo sua, sempre (seção
  4.3 e Termos §15.1.1).
- Quando a conversão concluir, os documentos legais mudam de versão e o
  `split` passa a valer. **Nada no contrato desta API muda por causa
  disso** — nem endpoint, nem payload, nem status.

### 2.1 Os dois endereços do checkout

O checkout mora em dois endereços, e eles fazem coisas diferentes. Onde
este documento escreve `{CHECKOUT}`, leia o primeiro.

| Papel | Endereço | Quem acessa |
|---|---|---|
| **Tela de pagamento** (`{CHECKOUT}`) | `checkout.sancocore.com.br` | O seu comprador, pelo navegador — é o domínio dos links da seção 3 |
| **API** | `api.sancocore.com.br` | O seu servidor, pelas rotas da seção 5 |

Os dois são HTTPS e não têm versão no caminho (o versionamento é por
campo `versao` no payload, seção 10).

> **Nunca monte esses endereços na mão dentro do seu código.** Guarde
> cada um em variável de ambiente. Se um dia o checkout mudar de
> endereço, você troca uma variável em vez de caçar string em arquivo —
> e foi exatamente uma troca dessas que deixou este documento apontando
> para um host desativado até 14/09/2026.

---

## 3. Links de checkout

Existem três links. Todos apontam para o domínio do checkout e carregam
apenas **referências opacas** — nunca preço, nome de produto ou dado
pessoal.

### Pagamento avulso

```
https://{CHECKOUT}/index.html?c={contratante_id}&pedido={pedidoId}
```

### Assinatura

```
https://{CHECKOUT}/index.html?c={contratante_id}&assinatura={planoId}
```

### Renovação de assinatura (trocar o cartão)

```
https://{CHECKOUT}/index.html?c={contratante_id}&assinatura={planoId}&renovar={token}
```

`{token}` é gerado por você — nunca o literal `1`. Ver seção 7.3.

| Parâmetro | Obrigatório | Descrição |
|---|---|---|
| `c` | sim | Seu `contratante_id` |
| `pedido` | sim (avulso) | O id do pedido **no seu sistema** — o checkout nunca gera esse id |
| `assinatura` | sim (recorrência) | O id do plano **no seu sistema** |
| `renovar` | não | O token de renovação (seção 7.3) — **nunca** o literal `1`. Sem ele (ou com um valor que não confere), o link cria uma assinatura nova comum, sem trocar nem cancelar nenhuma outra |
| `returnUrl` | não | Para onde mandar o comprador **depois de pagar** (seção 3.1) |

Nenhum outro parâmetro é lido. Qualquer coisa a mais na URL é ignorada.

### 3.1 `returnUrl` — o caminho de volta para a sua loja

Sem ele, quem paga fica parado na tela do checkout: a mensagem vira
"Pagamento confirmado! Obrigado.", e acabou. Não há botão nem link de
volta, e a pessoa fecha a aba na mão. Com ele, assim que o pagamento
**confirma**, aparece um botão "Voltar para {sua loja}" e uma contagem
de 10 s que leva sozinha — cancelável com qualquer clique, tecla ou
rolagem, para não arrancar da tela quem ainda está lendo.

```
https://{CHECKOUT}/index.html?c=minha-loja&pedido=a1b2c3&returnUrl=https%3A%2F%2Fwww.minhaloja.com.br%2Fobrigado
```

**Codifique o valor** (`encodeURIComponent`), senão a query dele se
mistura com a do checkout.

#### O destino precisa ser seu — e isso é conferido

O checkout só honra `returnUrl` se a **origem** (`esquema + host +
porta`) estiver autorizada para o seu `contratante_id`:

- a origem do seu `apiBaseUrl` vale **sempre**, sem cadastrar nada;
- outras origens — o caso comum é a API em `api.sualoja.com.br` e a
  vitrine em `www.sualoja.com.br` — entram em `retornoDominios`, que o
  operador cadastra no painel (peça, informando as origens).

Fora disso, o `returnUrl` é **ignorado em silêncio**: o pagamento
acontece normalmente, só não aparece o botão de voltar. Nenhum erro é
devolvido, e nenhuma cobrança deixa de funcionar por causa disso.

> **Por que tanto rigor num parâmetro de navegação.** `returnUrl` vem
> da barra de endereço — de quem montou o link, que não é
> necessariamente você. Um checkout que redireciona para qualquer
> endereço vira *open redirect*: o golpista manda
> `…checkout.sancocore.com.br/?c=…&returnUrl=https://golpe.tld`, a
> vítima (e o filtro de spam dela) lê o domínio confiável na frente, e
> quem recebe é outro site. A comparação é por origem exata, com o
> caminho ignorado — cadastrar `https://sualoja.com.br/obrigado`
> autoriza a origem `https://sualoja.com.br` inteira.

#### O que vem junto na volta — e o que NUNCA vem

O checkout acrescenta **um** parâmetro ao seu destino:

| Parâmetro | Valor |
|---|---|
| `pedido` | o mesmo `pedidoId` que você pôs no link |

Se a sua `returnUrl` já usar um parâmetro chamado `pedido`, ele é
sobrescrito. Assinatura não recebe nada (não há `pedidoId`).

> ### ⛔ A volta NÃO prova que foi pago
>
> O checkout **nunca** manda status na URL de retorno, de propósito, e
> você não deve inventar um. Query string é escrita por qualquer um:
> quem digitar `?pedido=X&status=pago` na barra de endereço receberia o
> produto sem pagar.
>
> Quem diz que foi pago continua sendo, e só: o **webhook assinado**
> (seção 4.3) ou a **consulta autenticada** (seção 5.2). Trate a volta
> como "o comprador voltou", nunca como "o comprador pagou" — a página
> de destino deve consultar o seu próprio banco, alimentado pelo
> webhook.

### ⚠️ O id precisa ser imprevisível — isto é obrigatório

Use **UUID, hash ou outro identificador que ninguém consiga adivinhar**.
Nunca o id sequencial da sua tabela.

**Por quê:** a rota que carrega o pedido é pública por necessidade — o
comprador precisa dela antes de existir qualquer login. Com id
sequencial, qualquer pessoa varre `?pedido=1`, `?pedido=2`, `?pedido=3`
e lê valor, itens e os dados do pagador pré-preenchidos de **todos os
pedidos do seu projeto**. Com id imprevisível, não há o que varrer.

O checkout **recusa** (HTTP 400) um `pedido` ou `assinatura` formado só
por dígitos com **menos de 8 caracteres**.

```
✅  550e8400-e29b-41d4-a716-446655440000
✅  PED-9f2c1a44b3e
✅  1789023226000          (timestamp — 13 dígitos, passa)
❌  1
❌  4271
```

Se o id no seu banco é sequencial, não precisa trocar o banco: gere um
token opaco por pedido (uma coluna a mais) e use só ele no link.

---

## 4. O que o SEU projeto precisa expor

Duas rotas `GET` (só a que corresponder aos métodos que você usa) e uma
rota `POST` para receber notificações.

Toda chamada que o checkout faz até você leva o header:

```
X-Checkout-Key: {sua chave}
```

**Confira essa chave e recuse 401 se não bater.** Sem isso, seu endpoint
de pedido é público para a internet inteira.

### 4.1 `GET /pedido/{pedidoId}`

```http
GET {sua_base_url}/pedido/{pedidoId}
X-Checkout-Key: {sua chave}
```

Prazo de resposta: **45 segundos**. Não é arbitrário — é calibrado para
o pior cold start de hospedagem gratuita (Render e similares levam 30-50s
para "acordar"). Passou disso, o comprador vê erro.

**Resposta 200:**

```json
{
  "pedidoId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pendente",
  "itens": [
    { "nome": "Ingresso Pista — Lote 1", "quantidade": 2, "valorUnitario": 80.00 },
    { "nome": "Ingresso VIP — Lote 2",   "quantidade": 2, "valorUnitario": 150.00 }
  ],
  "valorCheio": 460.00,
  "desconto": 20.00,
  "cupom": "LOTE1PROMO",
  "valorComDesconto": 440.00,
  "frete": 0,
  "taxaDoProjeto": 0,
  "isentarTaxa": false,
  "descricao": "Trimundi9 — Lote 1",
  "contratanteLogoUrl": "https://seu-projeto.com/logo.png",
  "bannerUrl": "https://seu-projeto.com/banner.png",
  "pagador": {
    "nome": "Maria Silva",
    "email": "maria@exemplo.com",
    "documento": "11144477735",
    "telefone": "47988887777"
  },
  "expiraEm": "2026-10-01T23:29:59Z"
}
```

| Campo | Tipo | Obrig. | Observação |
|---|---|:--:|---|
| `pedidoId` | string | sim | Deve bater com o `?pedido=` do link |
| `status` | string | sim | Ver 4.1.1 |
| `itens` | array | sim | **Só exibição.** O checkout não soma nada — você manda o total pronto |
| `itens[].nome` | string | sim | |
| `itens[].quantidade` | number | sim | |
| `itens[].valorUnitario` | number | sim | Em reais com centavos (`80.00`, nunca `8000`) |
| `valorCheio` | number | sim | Antes de qualquer desconto |
| `desconto` | number | não (`0`) | |
| `cupom` | string \| null | não | Só referência — o checkout não valida cupom |
| `valorComDesconto` | number | sim | `valorCheio - desconto`. **É a base da cobrança** |
| `frete` | number | não (`0`) | Somado à base |
| `taxaDoProjeto` | number | não (`0`) | Taxa do SEU projeto, se houver. Repassada de volta no webhook |
| `isentarTaxa` | boolean | não (`false`) | `true` = esta venda não paga a taxa do checkout (seção 8) |
| `descricao` | string | sim | Aparece no resumo e vai como descrição da cobrança na Asaas |
| `contratanteLogoUrl` | string (URL) | não | Sua logo, ao lado da do San Checkout no cabeçalho |
| `bannerUrl` | string (URL) | não | Imagem retangular entre o cabeçalho e o resumo. Sem o campo, o espaço não existe |
| `pagador` | object | não | Pré-preenche a tela. A pessoa ainda pode editar |
| `pagador.nome` | string | não | |
| `pagador.email` | string | não | |
| `pagador.documento` | string | não | CPF (11 dígitos) ou CNPJ (14) — detectado pelo tamanho |
| `pagador.telefone` | string | não | 10 ou 11 dígitos. Cartão e assinatura **exigem** telefone; mandando aqui, o comprador não redigita |
| `expiraEm` | string ISO 8601 | não | Prazo real da reserva. Ver 4.1.2 |

Campos desconhecidos que você mandar são ignorados sem erro — pode
reaproveitar um objeto interno seu, desde que os nomes acima estejam lá.

#### 4.1.1 O campo `status`

Isto é proteção contra cobrança duplicada, não metadado.

| Valor | Efeito no checkout |
|---|---|
| `pago` | **Recusa cobrar** (409). É o que protege quem recarregou a página ou abriu duas abas |
| `cancelado` | **Recusa cobrar** (409) |
| qualquer outro (`pendente`, …) | Segue normalmente |

Mantenha esse campo atualizado do seu lado assim que o webhook de
confirmação chegar — é a sua segunda camada contra pagamento em
duplicidade.

#### 4.1.2 O campo `expiraEm`

Existe para reserva com prazo: ingresso, vaga, slot de agenda.

- Se a data já passou, o checkout **recusa cobrar** (409), mesmo que o
  `status` ainda diga `pendente`.
- Enquanto não passou, a tela mostra um **cronômetro regressivo** para o
  comprador, e some com o botão quando zera.
- **Boleto fica indisponível** em pedido com `expiraEm` — boleto leva até
  3 dias úteis para compensar, e reservar por prazo curto algo que só
  confirma depois é contradição. O checkout recusa (400) mesmo se a
  chamada vier direto na API.

Se o seu produto não tem prazo, simplesmente omita o campo.

#### 4.1.3 Erros que o seu endpoint deve devolver

| Situação | Você responde | O comprador vê |
|---|---|---|
| Pedido não existe | `404` | "Pedido não encontrado" |
| Pedido cancelado por você | `200` com `status: "cancelado"` | "Este pedido já está com status cancelado" |
| Erro interno seu | `5xx` | "Não foi possível carregar os dados do pedido, tente novamente" |
| Sem resposta em 45s | (timeout nosso) | Mesma mensagem acima |

O checkout **não tenta de novo automaticamente**: a pessoa vê o erro e
pode recarregar a página, o que gera nova tentativa.

---

### 4.2 `GET /plano/{planoId}`

Só necessário se você vende assinatura. Mesma autenticação, mesmo prazo
de 45s.

```http
GET {sua_base_url}/plano/{planoId}
X-Checkout-Key: {sua chave}
```

**Resposta 200:**

```json
{
  "planoId": "plano-vitrina-9f2c",
  "nome": "Plano Mensal",
  "descricao": "Acesso completo, cobrança mensal",
  "valor": 49.90,
  "ciclo": "MONTHLY",
  "contratanteLogoUrl": "https://seu-projeto.com/logo.png",
  "bannerUrl": "https://seu-projeto.com/banner.png",
  "pagador": { "nome": "...", "email": "...", "documento": "...", "telefone": "..." }
}
```

| Campo | Tipo | Obrig. | Observação |
|---|---|:--:|---|
| `planoId` | string | sim | Deve bater com o `?assinatura=` |
| `nome` | string | sim | Vira o nome do item cobrado |
| `descricao` | string | não | |
| `valor` | number | sim | Valor de **cada ciclo**, em reais |
| `ciclo` | string | sim | Um dos sete da tabela da seção 7.1 |
| `contratanteLogoUrl` | string | não | Igual ao pedido |
| `bannerUrl` | string | não | Igual ao pedido |
| `pagador` | object | não | Igual ao pedido |

O checkout acrescenta à resposta um objeto `_checkout` (com os métodos
habilitados para você) antes de entregar ao front. O prefixo `_` existe
para nunca colidir com um campo seu — **não use esse nome** nos seus
próprios dados.

> **`planoId` não precisa ser um id de catálogo.** Pode ser um
> identificador único por assinante — é assim que a Vitrina ADS usa, com
> valor e prefill específicos por anunciante. O checkout não impõe
> formato; só chama `GET /plano/{o que vier}`.

> **`valor` e `ciclo` são congelados NO CHECKOUT, e isso não é limite do
> provedor.** Os ciclos seguintes cobram o que foi combinado no momento
> da assinatura — o checkout **não reconsulta** `/plano/{id}` a cada
> cobrança. Mudar o que um assinante paga é um ato explícito: **trocar de
> plano** (seção 5.6), que relê o plano de destino na hora.
>
> Este parágrafo já esteve errado duas vezes no mesmo dia, e as duas
> correções ficam registradas porque a diferença entre elas é a lição.
> Primeiro ele dizia que o congelamento vinha da **Asaas** — falso,
> medido no sandbox em 17/09/2026: ela aceita `PUT /v3/subscriptions/{id}`
> alterando `value` e `cycle`, e com `updatePendingPayments: true` altera
> até a cobrança pendente já gerada. Corrigido, ele passou a dizer que
> **não existia rota nossa** — verdade naquela hora, e falso no fim do
> mesmo dia, quando o dono autorizou construí-la. "Não existe rota
> nossa" e "o provedor não permite" são afirmações diferentes, e só uma
> delas eu podia ter feito sem medir
> (`docs/erros/2026-09-17-declarei-limite-do-provedor-sem-ter-medido.md`).

---

### 4.3 `POST {webhook_url}` — receber as notificações

```http
POST {seu_webhook_url}
Content-Type: application/json
X-Checkout-Signature: sha256={hmac hex do corpo}
X-Checkout-Timestamp: {epoch em segundos}
```

Responda **200 rápido**. Não precisa processar antes: responda 200 e
processe depois.

#### 4.3.1 ⚠️ Verifique a assinatura — passo obrigatório

Sem isso, qualquer pessoa que descubra a URL do seu webhook manda um
POST dizendo `"status": "confirmado"` e o seu sistema libera o pedido
**sem ninguém ter pagado**. A URL sozinha não prova nada; quem prova é a
assinatura.

Todo webhook é assinado com a **mesma `X-Checkout-Key`** que você já usa.
Essa é a **única** autenticação do webhook: não existe `X-Webhook-Secret`
nem nenhum header de segredo compartilhado. Se você viu no código-fonte
do checkout uma checagem de token em header (`asaas-access-token`), aquilo
é como **o checkout recebe da Asaas**, não como você verifica o webhook
que vem do checkout — não copie esse padrão para cá.

1. Recuse se `X-Checkout-Timestamp` estiver a mais de **300 segundos** de
   agora — impede que alguém capture uma requisição legítima e a reenvie
   depois.
2. Monte a string `"{timestamp}.{corpo cru}"` — o corpo **exatamente como
   chegou**. Não reserialize o JSON: a ordem das chaves muda e a
   assinatura não fecha.
3. Calcule `HMAC-SHA256` dessa string com a sua chave como segredo.
4. Compare com `X-Checkout-Signature` em **tempo constante**
   (`timingSafeEqual`, `hash_equals`), nunca com `==`.

**Node.js / Express**

```js
import crypto from 'node:crypto';

// IMPORTANTE: precisa do corpo CRU, não do JSON já parseado
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const assinatura = req.get('X-Checkout-Signature') ?? '';
  const timestamp  = req.get('X-Checkout-Timestamp') ?? '';
  const corpoCru   = req.body.toString('utf8');

  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) {
    return res.status(401).send('timestamp fora da janela');
  }

  const esperada = 'sha256=' + crypto
    .createHmac('sha256', SUA_CHECKOUT_KEY)
    .update(`${timestamp}.${corpoCru}`)
    .digest('hex');

  const a = Buffer.from(esperada);
  const b = Buffer.from(assinatura);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).send('assinatura inválida');
  }

  const evento = JSON.parse(corpoCru);
  res.status(200).json({ ok: true });   // responda antes de processar
  // ... processa o evento aqui
});
```

**PHP**

```php
$corpoCru   = file_get_contents('php://input');
$assinatura = $_SERVER['HTTP_X_CHECKOUT_SIGNATURE'] ?? '';
$timestamp  = $_SERVER['HTTP_X_CHECKOUT_TIMESTAMP'] ?? '';

if (abs(time() - (int)$timestamp) > 300) {
    http_response_code(401); exit('timestamp fora da janela');
}

$esperada = 'sha256=' . hash_hmac('sha256', "$timestamp.$corpoCru", SUA_CHECKOUT_KEY);

if (!hash_equals($esperada, $assinatura)) {
    http_response_code(401); exit('assinatura inválida');
}

$evento = json_decode($corpoCru, true);
http_response_code(200);
```

**Python / Flask**

```python
import hmac, hashlib, time
from flask import request, abort

@app.post('/webhook')
def webhook():
    corpo_cru = request.get_data()                      # bytes, cru
    assinatura = request.headers.get('X-Checkout-Signature', '')
    timestamp = request.headers.get('X-Checkout-Timestamp', '0')

    if abs(int(time.time()) - int(timestamp)) > 300:
        abort(401)

    esperada = 'sha256=' + hmac.new(
        SUA_CHECKOUT_KEY.encode(),
        f'{timestamp}.'.encode() + corpo_cru,
        hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(esperada, assinatura):
        abort(401)

    evento = request.get_json()
    return '', 200
```

#### 4.3.2 Dois formatos no mesmo endpoint

O mesmo `webhook_url` recebe notificação de **pedido avulso** e de
**assinatura**. Diferencie pelo campo `tipo`:

```js
if (evento.tipo === 'assinatura') { /* seção 4.3.4 */ }
else                              { /* seção 4.3.3 — pedido avulso */ }
```

O payload de pedido **não tem** o campo `tipo`.

#### 4.3.3 Payload de pedido avulso

```json
{
  "versao": 1,
  "pedidoId": "550e8400-e29b-41d4-a716-446655440000",
  "chargeId": "pay_8392017465",
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

| Campo | Descrição |
|---|---|
| `versao` | Versão do contrato. Hoje sempre `1` (seção 10) |
| `pedidoId` | O mesmo id que você mandou no link |
| `chargeId` | Id da cobrança na Asaas. Pode ser `null` em alguns eventos de pop-up |
| `status` | Ver a tabela abaixo |
| `valorCheio` … `taxaDoProjeto` | Exatamente o que a sua API devolveu — repassado de volta para conciliar |
| `taxaAsaas` | Custo real da Asaas naquele método |
| `taxaPropria` | Margem do San Checkout |
| `taxaIsenta` | `true` se você mandou `isentarTaxa` |
| `taxasTotais` | `taxaDoProjeto + taxaAsaas + taxaPropria` |
| `metodoPagamento` | `pix`, `boleto`, `cartao_credito` |
| `valorCobrado` | O que o comprador efetivamente pagou |

**Vocabulário de `status`** — chega em toda mudança, não só na confirmação:

| `status` | Quando chega | O que fazer |
|---|---|---|
| `confirmado` | O dinheiro caiu | **Libere o pedido.** Gatilho para nota fiscal e e-mail ao comprador |
| `em_analise` | Antifraude da Asaas segurou para revisão | **Não libere ainda**, e não trate como falha — vem `confirmado` ou `recusado` depois |
| `recusado` | Antifraude reprovou, ou a captura do cartão falhou | Não será pago. Pode devolver o estoque/vaga |
| `vencido` | Passou do vencimento sem pagar (boleto) | Idem |
| `chargeback` | O portador contestou a compra no banco | **Suspenda a entrega/acesso.** A disputa corre fora do checkout |
| `estornado` | Estorno concluído | Reverta o pedido do seu lado |
| `estorno_solicitado` | Só boleto — estorno iniciado, aguardando o pagador (seção 5.4) | Aguarde o `estornado` |
| `estorno_negado` | A Asaas recusou o estorno | O pagamento continua válido |
| `pendente` | Uma baixa manual foi desfeita na Asaas | Trate como não pago de novo |

> **Status desconhecido = ignore por enquanto**, nunca erro. Responda 200
> do mesmo jeito. Novos status podem ser adicionados (seção 10).

> **Nota fiscal e e-mail de confirmação são responsabilidade sua.** O San
> Checkout processa o pagamento e avisa; ele não emite nota nem manda
> e-mail ao comprador — inclusive a Asaas foi configurada para **não**
> notificar o cliente final em nome dela.

#### 4.3.4 Payload de assinatura

```json
{
  "versao": 1,
  "tipo": "assinatura",
  "planoId": "plano-vitrina-9f2c",
  "documento": "11144477735",
  "evento": "cobranca_confirmada"
}
```

| `evento` | Quando chega |
|---|---|
| `criada` | Assinatura criada e **primeira cobrança paga** |
| `cobranca_confirmada` | Um ciclo foi cobrado com sucesso |
| `cobranca_falhou` | Um ciclo não entrou — cartão recusado ou cobrança vencida. **Mande o link de renovação** (seção 7.3) |
| `cobranca_estornada` | Um ciclo foi estornado |
| `cobranca_contestada` | Chargeback num ciclo — **suspenda o acesso** |
| `plano_trocado` | O assinante passou para outro plano (seção 5.6) |
| `cancelada` | Assinatura encerrada |

O par `planoId` + `documento` é a chave: é por ele que você localiza o
assinante do seu lado, e é ele que você manda ao cancelar, pausar ou
retomar.

> **O `documento` chega SEMPRE em dígitos**, sem ponto, barra ou traço —
> `11144477735`, nunca `111.444.777-35`. Vale desde 17/09/2026 e é o
> mesmo formato nas duas direções: você pode mandar pontuado nas rotas
> de §5.5 (o checkout normaliza), e o que sai daqui é sempre dígitos.
> **Se você compara esse campo com um valor guardado do seu lado, tire a
> pontuação do seu antes de comparar** — é a única coisa que muda para
> quem já integra, e só muda para quem guarda o CPF pontuado.

> O payload de assinatura **não carrega valores** de propósito: o valor é
> o do plano que você já tem cadastrado. Se precisar do valor exato de um
> ciclo específico, ele está no painel da Asaas.
>
> **`plano_trocado` é a única exceção, e por necessidade:** nele o
> `planoId` que você conhece *acabou de mudar*, então o payload leva
> quatro campos a mais — `planoAnterior` (sem ele você não acha o
> próprio registro), `valor`, `ciclo` e `acertoCobrado`. Os três últimos
> existem porque **avisar o assinante da mudança de preço é obrigação
> sua** (RN-35), e um aviso sem o número novo não serve:
>
> ```json
> {
>   "versao": 1,
>   "tipo": "assinatura",
>   "planoId": "plano-vitrina-pro-3a81",
>   "planoAnterior": "plano-vitrina-9f2c",
>   "documento": "11144477735",
>   "evento": "plano_trocado",
>   "valor": 160.00,
>   "ciclo": "MONTHLY",
>   "acertoCobrado": 30.00
> }
> ```
>
> `acertoCobrado` vem `0` quando não houve cobrança (rebaixamento, ou
> acerto absorvido por ser menor que R$ 5,00).

> **Assinatura paga por Pix Automático usa exatamente estes mesmos
> eventos.** Para você é a mesma assinatura; muda só como o assinante
> pagou.

#### 4.3.5 Quando NÃO chega notificação

Nem todo desfecho gera webhook. Não espere um:

- **Pop-up de cartão fechada sem pagar** (`CHECKOUT_EXPIRED`): nada é
  enviado. O pedido continua pendente do seu lado, corretamente.
- **Pop-up cancelada** em pagamento avulso: nada é enviado. (Em
  assinatura NOVA, chega `cancelada` — mas não numa renovação, ver
  abaixo.)
- **Pop-up de renovação (`&renovar={token}`) fechada sem pagar**: nada é
  enviado. A assinatura ANTIGA continua intocada, ativa e sendo cobrada —
  ela só é cancelada depois que a NOVA confirmar (seção 7.3). Antes de
  16/09/2026 o checkout mandava `cancelada` mesmo sem a renovação ter
  sido concluída; como o payload identifica só por `planoId`+`documento`
  (seção 4.3.4), você não tinha como diferenciar isso de um cancelamento
  de verdade — corrigido (RN-20, `docs/funcional.md`).
- **Pix/boleto gerado e nunca pago**: só o `vencido`, quando vencer.

A ausência de notificação nunca significa "pago". Se precisa ter certeza
sobre um pedido específico, pergunte (seção 5.2).

#### 4.3.6 Política de novas tentativas

Se o seu endpoint não responder `200`, o checkout tenta de novo **3
vezes: 1 min, 5 min e 15 min** depois. Esgotadas, ele desiste e registra
no próprio log.

Duas consequências práticas:

- **A fila de retry é em memória.** Se o processo do checkout reiniciar
  entre as tentativas, aquela notificação se perde.
- **O pagamento continua confirmado do lado do checkout** — o dinheiro
  entrou. O que se perde é só o aviso.

Por isso a conciliação da seção 5.2 não é opcional para quem leva
dinheiro a sério: rode uma vez por dia sobre tudo que ainda está
"aguardando pagamento" do seu lado.

Webhook pode chegar **mais de uma vez** para o mesmo fato (uma tentativa
que na verdade chegou, mas cuja resposta se perdeu). Trate o
processamento como **idempotente** — e a chave natural **depende do
payload**:

| payload | chave de idempotência |
|---|---|
| **Pedido** (§4.3.2) | `chargeId` + `status` |
| **Assinatura** (§4.3.4) | `planoId` + `documento` + `evento` |

> ⚠️ **O payload de assinatura não tem `chargeId`, e isso é de
> propósito** (§4.3.4): a assinatura é identificada pelo par
> `planoId` + `documento`, e um ciclo, pelo `evento`. Até 15/09/2026
> esta seção dizia só "a chave é `chargeId` + `status`", sem ressalva —
> e um integrador que leu isto ao pé da letra recusou creditar uma
> assinatura paga, esperando um campo que nunca existiu naquele
> payload. Ele estava certo em recusar; o texto é que estava incompleto.
>
> **Não invente um `chargeId` para assinatura, e não espere um.** Se o
> seu código precisa de um identificador de cobrança individual para
> conciliar, ele está na seção 5.3.
>
> ⚠️ **`planoId` + `documento` + `evento` deduplica RETRY, não CICLO.**
> O `evento` é o mesmo texto (`cobranca_confirmada`, por exemplo) em
> TODO ciclo recorrente do mesmo assinante — não existe nada no payload
> que diferencie o pagamento de setembro do de outubro. Se o seu código
> trata "já processei este `evento` pra este assinante" como motivo pra
> ignorar a notificação, ele vai descartar o 2º, o 3º… ciclo como
> "duplicata" do 1º, e o contratante para de creditar cobranças reais em
> silêncio. A chave da tabela acima só serve pra não processar duas
> vezes a MESMA tentativa de notificação (o retry de §4.3.6); para saber
> se já processou um ciclo específico, use a sua própria consulta
> periódica (seção 5.3, campo `ultimaCobranca.criadoEm`) como fonte de
> verdade, não a deduplicação do webhook.

---

## 5. A API que VOCÊ chama

### 5.1 Convenções gerais

**Base:**

```
https://api.sancocore.com.br
```

É o endereço de API da seção 2.1 — não é o mesmo domínio da tela de
pagamento, e não é o endereço da hospedagem por baixo. Chame sempre o
domínio; o endereço interno do provedor muda sem aviso.

**Autenticação:** header `X-Checkout-Key` com a sua chave. Sem ela, `401`.

> **Chame sempre do seu servidor, nunca do navegador.** O CORS do
> checkout libera um único domínio (o do próprio checkout), então a
> chamada do browser falharia de qualquer forma — e mandar a chave ao
> browser seria entregá-la a quem abrir o DevTools.

**Formato:** JSON na entrada e na saída. Todo erro tem o mesmo corpo:

```json
{ "erro": "mensagem legível, em português" }
```

**Códigos:**

| Código | Significa |
|---|---|
| `200` | Deu certo |
| `400` | Dado inválido na sua requisição — a mensagem diz o quê |
| `401` | `X-Checkout-Key` ausente ou inválida |
| `403` | A chave é válida, mas não pertence ao recurso pedido |
| `404` | Não existe |
| `409` | Conflito de estado (pedido já pago, cancelado ou expirado) |
| `429` | Limite de requisições — ver abaixo |
| `502` / `504` | Falha ao falar com a Asaas ou com a **sua** API (504 = timeout) |

**Limite de requisições** (por IP, janela de 60 segundos):

| Rotas | Limite |
|---|---|
| Criação e ações de dinheiro (`/estornar`, `/cancelar-assinatura`, criação de cobrança) | **10/min** |
| Consultas (`/cobranca`, `/pedido`, `/plano`, `/status`) | **60/min** por rota |

Estourou, vem `429` com `{ "erro": "Muitas tentativas em pouco tempo. Aguarde um minuto." }`. Os headers padrão `RateLimit-*` acompanham a resposta.

**Moeda:** sempre BRL. Não existe parâmetro de moeda — se um dia isso
mudar, é uma versão nova deste contrato, não um campo opcional.

---

### 5.2 Consultar uma cobrança (conciliação)

```http
GET {BASE}/api/checkout/cobranca/{contratanteId}/{pedidoId}
X-Checkout-Key: {sua chave}
```

A resposta é **o mesmo formato do webhook de pedido** (seção 4.3.3), de
propósito: você reaproveita o parser que já escreveu. Traz dois campos a
mais, `criadoEm` e `chargeId`.

```json
{
  "versao": 1,
  "pedidoId": "550e8400-...",
  "chargeId": "pay_8392017465",
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
  "metodoPagamento": "pix",
  "valorCobrado": 449.30,
  "criadoEm": "2026-09-10T14:02:11.482Z"
}
```

| Código | Significa |
|---|---|
| `200` | Cobrança encontrada |
| `401` | Chave ausente ou inválida |
| `403` | A chave não pertence ao `contratanteId` da URL |
| `404` | Nenhuma cobrança foi gerada para esse pedido ainda (ninguém chegou a pagar) |

> Esta rota **reconsulta a Asaas** quando a cobrança ainda parece
> pendente e corrige o registro antes de responder — então ela enxerga
> pagamento que o webhook perdeu. Em caso de divergência, **o que ela
> responde é o correto.**

**Esta rota é só para pedido avulso.** A consulta é por `pedidoId`, e
cobrança de assinatura é gravada com `planoId` — para conciliar
recorrência, use a rota da seção 5.3.

---

### 5.3 Conciliar uma assinatura

A rota da seção 5.2 não alcança recorrência. Esta alcança:

```http
POST {BASE}/api/checkout/consultar-assinatura
X-Checkout-Key: {sua chave}
Content-Type: application/json

{ "planoId": "plano-vitrina-9f2c", "documento": "11144477735" }
```

Mesma autenticação e **mesmo body** de cancelar, pausar e retomar
(seção 5.5) — quem já chama aquelas três não precisa aprender nada novo.
É `POST` e não `GET` porque o CPF/CNPJ identifica o assinante, e
documento em caminho de URL vaza para log de acesso, histórico e referer.

**Resposta 200:**

```json
{
  "versao": 1,
  "tipo": "assinatura",
  "planoId": "plano-vitrina-9f2c",
  "documento": "11144477735",
  "assinaturaId": "sub_000123456789",
  "status": "ativa",
  "valor": 349.90,
  "divergenciaDeValor": null,
  "ciclo": "MONTHLY",
  "proximaCobranca": null,
  "ultimaCobranca": {
    "chargeId": "pay_8392017465",
    "status": "confirmado",
    "metodoPagamento": "assinatura",
    "valorCobrado": 349.90,
    "criadoEm": "2026-09-11T14:02:11.482Z"
  }
}
```

> **`proximaCobranca` deixou de ser sempre `null` em 16/09/2026.** Ele
> nasceu nulo porque nenhum *webhook* da Asaas carrega essa data (e a
> data que o checkout manda na criação é a de HOJE, já que a 1ª cobrança
> é imediata — não é projeção da próxima). A fonte certa não era webhook
> nenhum: é a consulta direta da assinatura na Asaas, que esta rota
> agora faz. Ainda pode vir `null` — quando a assinatura já encerrou, ou
> quando a Asaas não responde a tempo (a conciliação não falha por isso,
> cai pro que o banco sabe).
>
> **O `status` também é reconferido aqui, não só lido do banco.** Se uma
> chamada nossa de cancelar/pausar/retomar foi processada pela Asaas mas
> a confirmação se perdeu no caminho, é esta rota que percebe e corrige
> o registro — antes, a divergência ficava invisível para sempre. O mesmo
> vale para uma assinatura cancelada direto no painel da Asaas: como a
> Asaas não nos manda nenhum evento de assinatura (medido em 16/09:
> zero `SUBSCRIPTION_*` entre os 53 eventos configurados), **esta rota é
> o único caminho** pelo qual isso chega até você. É o argumento mais
> forte para o "rode uma vez por dia" da 5.3.
>
> **`ciclo` passou a ser reconferido junto, desde 16/09/2026.** Ele
> continua congelado **pelo nosso fluxo** (a Asaas aceitaria alterá-lo —
> seção 4.2) — o que mudou é de onde a resposta o lê:
> quem cobra é a Asaas, então se o nosso registro divergir do dela, o
> errado é o nosso, e esta rota corrige o registro. Isso existe por causa
> de um rastro real: as assinaturas criadas antes de 15/09/2026 foram
> gravadas como `MONTHLY` independentemente do plano (o código lia um
> campo de webhook que não existe). A correção na origem só valeu para as
> novas — **para as antigas, é esta rota que repara**. Se você guardou o
> `ciclo` do seu lado antes desta data, vale reconciliar.
>
> **`valor` passou a ser reconferido também, em 18/09/2026 — e agora
> vem com denúncia.** ⚠️ Este parágrafo dizia o contrário até aquele dia:
> que `valor` era o único campo da resposta que NÃO era reconferido, e
> que você não devia usá-lo como preço vigente. **Mudou**, por decisão do
> dono do checkout, e o motivo é simples: quem debita o cartão é a Asaas,
> então um número nosso diferente do dela não é uma opinião divergente —
> é informação falsa.
>
> O que a rota faz agora, quando acha diferença:
>
> 1. devolve em `valor` **o que a Asaas cobra**, não o nosso registro;
> 2. **corrige o nosso banco** na mesma chamada (senão a divergência
>    volta na conciliação seguinte);
> 3. e **conta para você** em `divergenciaDeValor`:
>
> ```json
> "divergenciaDeValor": { "nosso": 30.00, "asaas": 45.00 }
> ```
>
> Ele vem `null` na esmagadora maioria das chamadas — só aparece na
> conciliação em que a diferença foi encontrada e corrigida. **Trate-o
> como evento, não como estado:** é o seu aviso de que o preço daquele
> assinante mudou **fora do fluxo do checkout** (alguém no painel da
> Asaas, ou uma chamada direta de API). Você é quem fala com o
> assinante — quem precisa avisá-lo é você (RN-35).
>
> Corrigir e contar não são alternativas: sem a correção, o campo
> continuaria mentindo; sem a denúncia, o preço de alguém mudaria em
> silêncio. `ultimaCobranca.valorCobrado` continua sendo o histórico do
> que foi de fato cobrado, e continua útil — só deixou de ser a única
> coisa confiável aqui.

| Campo | Descrição |
|---|---|
| `assinaturaId` | Id na Asaas. `null` se a primeira cobrança ainda não confirmou |
| `status` | `ativa`, `pausada` ou `cancelada`. `null` enquanto não existe assinatura |
| `valor` | Congelado na criação (seção 4.2) |
| `divergenciaDeValor` | `{ nosso, asaas }` **só** na conciliação em que uma diferença de preço foi achada e corrigida; `null` em todas as outras. É evento, não estado — o seu aviso de que o preço daquele assinante mudou fora do checkout |
| `ciclo` | Congelado na criação (seção 4.2), mas **reconferido contra a Asaas** a cada consulta — ver a nota acima |
| `proximaCobranca` | Quando a Asaas vai cobrar de novo. `null` se não houver |
| `ultimaCobranca` | O ciclo mais recente, com o `status` do vocabulário da seção 4.3.3. `null` se nada foi cobrado |

**As duas metades respondem a perguntas diferentes:** `status` diz se o
vínculo existe; `ultimaCobranca.status` diz se o último ciclo entrou. Um
assinante `ativa` com última cobrança `vencido` é justamente o caso que
pede o link de renovação (seção 7.3).

Como a 5.2, esta rota **reconsulta a Asaas** quando a última cobrança
ainda parece pendente e corrige o registro antes de responder — é assim
que ela enxerga pagamento que o webhook perdeu.

| Código | Significa |
|---|---|
| `200` | Encontrado |
| `400` | `planoId`/`documento` ausentes, ou CPF/CNPJ inválido |
| `401` | Chave ausente ou inválida |
| `404` | Nunca houve assinatura **nem tentativa de cobrança** desse plano para esse documento |

> O `404` é estreito de propósito. Uma assinatura que foi tentada e não
> confirmou ainda não tem `assinaturaId`, mas **tem** `ultimaCobranca` —
> e responde `200`. Se respondesse `404`, a conciliação não conseguiria
> distinguir "ele tentou e não pagou" de "ele nunca veio", que é metade
> do motivo de esta rota existir.

---

### 5.4 Estornar

```http
POST {BASE}/api/checkout/estornar
X-Checkout-Key: {sua chave}
Content-Type: application/json

{ "pedidoId": "550e8400-..." }
```

**Resposta 200:**

```json
{ "chargeId": "pay_8392017465", "status": "estornado" }
```

- **Sempre tudo ou nada.** Não existe estorno parcial de um item dentro
  de um pedido. Para cancelar só parte, estorne tudo e crie um pedido
  novo com o que sobrou.
- Depois do estorno você também recebe o webhook correspondente
  (seção 4.3.3).

**Exceção — boleto não é instantâneo.** Pix e cartão estornam numa
chamada só. Boleto não: a Asaas gera um link que o **pagador** precisa
preencher (dados bancários e documentos) antes do dinheiro voltar. Nesse
caso a resposta vem com `"status": "estorno_solicitado"`, e o
`"estornado"` chega por webhook depois, quando ele concluir. É um estado
intermediário real, não erro.

| Código | Significa |
|---|---|
| `200` | Estorno executado ou solicitado |
| `400` | `pedidoId` ausente |
| `401` | Chave ausente ou inválida |
| `404` | Nenhuma cobrança encontrada para esse pedido |
| `502` | A Asaas recusou o estorno — a mensagem traz o motivo dela |

---

### 5.5 Cancelar, pausar e retomar assinatura

As três usam a **mesma autenticação e o mesmo body**:

```http
POST {BASE}/api/checkout/cancelar-assinatura
POST {BASE}/api/checkout/pausar-assinatura
POST {BASE}/api/checkout/retomar-assinatura
X-Checkout-Key: {sua chave}
Content-Type: application/json

{ "planoId": "plano-vitrina-9f2c", "documento": "11144477735" }
```

**Resposta 200:**

```json
{ "assinaturaId": "sub_000123456789", "status": "cancelada" }
```

| Ação | Aceita a assinatura em | O que acontece |
|---|---|---|
| **Pausar** | `ativa` ou `pausada` | Para de gerar cobranças. O vínculo continua existindo |
| **Retomar** | `pausada` ou `ativa` | Volta a cobrar no mesmo valor e ciclo |
| **Cancelar** | `ativa` **ou `pausada`** | **Definitivo.** Para voltar, o assinante assina de novo do zero |

**Pausar e retomar são idempotentes: cancelar não.** Pedir para pausar
uma assinatura já pausada (ou retomar uma já ativa) responde `200` com
`"jaEstava": true`, sem chamar a Asaas de novo. **Cancelar não tem esse
caminho** — a busca de `/cancelar-assinatura` deliberadamente não inclui
`cancelada` entre os estados aceitos (ela pega a linha mais recente por
`planoId`+`documento`, e aceitar `cancelada` poderia, numa renovação,
mascarar uma assinatura ativa mais nova). Cancelar uma assinatura que já
foi cancelada responde `404`, igual a cancelar uma que nunca existiu.

> **Uma assinatura pausada pode ser cancelada.** Até 15/09/2026 isto não
> era verdade: `/cancelar-assinatura` só buscava `ativa`, e pausar virava
> porta de mão única — quem pausasse não conseguia mais cancelar por
> lugar nenhum. Corrigido (RN-19, `docs/funcional.md`); a tabela acima já
> reflete o estado atual.

> Use **pausar** quando o assinante quer parar por um tempo. Cancelar
> nesse caso vira churn: quem cancela raramente refaz todo o processo.

Cancelar aqui só **para as cobranças futuras** — não estorna nada já
pago. Se precisar devolver o último ciclo, use `/estornar`
separadamente.

> **Só o seu projeto aciona.** O pagador nunca cancela sozinho pelo
> checkout — a decisão (e a regra de negócio por trás dela) é sua.

| Código | Significa |
|---|---|
| `200` | Executado |
| `400` | `planoId`/`documento` ausentes ou CPF/CNPJ inválido |
| `401` | Chave ausente ou inválida |
| `404` | Nenhuma assinatura nesse estado para esse plano/documento (cancelar já cancelada também cai aqui) |

---

### 5.6 Trocar de plano (upgrade e downgrade)

Leva um assinante do plano A para o plano B **mantendo o vínculo**: sem
cancelar, sem ele digitar cartão de novo, e sem janela em que ele fica
sem assinatura.

```http
POST {BASE}/api/checkout/trocar-plano
X-Checkout-Key: {sua chave}
Content-Type: application/json

{
  "planoId": "plano-vitrina-9f2c",
  "planoNovoId": "plano-vitrina-pro-3a81",
  "documento": "11144477735"
}
```

**O preço e o ciclo do plano novo NÃO vão no corpo.** O checkout puxa os
dois do **seu** `GET /plano/{planoNovoId}` (seção 4.2), como faz na
criação da assinatura. É a mesma regra do valor de um pedido: quem paga
não escolhe quanto paga.

**Resposta 200 — troca para um plano mais caro:**

```json
{
  "assinaturaId": "sub_000123456789",
  "planoId": "plano-vitrina-pro-3a81",
  "planoAnterior": "plano-vitrina-9f2c",
  "valor": 160.00,
  "ciclo": "MONTHLY",
  "proximaCobranca": "2026-10-10",
  "acerto": {
    "cobrado": true,
    "valor": 30.00,
    "chargeId": "pay_000987654321",
    "credito": 50.00,
    "debito": 80.00,
    "diasRestantes": 15,
    "motivo": "cobra o acerto"
  }
}
```

#### O que acontece, na ordem

1. **O acerto proporcional é calculado** (a conta está na seção 7.5).
2. **Se houver acerto, ele é cobrado AGORA, no cartão que já está
   salvo** — o assinante não digita nada.
3. **O plano só muda se o acerto for aprovado.** Cartão recusado
   responde `402` e **nada** é alterado.
4. A assinatura passa a valer `valor` e `ciclo` do plano novo, e a
   **data de vencimento não se move**: o plano novo inteiro entra na data
   que o assinante já tinha.
5. Você recebe `evento: "plano_trocado"` no webhook (seção 4.3.4).

#### Os campos de `acerto`, e por que eles vão abertos

| campo | o que é |
|---|---|
| `cobrado` | `true` se uma cobrança foi feita agora |
| `valor` | quanto foi cobrado (`0` quando não houve) |
| `chargeId` | id da cobrança do acerto na Asaas, ou `null` |
| `credito` | a parte **não usada** do que ele já pagou |
| `debito` | o que o plano novo custaria nos dias que faltam |
| `diasRestantes` | dias até o vencimento que já estava marcado |
| `motivo` | por que cobrou, ou por que não cobrou |

Eles vão abertos porque **explicar a cobrança ao assinante é
responsabilidade sua** — por e-mail e por aviso no seu site (decisão do
dono em 17/09/2026; `docs/funcional.md` RN-35). O checkout não fala com
o pagador: ele não manda e-mail, não manda WhatsApp, não mostra tela.
Sem `credito`, `debito` e `diasRestantes`, o seu aviso seria "cobramos
R$ 30" sem dizer de onde saiu o número.

#### Quando NÃO há cobrança, e a troca acontece do mesmo jeito

- **Plano mais barato** (downgrade): não cobra e **não devolve nada**. O
  preço novo passa a valer no vencimento que já existia. `acerto.cobrado`
  vem `false`.
- **Plano mais caro no total, mais barato por dia**: também não cobra —
  um trimestral de R$ 270 custa menos por dia que um mensal de R$ 100.
  A seção 7.5 explica por que "a diferença entre os planos" é a conta
  errada.
- **Acerto abaixo de R$ 5,00**: absorvido. A Asaas não aceita cobrança
  menor que isso, e arredondar para cima seria cobrar mais do que o
  devido. `motivo` vem começando com `absorvido:`.

#### Códigos

| Código | Significa |
|---|---|
| `200` | Trocado. Leia `acerto.cobrado` para saber se houve cobrança |
| `400` | Campos ausentes, CPF/CNPJ inválido, `planoNovoId` igual ao `planoId`, ou o plano novo com valor abaixo de R$ 5,00 / ciclo fora dos sete (seção 7.1) |
| `401` | Chave ausente ou inválida |
| `402` | **O acerto não foi aprovado no cartão salvo. O plano NÃO foi alterado** |
| `404` | Nenhuma assinatura `ativa` ou `pausada` nesse plano/documento, ou o plano novo não existe na sua API |
| `409` | Ver a tabela abaixo |
| `502` | A alteração não foi confirmada pela Asaas. **O plano NÃO foi alterado** — se `acerto.chargeId` vier preenchido, o acerto FOI cobrado e precisa de tratamento manual |

Os `409` são as recusas deliberadas, e cada uma tem motivo:

| Situação | Por que recusa |
|---|---|
| **A cobrança do período em curso não está confirmada** | Não existe crédito de um período que não foi pago. Resolva o pagamento antes |
| **Já existe uma troca em andamento** | Duas chamadas simultâneas cobrariam o acerto duas vezes. A segunda é recusada sem cobrar nada |
| **A assinatura não tem cartão salvo** | É o caso do Pix Automático: sem cartão não há como cobrar o acerto sem interação do assinante |
| **A assinatura está encerrada na Asaas** | Não há plano a trocar. O caminho é assinar de novo |
| **Não foi possível calcular o acerto** | Vem com `motivo`. Significa dado incoerente (ciclo desconhecido, vencimento mais longe que o ciclo inteiro) — e aqui o checkout **recusa em vez de dar a troca de graça** |

> **Só o seu projeto aciona**, como em cancelar/pausar/retomar. O
> assinante não troca de plano sozinho pelo checkout: quem decide (e
> quem cobra o consentimento dele) é você. Isso importa: mudar o valor
> que um cartão salvo vai cobrar **exige concordância do assinante**
> (CDC). Um upgrade que ele pediu é uma coisa; um aumento que ele não
> pediu é outra, e a segunda não se resolve com API.

> ⚠️ **Depois da troca, o `planoId` do assinante é o NOVO.** Cancelar,
> pausar, retomar, conciliar (seção 5.5 e 5.3) e gerar link de renovação
> (seção 7.3) passam a usar `planoNovoId`. Continuar mandando o antigo
> responde `404` — a assinatura não está mais lá. É por isso que o evento
> `plano_trocado` carrega `planoAnterior`: é com ele que você acha o seu
> próprio registro para atualizar.

> **Uma troca por vez, e o crédito não acumula.** Cada troca recalcula
> sobre os dias que restam naquele momento, a partir do valor **pago**
> do período — o crédito da troca anterior não sobrevive (decisão do
> dono; a aritmética está na seção 7.5).

---

### 5.7 Página pública de status do comprador

Toda cobrança de Pix ou Boleto tem uma página permanente:

```
https://{CHECKOUT}/status.html?c={contratanteId}&pedido={pedidoId}
```

Ela mostra o estado atual e, enquanto a cobrança estiver válida,
**devolve o QR Code do Pix e a linha digitável do boleto** — a segunda
via de quem fechou a aba. Atualiza sozinha a cada 10 segundos e reage
quando o pagamento cai.

O checkout já mostra esse link ao comprador na hora de gerar a cobrança.
**Se você manda e-mail de confirmação de pedido, inclua o link também**
— é o que evita a maior parte dos "perdi meu boleto" chegando no seu
suporte.

A página não expõe nenhum dado pessoal: só valor, forma de pagamento e
estado. Ainda assim ela só é alcançável por quem tem o `pedidoId`, o que
reforça a exigência de id imprevisível da seção 3.

Se quiser montar a sua própria tela, o JSON por trás dela é público:

```http
GET {BASE}/api/checkout/status/{contratanteId}/{pedidoId}
```

```json
{
  "pedidoId": "550e8400-...",
  "status": "pendente",
  "metodoPagamento": "pix",
  "valorCobrado": 449.30,
  "criadoEm": "2026-09-10T14:02:11.482Z",
  "pagamento": {
    "qrCodeBase64": "iVBORw0KGgo...",
    "copiaECola": "00020126580014BR.GOV.BCB.PIX..."
  }
}
```

`pagamento` vem `null` quando a cobrança já não é mais pagável, e traz
`boletoUrl`, `linhaDigitavel`, `codigoBarras` e `vencimento` no caso do
boleto. **Não há autenticação aqui** — por isso nada de pessoal trafega.

---

### 5.8 Saúde do serviço

```http
GET {BASE}/api/saude
```

```json
{
  "status": "ok",
  "chaveAsaasConfigurada": true,
  "supabaseConfigurado": true,
  "supabaseRespondendo": true,
  "alertasChaveAsaas": []
}
```

Sem autenticação. Útil para um monitor externo. **Código HTTP:** `200`
quando saudável; `503` com `"status": "degradado"` quando o banco não
responde (o serviço está no ar mas não cobra nem concilia) — aponte o
monitor de uptime para alertar no HTTP não-2xx. `alertasChaveAsaas` não
vazio significa que a chave de API da Asaas está para expirar ou já
expirou (cobranças param de funcionar) — é aviso no corpo, não derruba o
HTTP; monitore-o lendo o corpo.

---

## 6. Métodos de pagamento

### 6.1 O que cada um exige do comprador

| Método | Dados pedidos na tela | Confirmação | Observações |
|---|---|---|---|
| **Pix** | nome, e-mail, CPF/CNPJ, (telefone) | segundos | QR Code + copia-e-cola na própria tela |
| **Boleto** | nome, e-mail, CPF/CNPJ, (telefone) | 1-3 dias úteis | Indisponível em pedido com `expiraEm` |
| **Cartão de crédito** | + telefone e **endereço completo** | segundos | 1 a 12 parcelas. Dados do cartão numa pop-up da Asaas |
| **Assinatura (cartão)** | + telefone e **endereço completo** | segundos | Cobrança automática a cada ciclo |
| **Assinatura (Pix Automático)** | nome, e-mail, CPF/CNPJ | minutos | Sem cartão e **sem endereço** |

O endereço em cartão não é capricho: é exigência antifraude da Asaas. O
checkout resolve rua/bairro/cidade a partir do CEP automaticamente.

### 6.2 Onde os dados do cartão passam

**Em lugar nenhum do San Checkout, e em lugar nenhum do seu projeto.**
Número e CVV são digitados numa pop-up hospedada pela própria Asaas.
Nenhum dado de cartão toca os nossos servidores, o que mantém os dois
lados fora do escopo PCI-DSS.

Consequência prática: não existe API para "trocar o cartão de uma
assinatura" — a troca é feita pelo link de renovação (seção 7.3).

### 6.3 Cobrança duplicada não acontece

Se o comprador recarregar a página e pedir um Pix de novo, ele recebe **o
mesmo Pix** — o checkout reaproveita a cobrança pendente daquele pedido
em vez de criar uma segunda igualmente pagável. Vale para boleto também,
onde o estrago seria maior (o antigo segue pagável por dias). A resposta
traz `"reaproveitada": true` nesse caso.

### 6.4 Métodos habilitados por contratante

Cada contratante tem uma lista de métodos liberados, definida no painel
do administrador. O comprador só vê os métodos liberados para você, e
uma chamada direta a um método bloqueado recebe:

```json
{ "erro": "Este contratante não aceita pagamento por boleto." }
```
com HTTP `403`.

Valores possíveis: `pix`, `boleto`, `cartao`, `assinatura`,
`assinatura_pix`.

**`assinatura_pix` nasce desmarcado**, sempre: Pix Automático depende de
liberação da Asaas na conta. Combine a liberação antes de pedir para
ativar.

---

## 7. Assinaturas em detalhe

### 7.1 Ciclos aceitos

Os sete, exatamente como escritos:

| `ciclo` | Cobra a cada | Pix Automático |
|---|---|:--:|
| `WEEKLY` | 1 semana | ✅ |
| `BIWEEKLY` | 15 dias | ❌ |
| `MONTHLY` | 1 mês | ✅ |
| `BIMONTHLY` | 2 meses | ❌ |
| `QUARTERLY` | 3 meses | ✅ |
| `SEMIANNUALLY` | 6 meses | ✅ |
| `YEARLY` | 1 ano | ✅ |

Qualquer outro valor é recusado com `400` nomeando os aceitos — o
checkout nunca repassa ciclo desconhecido para a Asaas.

`BIWEEKLY` e `BIMONTHLY` não existem no Pix Automático. Um plano com
esses ciclos recebe `400` explicando e **continua funcionando
normalmente por cartão**.

### 7.2 Assinatura por Pix Automático

O assinante lê **um** QR Code no app do banco e, no mesmo ato, paga a
primeira cobrança **e autoriza os débitos seguintes**. Depois disso, o
banco debita sozinho a cada ciclo.

Por que importa:

- Alcança quem **não tem cartão de crédito**.
- Elimina o churn involuntário por cartão vencido ou sem limite — a
  maior perda silenciosa de receita em recorrência.
- **Não existe chargeback de Pix.**

**Você não precisa fazer nada diferente.** É o mesmo link de assinatura,
o mesmo `GET /plano/{id}`, os mesmos eventos de webhook. O checkout
mostra "Assinar com Pix — sem cartão" abaixo do botão de cartão quando o
método está habilitado.

Se o banco do assinante recusar um débito, a Asaas **tenta de novo
sozinha** (até três vezes em sete dias) antes de considerar o ciclo
perdido.

O QR Code da primeira cobrança vale **1 hora**. Passou disso sem ler, o
assinante abre o link de novo e recebe um QR novo — nada é cobrado nem
autorizado enquanto ele não ler.

### 7.3 Renovação — cartão vencido ou troca de cartão

Mande o assinante para o link de assinatura com **`&renovar={token}`**,
onde `{token}` é gerado por VOCÊ (nunca pelo checkout, e nunca o
literal `1`):

```
https://{CHECKOUT}/index.html?c={contratante_id}&assinatura={planoId}&renovar={token}
```

Ele preenche o cartão novo na pop-up de sempre, e **a assinatura antiga é
cancelada automaticamente assim que a nova for paga** — nessa ordem, para
que ele nunca fique sem assinatura nenhuma se o pagamento falhar.

Use isso ao receber `cobranca_falhou`.

#### ⚠️ O token é obrigatório — sem ele, é só uma assinatura nova

Até 16/09/2026 bastava mandar `&renovar=1`: o checkout confiava no
`documento` que o próprio formulário coletava, sem confirmar que quem
estava pagando era o mesmo assinante. **CPF/CNPJ não é segredo** —
qualquer pessoa que soubesse (ou adivinhasse, ou obtivesse de um
vazamento qualquer) o documento de um assinante ativo seu podia montar
esse link, pagar com o **próprio** cartão, e — ao confirmar — fazia o
checkout cancelar a assinatura de VERDADE da vítima na Asaas. Um
cancelamento de terceiro pelo caminho de dinheiro, sem tocar em
credencial nenhuma sua.

Por isso o `renovar` tem que ser um **token HMAC-SHA256**, calculado por
você com a sua `X-Checkout-Key` como segredo — a mesma chave que já
assina o webhook que você recebe (seção 4.3.1). Só quem tem a chave
consegue gerar um token que o checkout aceita; saber o `documento` da
vítima não basta mais.

**Fórmula:**

```
timestamp = agora, em segundos (epoch)
mensagem  = "{timestamp}.{contratante_id}.{planoId}.{documento}"
hmac      = HMAC-SHA256(mensagem, sua X-Checkout-Key)
token     = "{timestamp}.{hmac em hex}"
```

**Node.js**

```js
import crypto from 'node:crypto';

function gerarTokenRenovacao(apiKey, { contratanteId, planoId, documento }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = crypto.createHmac('sha256', apiKey)
    .update(`${timestamp}.${contratanteId}.${planoId}.${documento}`)
    .digest('hex');
  return `${timestamp}.${hmac}`;
}
```

**PHP**

```php
function gerarTokenRenovacao($apiKey, $contratanteId, $planoId, $documento) {
    $timestamp = time();
    $hmac = hash_hmac('sha256', "$timestamp.$contratanteId.$planoId.$documento", $apiKey);
    return "$timestamp.$hmac";
}
```

**Python**

```python
import hmac, hashlib, time

def gerar_token_renovacao(api_key, contratante_id, plano_id, documento):
    timestamp = int(time.time())
    mensagem = f'{timestamp}.{contratante_id}.{plano_id}.{documento}'
    assinatura = hmac.new(api_key.encode(), mensagem.encode(), hashlib.sha256).hexdigest()
    return f'{timestamp}.{assinatura}'
```

O token vale por **7 dias** a partir de quando foi gerado — folgado o
bastante pra um link de e-mail que ninguém abre na hora, sem ficar
eterno. Gere um token novo por assinante e por tentativa; não reaproveite
um token velho.

**O que acontece se o token faltar ou não conferir:** nada de errado —
o checkout trata como uma assinatura **nova comum**: cria e cobra
normalmente, só não amarra nem cancela nenhuma outra. É o modo seguro,
não um erro que trava o pagador.

> **A renovação gera um id de assinatura NOVO na Asaas.** Do seu lado é a
> continuação do mesmo assinante (mesmo `planoId`, mesmo `documento`).
> Se você guarda o id da assinatura, atualize-o.
>
> Por que não trocamos só o cartão: a API da Asaas exige receber número e
> CVV para isso, o que colocaria o checkout — e por tabela você — dentro
> do escopo PCI-DSS.

> **Se o assinante fechar a pop-up de renovação sem pagar, nada muda.** A
> assinatura antiga segue ativa e sendo cobrada normalmente — nenhum
> webhook é enviado (seção 4.3.5), e ela só é cancelada depois que a nova
> confirmar. Não force uma nova tentativa assumindo que a antiga parou.

### 7.4 Ciclo de vida completo

```
   link ?assinatura=...
        │
        ▼
   pagamento da 1ª cobrança ──► webhook  evento: criada
        │
        ├──► ciclo cobrado ────► webhook  evento: cobranca_confirmada
        │
        ├──► ciclo falhou ─────► webhook  evento: cobranca_falhou
        │         │
        │         └──► você manda o link &renovar={token}
        │
        ├──► POST /pausar-assinatura ──► para de cobrar, vínculo vivo
        │         │
        │         ├──► POST /retomar-assinatura ──► volta a cobrar
        │         │
        │         └──► POST /cancelar-assinatura ─► webhook  evento: cancelada
        │                                          (pausada TAMBÉM cancela — seção 5.5)
        │
        └──► POST /cancelar-assinatura ─► webhook  evento: cancelada
                                          (definitivo)
```

### 7.5 Mudar o preço de quem já assinou — o que dá, o que não dá, e o que o checkout não faz

**Resumo em três linhas.** A Asaas **permite** aumentar e diminuir o
valor de uma assinatura ativa, e trocar o ciclo dela. **O San Checkout
expõe isso desde 17/09/2026, como troca de PLANO**: `POST
/trocar-plano` (seção 5.6) — o preço vem do plano de destino cadastrado
na sua API, nunca solto. O que continua valendo: se alguém mudar o preço
**pelo painel da Asaas**, nada nos avisa, e o `valor` da seção 5.3
continua sendo **o nosso registro**.

Tudo abaixo foi **medido no sandbox em 17/09/2026**, em assinatura de
**cartão** (o meio que o checkout usa) e também em boleto, com fixtures
descartáveis apagadas no fim. Até aquele dia este documento afirmava que
valor e ciclo eram congelados pela Asaas — era falso, e o registro do
erro está em
`docs/erros/2026-09-17-declarei-limite-do-provedor-sem-ter-medido.md`.

#### O que a Asaas faz, medido

| o que eu tentei | resposta | conferido no `GET` depois |
|---|---|---|
| **aumentar**: R$ 30 → R$ 45 (cartão) | `200` | `value: 45` |
| **diminuir**: R$ 45 → R$ 12 (cartão) | `200` | `value: 12` |
| **abaixo do piso**: R$ 12 → R$ 3 | **`400 invalid_value`** — "O valor mínimo para cobranças via cartão de crédito é R$ 5,00." | continuou `12`: nada mudou |
| **trocar o ciclo**: `MONTHLY` → `YEARLY` | `200` | `cycle: YEARLY`, e **`nextDueDate` NÃO se moveu** |
| **em assinatura PAUSADA** (`INACTIVE`) | `200` | `value: 77`, `status: INACTIVE` — pausada aceita mudança de preço |
| alterar **a cobrança pendente já gerada** | só com `updatePendingPayments: true` | sem a bandeira, a pendente fica no valor antigo; com ela, a pendente muda (mesmo id, mesmo vencimento) |
| **controle negativo**: mandar um campo que não existe | `200`, **sem erro** | nada mudou |

Três coisas que essa tabela ensina, e que valem para qualquer integração
com a Asaas:

1. **O piso de R$ 5,00 vale na alteração também**, não só na criação — e
   a mensagem de erro é **por meio de pagamento** ("via cartão de
   crédito" × "via Boleto Bancário", as duas medidas). Quem alterar
   preço precisa validar antes, senão a recusa aparece na cara do
   operador sem explicação.
2. **Ciclo novo não mexe na data já marcada.** Trocar `MONTHLY` por
   `YEARLY` mantém o `nextDueDate`; o ciclo novo passa a contar **a
   partir** daquela data. Quem espera "virou anual, então a próxima é em
   um ano" vai errar por onze meses.
3. **`200` não prova nada nesta API.** O controle negativo devolveu
   `200` sem erro para um campo inventado: a Asaas **ignora em silêncio
   o que não conhece**. Portanto mandar `valor` em vez de `value`, ou
   `amount`, é aceito e não faz nada. Quem alterar preço confere lendo
   de volta, nunca pelo código HTTP.

> **Uma ressalva de estabilidade:** `value` **não aparece no schema
> documentado** do `PUT` de assinatura da Asaas (a documentação lista
> `cycle`, `nextDueDate`, `billingType`, `updatePendingPayments`,
> `status`, `description`, `discount`, `interest`, `fine`, `split`,
> `callback`, `endDate`, `externalReference`). Funciona — medido —, mas
> é comportamento **não documentado**, e comportamento não documentado
> pode mudar sem aviso.

#### O que o San Checkout faz — e o que continua por sua conta

> ⚠️ Esta seção dizia **"nada, e é isto que você precisa saber"** até
> 17/09/2026, e estava certa naquele dia: a rota não existia. O dono
> autorizou construí-la no mesmo dia, depois de decidir as sete regras do
> acerto. O que segue abaixo é o estado atual.

- **Existe rota nossa**: `POST /trocar-plano` (seção 5.6), que troca o
  plano de um assinante cobrando o acerto proporcional no cartão já
  salvo. As rotas de assinatura passaram a ser cinco: criar (pelo link),
  cancelar, pausar, retomar (seção 5.5) e trocar de plano.
- **Ela não aceita preço solto.** Você troca o assinante de um plano
  para OUTRO PLANO seu; o valor e o ciclo saem do
  `GET /plano/{planoNovoId}`. Não há como mandar "cobre R$ 45 deste
  assinante" — para isso, o caminho continua sendo o pedido avulso.
- **Ela não mexe em assinatura sem cartão salvo** (Pix Automático) quando
  há acerto a cobrar: responde `409`.
- **Nada nos avisa se o valor mudar na Asaas.** Medido: nenhum evento
  chegou ao nosso receptor em toda a bateria acima — criar, aumentar,
  diminuir, trocar ciclo, pausar e apagar a assinatura. Isso é
  **configuração**, não incapacidade: o grupo `SUBSCRIPTION_*` não está
  entre os 53 eventos marcados nesta conta, e `PAYMENT_UPDATED` está
  desmarcado de propósito (`CONSTRAINTS.md` §2.2).
- **Consequência direta, e ela mudou em 18/09/2026:** na seção 5.3, os
  campos `status`, `ciclo`, `proximaCobranca` **e agora `valor`** são
  reconferidos contra a Asaas a cada chamada. Até 17/09 o `valor` era a
  exceção, saía do nosso banco, e este documento te avisava para não
  confiar nele — hoje a conciliação **corrige o nosso registro** e
  **denuncia a diferença** em `divergenciaDeValor`.

  O que isso significa para você, na prática: preço mudado no painel da
  Asaas **não fica invisível**, mas você só o descobre **quando roda a
  conciliação** — nada nos avisa na hora (é o item acima). Continua
  valendo o "rode uma vez por dia" da 5.3, e agora com um motivo a mais.

#### Então como se muda o preço de um assinante hoje

Três caminhos, e o primeiro é o novo:

0. **Trocar de plano** (`POST /trocar-plano`, seção 5.6). É o caminho
   normal quando o preço novo é **outro plano seu**: mantém o vínculo,
   cobra só a diferença proporcional dos dias que faltam, e não pede
   cartão de novo. Rebaixamento não devolve nada — o preço novo vale do
   vencimento em diante.
1. **Cancelar e assinar de novo** (`POST /cancelar-assinatura`, depois um
   link novo com o plano de valor diferente). Custo: o assinante digita
   o cartão outra vez, o vínculo antigo morre, e existe uma janela em
   que ele não tem nem uma assinatura nem a outra.
2. **Cobrar a diferença como pedido avulso** (seção 4.1), mantendo a
   assinatura como está. É o caminho que o dono escolheu para o MostrAí
   em 16/09/2026. Não mexe em nada recorrente.

#### A conta do acerto proporcional

A Asaas **não tem proporcional nenhum** — medido: `updatePendingPayments`
põe na cobrança pendente o valor novo **cheio**, não um rateio. O acerto
é conta nossa, e é esta:

```
dias_restantes = vencimento_que_já_estava_marcado − hoje
credito        = valor_PAGO_do_período × (dias_restantes ÷ dias_do_ciclo_atual)
debito         = valor_do_plano_novo   × (dias_restantes ÷ dias_do_ciclo_novo)
acerto         = debito − credito       (≤ 0 → não cobra e não devolve)
```

**Mês comercial de 30 dias, ano de 360** (decisão do dono). O crédito sai
do valor **pago**, nunca do valor atual da assinatura — senão daria para
alterar o valor antes de trocar e farmar crédito.

**Por que os dois lados são proporcionalizados, e não a diferença.** Com
15 dias restantes de um mensal de R$ 100:

| troca para | crédito | débito | cobra agora | no vencimento |
|---|---|---|---|---|
| mensal R$ 160 | 100 × 15/30 = **50** | 160 × 15/30 = **80** | **R$ 30** | R$ 160, mensal |
| trimestral R$ 270 (R$ 90/mês) | **50** | 270 × 15/90 = **45** | **nada** (−5) | R$ 270, trimestral |
| anual R$ 2.400 (R$ 200/mês) | **50** | 2400 × 15/360 = **100** | **R$ 50** | R$ 2.400, anual |

A linha do meio é o motivo: "a diferença entre os planos" daria
R$ 270 − R$ 100 = **R$ 170 cobrados por 15 dias** de um plano que custa
R$ 90/mês. Um plano mais caro no total pode ser **mais barato por dia** —
e aí a troca é upgrade de compromisso, não de preço, e não gera acerto.

Os números acima saem de `src/services/proporcionalService.js`, que é o
mesmo código que a rota usa, com autoteste próprio.

**Se você mudar o preço direto no painel da Asaas**, saiba o que
acontece: a Asaas passa a cobrar o valor novo, e nós continuamos
dizendo o antigo na seção 5.3. Não é proibido — é inconsistente, e a
inconsistência é silenciosa.

### 7.6 O que a assinatura NÃO faz — leia antes de prometer benefício

Esta seção existe porque promessa feita ao assinante e não cumprida pelo
motor vira cobrança indevida, e cobrança indevida não volta com redeploy.
**Nada abaixo está no mapa de versões futuras — é o estado de hoje.**

| Não existe | O que isso significa na prática |
|---|---|
| **Carência / teste grátis / primeiro mês grátis** | A primeira cobrança sai **no ato da assinatura**, sempre. Não há campo para adiar a data de início |
| **Pular ou adiar um ciclo** | Os ciclos seguintes caem exatamente a cada `ciclo`, contados da primeira cobrança. Não há "este mês não cobra" |
| **Desconto, cupom ou promoção no plano** | O campo `desconto` existe **só no pedido avulso** (seção 4.1). A assinatura cobra `valor` exatamente como veio do seu `GET /plano/{id}` |
| **Ciclo de 4, 5 ou 8 meses** | Só os sete da seção 7.1. Não há quadrimestral |
| **Mudar o valor de um assinante para um número solto** | Trocar de PLANO existe (seção 5.6): o assinante vai do plano A para o plano B, e o preço sai do plano B. O que não existe é "cobre R$ 45 deste assinante" sem plano por trás — para isso, pedido avulso |
| **Mover a data de vencimento de um assinante** | Não existe rota nossa. Trocar de plano mantém a data de propósito (a Asaas não move o `nextDueDate` nem quando o ciclo muda — medido) |

#### Como modelar "pague 3, leve 4" mesmo assim

O benefício recorrente — a cada trimestre pago, um mês de brinde — **é
incompatível com ciclo fixo por construção**, não por limitação nossa: o
serviço avançaria 4 meses por ciclo enquanto a cobrança volta a cada 3, e
os dois calendários se afastam um mês por trimestre até o assinante estar
pagando por tempo que já usou.

O equivalente exato é **embutir o benefício no preço, não no tempo**:

```
mensalidade                      M
trimestral sem benefício         3 × M   (4 cobranças/ano = 12M)
com "a cada 3 pagos, 1 grátis"   9M por ano ÷ 4 cobranças = 2,25 × M
```

Ou seja: **desconto de 25% no valor do ciclo trimestral**. O assinante
paga por 9 meses a cada 12, que é exatamente a promessa, e você não
depende de nenhuma data especial — é só o `valor` que o seu
`GET /plano/{id}` devolve. Não exige nada do checkout.

Se o benefício for **só na primeira compra** (e não a cada trimestre),
esse cálculo não fecha, e hoje não há caminho limpo: pausar e retomar na
data certa é operação manual sobre o caminho de dinheiro — se ninguém
executar no dia, o assinante é cobrado e a correção é estorno. Fale com
quem administra o checkout antes de vender isso.

---

## 8. Taxas, split e o valor cobrado

```
taxaAsaas    = tabela por MÉTODO (sincronizada com a conta real)
taxaPropria  = percentual + fixo do San Checkout, igual em qualquer método

SE isentarTaxa = true:
    taxasTotais = taxaDoProjeto
SENÃO:
    taxasTotais = taxaDoProjeto + taxaAsaas + taxaPropria

valorCobrado = valorComDesconto + frete + taxasTotais
```

A taxa do checkout é **somada por cima**, nunca descontada do que você
configurou: o valor que **lhe cabe** é `valorComDesconto + frete`
integral.

> ⚠️ **Como esse valor chega até você depende do `wallet_id`, e hoje ele
> não existe para nenhum contratante.**
>
> | com `wallet_id` | sem `wallet_id` — **é o caso hoje** |
> |---|---|
> | a Asaas divide na liquidação (`split`) e a sua parte cai direto na sua subconta | **tudo cai na conta do operador**, e o repasse a você é **manual, por fora do sistema** |
>
> A frase anterior desta seção dizia "direto na conta, se não tiver", o
> que se lia como "direto na sua conta". Era falso e está corrigido: sem
> `wallet_id` a sua parte passa pela conta do operador antes de chegar a
> você.
>
> O motivo não é escolha de arquitetura: a conta-mãe da Asaas está
> registrada como pessoa física, e conta PF não cria subconta — logo não
> há `wallet_id` para cadastrar. Medido em 17/09/2026. A conversão para
> CNPJ é atualização futura, e o `split` liga junto com ela. Detalhe em
> `CONSTRAINTS.md` §2.5.3 e §3.

**Tabela da Asaas (valores de referência):**

| Método | Taxa |
|---|---|
| Pix | R$ 1,99 fixo |
| Boleto | R$ 1,99 fixo |
| Cartão de débito | R$ 0,35 + 1,89% |
| Cartão de crédito à vista | R$ 0,49 + 2,99% |
| Cartão de crédito 2-6x | R$ 0,49 + 3,49% |
| Cartão de crédito 7-12x | R$ 0,49 + 3,99% |

> Estes números são o **ponto de partida**. O checkout consulta as taxas
> reais da conta na Asaas no boot e a cada 24 horas, e passa a usá-las —
> então um reajuste da Asaas, ou uma taxa melhor negociada por volume,
> vale automaticamente. O valor que vale para uma cobrança específica é
> sempre o `taxaAsaas` que vem no webhook dela.

**Isenção pontual (`isentarTaxa`):** é você, pedido a pedido, quem decide
se uma venda fica sem a taxa do checkout (ex.: campanha "taxa zero"). Não
existe configuração fixa de "este contratante nunca paga taxa" — a
flexibilidade é só por pedido. A isenção é da taxa do checkout; a sua
`taxaDoProjeto` continua sendo cobrada.

> **Assinatura é exceção:** nesta versão, assinatura **não** aplica
> `taxaAsaas`/`taxaPropria` — cobra exatamente o `valor` do plano.
> `taxaIsenta` sempre vem `true` nos webhooks de assinatura.

---

## 9. Limites e validações do sistema

Tudo abaixo é validado **no servidor**, não só na tela. Chamar a API
direto não contorna nada.

| Regra | Limite | Erro |
|---|---|---|
| Valor da cobrança | R$ 0,01 a **R$ 100.000,00** | `400` "Valor do pedido inválido" |
| Valor do plano | idem | `400` "Valor do plano inválido" |
| **Valor COBRADO** (pedido + taxa) | mínimo **R$ 5,00** | `400` "O valor mínimo para pagamento é de R$ 5,00…" |
| Parcelas no cartão | 1 a 12 | `400` |
| CPF | 11 dígitos, com dígito verificador conferido | `400` "CPF/CNPJ inválido" |
| CNPJ | 14 dígitos, com dígito verificador conferido | `400` idem |
| Telefone | 10 ou 11 dígitos, DDD ≥ 11, celular começando em 9 | `400` "Telefone inválido" |
| CEP | 8 dígitos | `400` "CEP inválido" |
| `pedidoId` / `planoId` | não pode ser só dígitos com menos de 8 caracteres | `400`, com explicação |
| Timeout da sua API | 45 segundos | `504` |
| Requisições | 10/min (dinheiro) · 60/min (consulta) | `429` |
| `GET /api/saude` | 30/min | `429` |

**Os limites são por IP e por rota**, em janela de 60 segundos. "Dinheiro"
são as rotas que criam ou movem cobrança (`/pix`, `/cartao`, `/boleto`,
`/assinatura`, `/assinatura-pix`, `/estornar`, `/cancelar-`, `/pausar-` e
`/retomar-assinatura`); "consulta" são as de leitura (`/pedido`, `/plano`,
`/cobranca`, `/status`, `/consultar-assinatura`).

Toda resposta traz os cabeçalhos `RateLimit-Limit`, `RateLimit-Remaining`
e `RateLimit-Reset` — leia-os em vez de contar do seu lado. Se você
monitora a saúde do checkout, **espace a chamada em 2 segundos ou mais**:
o teto de 30/min existe porque essa rota toca o banco.

CPF e CNPJ dividem o mesmo campo `documento` — o checkout detecta qual é
pelo tamanho.

**Você pode mandar `documento` pontuado ou em dígitos: dá no mesmo.** O
checkout normaliza para dígitos assim que valida, e é essa forma que ele
guarda e busca. Isso importa nas rotas que localizam uma assinatura por
`planoId` + `documento` (§5.5): até 17/09/2026 assinar com
`552.085.198-01` e cancelar com `55208519801` dava `404`, porque as duas
formas viravam chaves diferentes. Não dá mais, e **você não precisa
mudar nada** — se sua integração já manda sempre a mesma forma, ela
continua funcionando igual.

### 9.0 A resposta da sua API: redirecionamento e tamanho

O checkout resolve pedido e plano ligando de volta para a **sua** API
(§1). Duas regras valem para o que ela responde, e as duas são novas:

- **Redirecionamento só na mesma origem.** `302`/`301` para outro
  caminho do mesmo `https://host:porta` é seguido normalmente (barra
  final, caminho movido). Para **outra origem**, é recusado, e o
  checkout responde `502`. O motivo não é só SSRF: a requisição leva a
  sua `X-Checkout-Key` no cabeçalho, e seguir o `Location` entregaria
  essa chave — que autoriza consulta e **estorno** — a quem respondeu
  o redirecionamento. Se a sua API mudou de endereço, **cadastre o
  endereço final** em vez de redirecionar. No máximo 3 saltos.

- **Corpo de até 1 MiB.** O checkout para de ler ao passar disso e
  responde `502`. Um pedido ou plano em JSON tem alguns KB; o teto
  existe porque um corpo sem fim derrubaria o processo e, com ele, a
  confirmação de pagamento de todos os contratantes. O `Content-Length`
  é usado só para recusar cedo — quem conta de verdade é o que chega.

### 9.1 O piso de R$ 5,00 — e por que ele não é o mesmo que o valor do pedido

A Asaas **recusa qualquer cobrança abaixo de R$ 5,00**. Medido em
17/09/2026 contra o sandbox, nos seis caminhos, com controle positivo em
R$ 5,00 exato (que passa em todos):

| caminho | R$ 2,50 | R$ 5,00 |
|---|---|---|
| `POST /v3/payments` Pix | `400` | `200` |
| `POST /v3/payments` Boleto | `400` | `200` |
| `POST /v3/payments` Cartão | `400` | `200` |
| `POST /v3/payments` "pergunte ao cliente" | `400` | `200` |
| `POST /v3/subscriptions` | `400` | `200` |
| `POST /v3/checkouts` (pop-up) | `400` | `200` |

**O piso é sobre o valor COBRADO, não sobre o valor do pedido.** Como a
taxa entra por cima (§8), um pedido de R$ 4,00 fecha em R$ 5,53 e passa;
um de R$ 2,00 fecha em R$ 3,48 e não passa. Em **assinatura** não há taxa
nossa, então o piso bate direto no `valor` do plano, **por ciclo**.

**E no cartão o piso vale POR PARCELA.** Medido no mesmo dia, e é a parte
que quase passou:

| chamada | parcela | resultado |
|---|---|---|
| `POST /v3/payments` total R$ 10,00 em 12x | R$ 0,83 | `400` |
| `POST /v3/payments` total R$ 24,00 em 12x | R$ 2,00 | `400` |
| `POST /v3/payments` total R$ 60,00 em 12x | R$ 5,00 | `200` |
| `POST /v3/checkouts` (pop-up) total R$ 24,00 em 12x | R$ 2,00 | **`200`** |

A última linha é o problema: a **sessão** da pop-up é aceita, então a
recusa só apareceria lá dentro, depois de o comprador escolher 12x e
digitar o cartão.

**O checkout não recusa por isso — ele oferta menos parcelas.** Se você
manda `parcelas: 12` num pedido cuja parcela ficaria abaixo de R$ 5,00, a
pop-up abre oferecendo o máximo que cabe (R$ 24,00 fecha em R$ 26,15 e
sai em 5x de R$ 5,23), e **a taxa
cobrada é a da faixa das parcelas ofertadas, não a da faixa pedida** —
senão o comprador pagaria a taxa de 7-12x podendo usar só 4x. Recusar a
venda seria jogar fora um pagamento que a Asaas faz sem reclamar.

**Você descobre isso na hora de abrir a tela, não no clique.** Se o
total ficar abaixo do piso:

- `GET /api/checkout/pedido/...` responde `200` com um campo novo
  `bloqueio: { codigo: "valor_abaixo_do_piso", mensagem: "…" }`, e `taxa`
  continua preenchida (o total é aquele mesmo — o que muda é que a tela
  nasce sem formulário, com o motivo escrito);
- `GET /api/checkout/plano/...` traz o mesmo objeto em `_checkout.bloqueio`;
- as rotas que criam cobrança respondem `400` com a mesma mensagem.

`bloqueio` é **campo acrescentado**, nunca renomeado: pela regra do §10,
uma integração que o ignore volta ao comportamento anterior, não a um
comportamento pior.

### 9.2 O que o telefone precisa ter

Medido contra a Asaas em 17/09/2026, 24 combinações. Três regras, e
**"dígito repetido" não é uma delas** — `11988888888` e `11911111111`
são aceitos:

1. 10 ou 11 dígitos;
2. DDD (os dois primeiros) **≥ 11** — `10`, `01` e `00` são recusados;
3. com 11 dígitos, o dígito seguinte ao DDD tem de ser **`9`**;
4. a parte depois do DDD não pode ser **um único dígito repetido** —
   `11999999999` e `1111111111` caem aqui.

O checkout **não** recusa o que a Asaas aceita: DDD que não existe no
Brasil (`20`) e prefixo de fixo que não existe (`1`, `6`) passam, porque
recusar comprador legítimo no caminho do dinheiro é pior do que aceitar
um número estranho que o provedor aprova.

---

## 10. Compatibilidade e versionamento

Todo payload traz `versao` (hoje `1`).

**O compromisso do San Checkout com você:**

- Podemos **adicionar** campos novos a qualquer momento.
- Podemos **adicionar** valores novos de `status` e de `evento`.
- **Nunca** removemos nem renomeamos um campo existente.
- **Nunca** mudamos o significado de um campo existente.
- Se algo precisar quebrar de verdade, vira `versao: 2`, e a `versao: 1`
  continua sendo enviada para quem já integrou.

**O que isso exige de você** — duas linhas de cuidado que evitam que uma
melhoria nossa derrube a sua integração:

1. **Ignore campos que você não conhece.** Nada de validar o payload com
   lista fechada de campos permitidos.
2. **Trate `status`/`evento` desconhecido como "ignore por enquanto"**,
   nunca como erro. Responda `200` do mesmo jeito.

---

## 11. Checklist de integração

**Do seu lado:**

- [ ] Expor `GET /pedido/{pedidoId}` conferindo a `X-Checkout-Key`, respondendo em até 45s
- [ ] (Se vende recorrência) expor `GET /plano/{planoId}`, mesma autenticação
- [ ] Gerar `pedidoId` **imprevisível** — UUID, hash ou token opaco
- [ ] Manter `status` atualizado (`pendente`/`pago`/`cancelado`)
- [ ] Preencher `expiraEm` se a venda tem prazo (e saber que isso desliga o boleto)
- [ ] Expor o `webhook_url` respondendo `200` rápido
- [ ] **Verificar a assinatura HMAC** de todo webhook antes de confiar nele
- [ ] Tratar o processamento do webhook como idempotente (`chargeId` + `status`)
- [ ] Ignorar campos, status e eventos desconhecidos
- [ ] Emitir a sua nota fiscal e mandar o seu e-mail ao comprador no `confirmado`
- [ ] Guardar a chave só no servidor
- [ ] Rodar a conciliação diária sobre o que ainda está pendente — seção 5.2 para pedido avulso, **seção 5.3 para assinatura**
- [ ] Mandar `pagador.documento` e `pagador.telefone` para poupar digitação
- [ ] Incluir o link de `status.html` no seu e-mail de confirmação de pedido
- [ ] (Opcional) mandar `returnUrl` no link e combinar as origens com quem administra o checkout — e **nunca** tratar a volta como prova de pagamento (seção 3.1)
- [ ] (Recorrência) se você oferece upgrade/downgrade, tratar **`plano_trocado`** (§4.3.4): ele é o ÚNICO evento de assinatura cujo `planoId` mudou, e o `planoAnterior` vem junto para você achar o próprio registro. E **avisar o assinante da mudança de preço é sua obrigação** — e-mail e aviso no site (RN-35)
- [ ] (Recorrência) creditar o ciclo tanto em **`criada`** (a **primeira** cobrança da assinatura chega com esse evento, não `cobranca_confirmada`) quanto em `cobranca_confirmada` (os ciclos seguintes) — creditar só num dos dois perde o primeiro ou todos os demais. Ver seção 4.3.4
- [ ] Ao receber `cobranca_falhou`, mandar o link `&renovar={token}` — gerando o token você mesmo (seção 7.3), nunca `&renovar=1`

**Combinado com quem administra o checkout:**

- [ ] `contratante_id`
- [ ] URL base da sua API
- [ ] `X-Checkout-Key`
- [ ] `webhook_url`
- [ ] Origens de retorno (`retornoDominios`), se a sua vitrine não estiver na mesma origem da sua API
- [ ] `wallet_id` (se for usar split)
- [ ] Métodos habilitados (e liberação do Pix Automático na Asaas, se for usar)

**Teste de ponta a ponta antes de anunciar:**

1. Criar um pedido de valor baixo e abrir o link — o resumo bate?
2. Pagar por Pix — o webhook chega assinado e válido?
3. Fechar a aba e abrir `status.html` — o QR volta?
4. Chamar `/api/checkout/cobranca/...` — o status confere?
5. Estornar — o webhook de estorno chega?
6. (Recorrência) assinar, e depois pausar, retomar e cancelar.
7. (Se usa `returnUrl`) pagar e conferir que o botão de volta aparece e leva para a sua página — e que a sua página de destino **não** dá o pedido por pago sem consultar o próprio banco.

### 11.1 A troca de sandbox para produção — o que NÃO atravessa

Se você integrou contra o sandbox da Asaas e a instalação vai virar
produção, leia isto **antes** de combinar a data da troca. Não é
configuração: é dado que deixa de existir.

**Todo identificador da Asaas é preso ao ambiente.** `pay_…`, `sub_…`,
`chk_…`, id de cliente e `walletId` de sandbox **não existem** em
produção. Não há migração, não há importação, não há equivalente: são
duas contas separadas que por acaso falam a mesma API.

Consequência prática, em ordem de quem dói mais:

| o que | acontece na troca |
|---|---|
| **Assinaturas criadas no sandbox** | param de existir. Quem estava assinado **assina de novo**, com o cartão de novo. Não há como preservar o vínculo |
| **Cobranças de teste** (Pix, boleto, cartão) | viram histórico morto. O `chargeId` não resolve mais |
| **`walletId` do split** | é outro em produção. Split configurado com o de sandbox não repassa nada |
| **Webhook da Asaas** | é outro cadastro, com outro token. O do sandbox precisa ser **desativado**, ou acumula 401 e a Asaas pausa a fila dele |

> ⚠️ **Assinatura de sandbox que sobreviver no nosso registro vira
> zumbi.** O caminho é este: `POST /cancelar-assinatura` chama a Asaas
> de produção com um id de sandbox, a Asaas devolve `404`, e a nossa
> linha que gravaria o status novo nunca roda — o registro fica
> `ativa` para sempre, incancelável pela API.
>
> Por isso os registros de teste são **apagados na troca, não depois**.
> Quem administra o checkout faz isso; do seu lado, o equivalente é não
> deixar id de sandbox no seu banco de produção.

**O que NÃO muda, e é o que permite integrar antes da troca:**

- `contratante_id`, `X-Checkout-Key`, `api_base_url` e `webhook_url`
- **A assinatura HMAC dos nossos webhooks**, que é calculada com a sua
  `X-Checkout-Key` (seção 4.3.2) — nada a ver com a chave da Asaas. A
  sua verificação continua valendo sem tocar em nada
- Os endpoints da seção 5, os campos do payload, e o vocabulário de
  status
- O formato do `pedidoId` e do `planoId`, que são **seus**

Ou seja: **o seu código não precisa mudar na troca.** O que muda é o
dado. Integre, teste e feche o seu lado no sandbox com tranquilidade —
só não conte com nenhum `sub_…` ou `pay_…` sobrevivendo à virada.

**Roteiro sugerido, para a troca não pedir retrabalho:**

1. Fechar a integração no sandbox, com o teste de ponta a ponta acima
2. Combinar a data da troca com quem administra o checkout
3. Antes da troca: parar de criar cobrança nova no sandbox
4. Na troca: registros de teste apagados dos dois lados
5. Depois da troca: **repetir o teste de ponta a ponta com valor baixo e
   dinheiro real** — é o único jeito de conferir os quatro pontos que
   mudam de ambiente (identificador de cobrança, formato do webhook,
   assinatura e mensagem de erro)
6. Reassinar quem era assinante de teste, se for para continuar

---

## 12. Referência rápida

**Rotas que VOCÊ expõe:**

| Rota | Autenticação | Seção |
|---|---|---|
| `GET {sua_base}/pedido/{pedidoId}` | `X-Checkout-Key` (confira!) | 4.1 |
| `GET {sua_base}/plano/{planoId}` | `X-Checkout-Key` (confira!) | 4.2 |
| `POST {webhook_url}` | HMAC (verifique!) | 4.3 |

**Rotas que VOCÊ chama:**

| Rota | Autenticação | Seção |
|---|---|---|
| `GET /api/checkout/cobranca/{contratanteId}/{pedidoId}` | `X-Checkout-Key` | 5.2 |
| `POST /api/checkout/consultar-assinatura` | `X-Checkout-Key` | 5.3 |
| `POST /api/checkout/estornar` | `X-Checkout-Key` | 5.4 |
| `POST /api/checkout/cancelar-assinatura` | `X-Checkout-Key` | 5.5 |
| `POST /api/checkout/pausar-assinatura` | `X-Checkout-Key` | 5.5 |
| `POST /api/checkout/retomar-assinatura` | `X-Checkout-Key` | 5.5 |
| `POST /api/checkout/trocar-plano` | `X-Checkout-Key` | 5.6 |
| `GET /api/checkout/status/{contratanteId}/{pedidoId}` | pública | 5.7 |
| `GET /api/saude` | pública | 5.8 |

**Rotas internas do checkout** — usadas pela própria tela de pagamento,
documentadas aqui só para quem for auditar o tráfego. Não as chame
diretamente:

`GET /api/checkout/pedido/…` · `GET /api/checkout/plano/…` ·
`POST /api/checkout/pix/…` · `GET /api/checkout/pix/status/…` ·
`POST /api/checkout/boleto/…` · `GET /api/checkout/boleto/status/…` ·
`POST /api/checkout/cartao/…` · `POST /api/checkout/assinatura/…` ·
`POST /api/checkout/assinatura-pix/…` ·
`GET /api/checkout/asaas-checkout/status/…` ·
`POST /api/webhooks/asaas` (recebe a Asaas) · `/api/admin/*` (painel).

**Glossário:**

| Termo | O que é |
|---|---|
| **Contratante** | Você — o projeto que usa o checkout |
| **Pedido** | Uma venda avulsa, pagamento único |
| **Plano** | A definição de uma cobrança recorrente |
| **Assinatura** | Um assinante específico ligado a um plano |
| **Cobrança** (`chargeId`) | Uma cobrança individual na Asaas. Uma assinatura gera várias ao longo do tempo |
| **Split** | Divisão automática do dinheiro, via `wallet_id` |
| **Origem** | `esquema + host + porta` de uma URL (`https://loja.com.br`) — a unidade em que o `returnUrl` é autorizado (seção 3.1) |

**Parâmetros do link de checkout:** `c` · `pedido` · `assinatura` ·
`renovar` · `returnUrl` (seções 3 e 3.1). Qualquer outro é ignorado.
| **Pull** | O modelo em que o checkout liga de volta para você em vez de guardar seus dados |

---

*San Checkout — SAN & CO. Pay Engine. Dúvida que este documento não
responde é lacuna do documento: reporte para quem administra o checkout.*
