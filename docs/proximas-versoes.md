# Próximas versões — San Checkout

O que foi cortado para depois. **Isto não é escopo e não autoriza
construir nada** — vira escopo só quando passar pela Estação 1 de uma
versão nova.

A diferença para o `CONSTRAINTS.md`, que é o documento vizinho: lá mora
o que **não se constrói**; aqui, o que **ainda não se construiu**.

Cada entrada tem cinco linhas, e nenhuma delas é o "como". A que
apodrece primeiro é o **por quê** — meses depois todo mundo lembra da
solução e ninguém lembra do problema, e aí se constrói a solução errada
para um problema que talvez nem exista mais.

---

## Aviso de evento do webhook por e-mail e WhatsApp

- **O quê** — mandar para fora do painel os eventos que hoje só aparecem
  na aba Webhook: evento não mapeado, erro no processamento, pico de
  tentativas recusadas.
- **Por que** — o log resolveu metade do problema. O evento não some
  mais, mas continua dependendo de alguém abrir o painel para ver. Um
  evento que avisa que o Pix Automático foi liberado, ou que o split
  travou, não pode esperar a próxima vez que alguém entrar.
- **De onde veio** — pedido do dono em 11/09/2026, na mesma conversa que
  gerou o log de auditoria. Decisão dele, explícita: **isso é papel da
  Fairy**, não de um canal de notificação próprio do checkout.
- **O que toca** — `auditoriaWebhookService.js` (um gancho de saída), e
  o contrato com a Fairy, que ainda não existe. Nada no caminho de
  cobrança.
- **Quando vale a pena** — quando a Fairy tiver canal de saída de
  verdade. Antes disso, construir aqui é criar o segundo lugar que faz a
  mesma coisa, que é exatamente o que a decisão de usar a Fairy evita.

## Tratar em código os eventos que hoje só entram no log

- **O quê** — dar comportamento a `PAYMENT_APPROVED_BY_RISK_ANALYSIS`,
  aos três de divergência de split, e a
  `PIX_AUTOMATIC_RECURRING_PAYMENT_INSTRUCTION_REFUSED`. Hoje eles são
  marcados no painel da Asaas, chegam, e param no log.
- **Por que** — todos falam de dinheiro que não chegou ao contratante, e
  hoje a descoberta depende de ele reclamar. O aprovado por antifraude
  tem um problema extra: o código mapeia a espera e a reprovação, mas
  não a aprovação — conjunto enumerado pela metade, mesmo padrão de
  `docs/erros/2026-09-10-conjunto-enumerado-pela-metade.md`. Se a
  aprovação vier seguida de `PAYMENT_CONFIRMED`, o pedido destrava
  sozinho; se não vier, fica em `em_analise` para sempre.
- **De onde veio** — auditoria do painel da Asaas em 11/09/2026, com as
  capturas de tela do dono.
- **O que toca** — o mapa de evento→status no `webhookController.js`, que
  o `API.md` publica como contrato. Caminho de dinheiro **e** contrato de
  estrutura: os dois na lista curta que exige autorização.
- **Quando vale a pena** — quando o primeiro payload real de cada um
  aparecer na aba Webhook. Antes disso qualquer tratamento é adivinhação
  sobre um formato que ninguém viu.

## Detectar que a Asaas pausou a fila do webhook

- **O quê** — perceber sozinho que a fila foi interrompida e avisar.
- **Por que** — a Asaas para a fila depois de **15 falhas consecutivas** e
  só volta com reativação manual, retendo os eventos por 14 dias
  (`CONSTRAINTS.md` §2.3). O backend roda no plano gratuito do Render,
  que hiberna. Fila pausada não gera evento: o que se vê é ausência, e
  ausência é o pior jeito de descobrir qualquer coisa. Hoje o painel
  mostra "último evento recebido há X" — isso torna a ausência visível
  para quem olha, mas não avisa ninguém.
- **De onde veio** — descoberto na documentação oficial da Asaas em
  11/09/2026, ao conferir os eventos do painel.
- **O que toca** — `/api/saude` (que o cron-job.org já consulta a cada 10
  minutos) e o resumo da aba Webhook. Nada no caminho de cobrança.
- **Quando vale a pena** — quando houver tráfego real e previsível o
  bastante para que "nenhum evento em N horas" signifique alguma coisa.
  Com o volume de hoje, qualquer limiar dispararia alarme falso.

## Eventos de funil do checkout

- **O quê** — marcar `PAYMENT_BANK_SLIP_VIEWED` e
  `PAYMENT_CHECKOUT_VIEWED`, que hoje ficam deliberadamente desmarcados.
- **Por que** — respondem uma pergunta que as métricas atuais não
  respondem: o boleto que não foi pago chegou a ser aberto? É a
  diferença entre "o comprador desistiu" e "o link nunca chegou nele".
- **De onde veio** — decisão de 11/09/2026 de deixá-los fora por serem
  alto volume e sem leitor. Com o log de auditoria, passaram a ter
  leitor; o volume continua.
- **O que toca** — só o painel da Asaas e a aba Webhook. Nenhum código,
  se a intenção for só olhar.
- **Quando vale a pena** — quando existir uma pergunta de conversão real
  para responder. Ligar antes disso enche o log com o evento mais
  frequente que existe, e o log deixa de ser legível — que é o motivo de
  `PAYMENT_SPLIT_DONE` também estar fora.

## Alerta do webhook visível no celular

- **O quê** — fazer o contador de eventos não tratados aparecer sem
  precisar rolar a navegação lateral, em tela estreita.
- **Por que** — em até 860px a navegação vira uma barra horizontal com
  rolagem, e a aba Webhook é a quarta. O contador existe para avisar; o
  aviso que precisa de rolagem para ser visto não avisa.
- **De onde veio** — teste no navegador a 400px, em 11/09/2026, ao
  construir a aba.
- **O que toca** — `public/css/admin.css` (a media query de 860px) e
  `public/admin.html`.
- **Quando vale a pena** — quando o painel passar a ser aberto do
  celular de verdade. Hoje ele é operado do computador, e a Fairy
  resolveria o mesmo problema melhor.

## Contador de tentativa por credencial, e não por IP

- **O quê** — bloquear temporariamente uma `X-Checkout-Key` (e o usuário
  do admin) depois de N tentativas erradas, contando **por credencial**,
  independente de qual endereço mandou.
- **Por que** — o limite de hoje é por IP, e quem tem mais de um IP
  multiplica o teto pelo número deles. Medido sem querer em 11/09/2026:
  doze requisições passaram por um limite de 10/min porque o proxy de
  saída alternava entre três endereços. Um /24 de qualquer nuvem
  transforma 10/min em 2.560/min, e a chave do contratante não tem
  nenhuma outra guarda além do tamanho dela. O limite por IP reduz ruído;
  ele não é guarda de força bruta (`CONSTRAINTS.md` §2.7).
- **De onde veio** — ciclo de segurança da Estação 6, em 11/09/2026.
- **O que toca** — `src/server.js` (onde os limitadores moram), a guarda
  de `X-Checkout-Key` e o `verificarAdminKey`. Precisa de estado
  compartilhado com tempo de vida — hoje não existe nada assim no
  projeto, e uma instância só do Render torna memória suficiente até
  existir uma segunda.
- **Quando vale a pena** — quando o log de rejeição (§2.5) mostrar
  tentativa real e repetida. Construir antes é escolher um limiar no
  escuro, e limiar no escuro em caminho de dinheiro trava contratante
  legítimo — que é pior que a sondagem que ele evitaria.

## Split na assinatura por Pix Automático

- **O quê** — `criarAssinaturaPixAutomatico`, em
  `src/controllers/asaasCheckoutController.js`, é a única das três rotas
  de checkout que **não monta split**. `criarCheckoutCartao` e
  `criarCheckoutAssinatura` montam. Do jeito que está, uma assinatura
  paga por Pix Automático deposita o valor inteiro na conta San & Co. e
  **o contratante não recebe nada**.
- **Por que** — é dinheiro que não chega a quem vendeu, e a descoberta
  dependeria de o contratante reclamar. É o mesmo padrão de
  `docs/erros/2026-09-10-conjunto-enumerado-pela-metade.md`: três
  caminhos que fazem a mesma coisa, dois enumerados e um esquecido.
- **De onde veio** — achado em 12/09/2026 ao remover consultas
  duplicadas do caminho do dinheiro. Nunca rodou em produção porque o
  Pix Automático não está liberado nesta conta Asaas (`CONSTRAINTS.md`
  §2.4), então não há dano acumulado.
- **O que toca** — só essa função. Mas **antes de tocar é preciso
  responder uma pergunta que não é nossa:** a API da Asaas aceita
  `split` no endpoint de autorização de recorrência do Pix Automático?
  As outras duas rotas usam `POST /v3/checkouts`, que aceita; esta usa
  outro endpoint. Corrigir sem confirmar isso é adivinhar no caminho do
  dinheiro — e o dono autorizou a correção em 12/09/2026, mas a
  autorização não substitui a documentação.
- **Quando vale a pena** — junto da liberação do Pix Automático na
  conta, que é quando o fluxo passa a poder rodar. Nem antes (não há
  como testar) nem depois (aí já teria rodado errado uma vez).

## Vínculo da cobrança na assinatura por Pix Automático

> **`ciclo` já foi corrigido separadamente, em 16/09/2026** —
> `criarAssinaturaPixAutomatico` agora grava `ciclo` na criação (igual à
> assinatura por cartão), e `processarAutorizacaoPixAutomatico` prefere
> `cobranca.ciclo` sobre o campo não confirmado do payload. Isso fechou
> a reincidência do bug do `docs/erros/2026-09-15-ciclo-de-assinatura-nao-vinha-de-webhook-nenhum.md`,
> mas **não** o furo abaixo — `charge_id`/`asaas_subscription_id`
> continuam sem vínculo, e é um furo diferente (o vínculo, não o
> ciclo). Sem dano ativo hoje pelo mesmo motivo: Pix Automático
> desligado nesta conta.

- **O quê** — `processarAutorizacaoPixAutomatico`, em
  `src/controllers/webhookController.js`, chama `upsertAssinatura` mas
  **nunca grava `asaas_subscription_id` nem `charge_id` na cobrança**. A
  linha nasce por `registrarCobrancaPendentePopup` com `charge_id` nulo,
  e a autorização faz o papel de sessão.
- **Por que** — é a MESMA classe de furo que quebrou a assinatura por
  cartão em 15/09/2026
  (`docs/erros/2026-09-15-confiei-que-o-checkout-paid-traria-o-id-do-pagamento.md`),
  por outro caminho. Consequência esperada, se rodar: os ciclos seguintes
  caem em `registrarNovoCicloAssinatura` sem cobrança-modelo e são
  descartados em silêncio — o contratante nunca recebe
  `cobranca_confirmada`, e o assinante paga sem que a conta ative.
- **De onde veio** — achado em 15/09/2026, na varredura que se seguiu à
  correção do cartão. O dono decidiu no mesmo dia deixar como
  atualização futura.
- **O que toca** — só essa função. Mas **antes de tocar é preciso medir
  o payload real**, exatamente como foi feito no cartão: onde vem o id
  do pagamento da primeira cobrança do Pix Automático, e se existe um
  ponteiro de volta para a autorização (o equivalente ao
  `payment.checkoutSession`). Escrever contra o payload imaginado foi a
  causa do bug do cartão — repetir isso aqui seria repetir o erro com
  outro nome.
- **Quando vale a pena** — junto da liberação do Pix Automático na conta
  (`CONSTRAINTS.md` §2.4), que é quando o fluxo passa a poder rodar e o
  payload passa a poder ser medido. Nem antes nem depois, pelo mesmo
  motivo do split acima.

## Modo de teste por contratante — sandbox e produção convivendo

- **O quê** — cada contratante ter o próprio ambiente (teste ou real),
  em vez de um interruptor único para a instalação inteira. Um
  contratante em teste enquanto outro fatura de verdade, e cada um com
  as próprias credenciais e os próprios links.
- **Por que** — o checkout cobra **em nome de terceiros**, e quem integra
  precisa exercitar o lado dele antes de receber dinheiro de gente real.
  Hoje `obterAmbiente()` lê `ASAAS_AMBIENTE` do processo
  (`src/config/asaas.js`), e `ASAAS_API_KEY` também é uma só: o
  ambiente é global. A consequência é uma porta que se fecha — no dia em
  que o primeiro projeto entrar em produção, não existe mais como testar
  a integração de um projeto novo sem derrubar o ambiente de quem já
  está faturando. Sobram duas saídas ruins: confiar cegamente que o
  integrador acertou de primeira, ou testar com dinheiro real. A
  primeira gera cobrança errada em cliente de terceiro; a segunda custa,
  e mascara erro de split quando o dinheiro cai na própria conta.
- **De onde veio** — percepção do dono em 14/09/2026, ao notar que a
  Asaas separa sandbox e produção exatamente pelo mesmo motivo, e que um
  motor de pagamento whitelabel herda essa necessidade dos dois lados do
  contrato, não só do nosso.
- **O que toca** — `src/config/asaas.js` (hoje o único que sabe URL e
  ambiente, e o único lugar onde a decisão é global), a chave da Asaas
  em variável de processo, a tabela `contratantes` e sua migration, o
  painel administrativo, e o `API.md`, que precisaria dizer ao
  integrador em qual ambiente ele está e como pedir a troca. Caminho de
  dinheiro e contrato de estrutura: os dois na lista curta que exige
  autorização.
- **Quando vale a pena** — **antes de o segundo contratante existir**, e
  não depois. Enquanto só há um projeto, trocar a variável ainda resolve;
  a partir do segundo, a janela fecha e a migração passa a ter de ser
  feita com um contratante em produção no ar. É a entrada deste arquivo
  com prazo de validade mais curto.

## Trocar de plano numa assinatura já ativa

- **O quê** — um caminho de "upgrade/downgrade" que leve o assinante do
  plano A para o plano B mantendo o vínculo: cobrar a diferença (ou
  creditar), e emendar os ciclos seguintes no valor novo, sem o
  assinante precisar cancelar e assinar de novo do zero.
- **Por que — e aqui eu estava errado, corrigido em 17/09/2026 por
  medição.** Esta entrada dizia que `valor` e `ciclo` são "congelados na
  criação" e que "isso não é limitação nossa: é como a assinatura existe
  na Asaas". **É falso.** Medido no sandbox, dentro do contêiner, com
  fixture descartável apagada no fim:

  | o que tentei | resposta | o `GET` de volta |
  |---|---|---|
  | `PUT {value: 35}` numa assinatura de R$ 20 (boleto) | `200` | `value: 35` |
  | `PUT {value: 42, updatePendingPayments: true}` | `200` | `value: 42` — **e a cobrança pendente já gerada passou de R$ 20 para R$ 42**, mesmo id, mesmo vencimento |
  | `PUT {cycle: QUARTERLY}` num `MONTHLY` | `200` | `cycle: QUARTERLY` |
  | **controle negativo:** `PUT {campoQueNaoExiste}` | `200`, sem erro | nada mudou |

  **Segunda rodada, no meio que importa — CARTÃO** (a primeira usou
  boleto, e o checkout assina por cartão), com as perguntas que
  faltavam:

  | tentativa | resposta | `GET` de volta |
  |---|---|---|
  | **aumentar** R$ 30 → R$ 45 | `200` | `value: 45` |
  | **diminuir** R$ 45 → R$ 12 | `200` | `value: 12` — **dá para os dois lados** |
  | **abaixo do piso**: R$ 12 → R$ 3 | **`400 invalid_value`** — "O valor mínimo para cobranças via cartão de crédito é R$ 5,00." | continuou `12` |
  | mesma coisa **na criação**, para comparar | `400`, "…via Boleto Bancário é R$ 5,00." | — |
  | `cycle: MONTHLY → YEARLY` | `200` | `cycle: YEARLY`, **`nextDueDate` NÃO se moveu** |
  | em assinatura **pausada** (`INACTIVE`) | `200` | `value: 77`, `status: INACTIVE` |
  | **a Asaas nos avisou?** | — | **nenhum evento chegou** ao nosso receptor em nenhuma das operações |

  Quatro coisas que essa rodada decide para o desenho:

  - **o piso vale na alteração também**, e a mensagem é por meio de
    pagamento — quem alterar precisa validar antes, senão a recusa
    aparece na cara do operador sem contexto;
  - **ciclo novo não move a data já marcada**: o ciclo passa a contar a
    partir dela. Quem assumir "virou anual, próxima em um ano" erra por
    onze meses;
  - **pausada aceita mudança de preço** — então "pausar, mudar, retomar"
    é uma sequência possível, e não precisa ser;
  - **silêncio total de eventos.** Isso é configuração, não
    incapacidade (`SUBSCRIPTION_*` fora dos 53, `PAYMENT_UPDATED`
    desmarcado de propósito — `CONSTRAINTS.md` §2.2), mas o efeito
    prático é o mesmo: **quem alterar precisa escrever no nosso banco na
    mesma transação**, porque nada vai contar depois.

  O controle negativo é o que dá valor aos três primeiros: a Asaas
  **ignora campo desconhecido em silêncio e responde 200**, então o
  código HTTP não prova nada — quem prova é o `GET` de volta. (E o
  avesso também: mandar `valor` em português, ou `amount`, seria aceito
  com `200` e não mudaria nada. Quem construir isto confere lendo,
  nunca pelo status.)

  Uma ressalva que a medição também dá: **`value` não está no schema
  documentado** do `PUT` (a doc lista `cycle`, `nextDueDate`,
  `billingType`, `updatePendingPayments` e outros, mas não `value`).
  Funciona, e é comportamento não documentado — portanto pode mudar sem
  aviso. Quem construir precisa de teste que pegue isso deixando de
  funcionar, senão a troca de preço falha calada.

  Então o que falta **é deste lado**: não existe rota nossa para alterar
  valor de assinante, e enquanto não existir a saída continua sendo
  cancelar e criar outra — com o assinante digitando o cartão de novo,
  perda do vínculo e uma janela sem assinatura. A infraestrutura mais
  próxima é a **renovação** (`API.md` §7.3): ela já sabe criar a nova e
  encerrar a antiga **só depois** que a nova confirma, com token HMAC
  para ninguém mexer na assinatura alheia (RN-25).

  **E com o `PUT` na mesa, a coreografia mais simples deixa de ser essa:**
  alterar a assinatura existente não pede cartão de novo, não perde
  vínculo e não tem janela morta. O que ela pede é o cálculo do meio
  (proporcional do que já foi pago) e uma decisão de produto — mudar o
  valor que um cartão salvo vai cobrar exige **concordância do
  assinante** (CDC), então "tecnicamente possível" não quer dizer "pode
  cobrar diferente sem avisar". Isso é decisão do dono, não minha.
- **De onde veio** — o dono, em 16/09/2026, perguntando se o checkout já
  atendia as duas aplicações que o MostrAí vai ter: cancelar plano e
  trocar plano. **Cancelar já está pronto** (§7.4, exercitado ao vivo).
  Trocar, não. Decisão dele na mesma conversa: **o MostrAí segue pela
  ideia do pedido avulso** — cobra a diferença como pedido comum e
  resolve o resto do lado dele. Então isto não bloqueia ninguém hoje, e
  é justamente por isso que fica aqui e não em `docs/pendencias.md`.

  **Essa decisão foi tomada sobre uma premissa minha que era falsa**, e
  ele merece saber: eu disse que a Asaas não permitia alterar valor, e
  ela permite. Em 17/09/2026 ele perguntou justamente isso — "não é
  possível fazer uma alteração de preço nos planos já contratados?" —, a
  medição acima é a resposta, e **a decisão de seguir pelo pedido avulso
  volta a ser dele**, agora com o fato certo na mesa. Pode continuar
  valendo (o avulso é mais simples e não constrói cálculo proporcional
  para dois casos por mês); o que não pode é continuar valendo por um
  motivo que não existe.
- **A regra de proporcional que o dono descreveu em 17/09/2026, e a
  matemática que ela exige.** Ele enunciou assim: *na troca para plano
  mais caro, cobra agora só a diferença até o vencimento do plano atual;
  na troca para mais barato, não devolve nada — espera o fim do período
  pago e passa a cobrar o preço novo a partir dali.* É o modelo padrão
  de SaaS (proporcional na subida, rebaixamento no fim do período), e é
  defensável. O que falta é a aritmética, e ela **não é "a diferença
  entre os planos"** quando os ciclos são diferentes.

  **Primeiro, o que a Asaas NÃO faz** (medido em 17/09): ela não tem
  proporcional nenhum. `updatePendingPayments: true` põe na cobrança
  pendente o valor novo **cheio**, não um rateio (R$ 20 → R$ 42 na
  medição). Então o "acerto" é sempre **uma cobrança avulsa nossa**
  (seção 4.1 do `API.md`), calculada por nós.

  **A fórmula que sobrevive a ciclos diferentes** — proporcionaliza os
  dois lados, e não a diferença:

  ```
  dias_restantes  = vencimento_atual − hoje
  credito         = valor_PAGO_do_periodo × (dias_restantes ÷ dias_do_ciclo_atual)
  debito          = valor_do_plano_novo  × (dias_restantes ÷ dias_do_ciclo_novo)
  acerto_agora    = debito − credito        (se ≤ 0, não cobra e não devolve)
  ```

  O crédito sai do valor **pago**, não do valor atual da assinatura —
  senão dá para alterar o valor antes de trocar e farmar crédito.

  **Três exemplos, com 15 dias restantes de um mensal de R$ 100 (ciclo
  de 30 dias):**

  | troca para | crédito | débito | cobra agora | no vencimento |
  |---|---|---|---|---|
  | mensal R$ 160 | 100 × 15/30 = **50** | 160 × 15/30 = **80** | **R$ 30** | R$ 160, mensal |
  | trimestral R$ 270 (R$ 90/mês) | **50** | 270 × 15/90 = **45** | **nada** (−5) | R$ 270, trimestral |
  | anual R$ 2.400 (R$ 200/mês) | **50** | 2400 × 15/360 = **100,00** | **R$ 50,00** | R$ 2.400, anual |

  A linha do meio é o motivo de a fórmula ser essa: "diferença entre os
  planos" daria R$ 270 − R$ 100 = **R$ 170 cobrados por 15 dias** de um
  plano que custa R$ 90/mês. Absurdo, e é o erro natural de quem escreve
  a regra de cabeça. Um trimestral mais caro no total pode ser **mais
  barato por dia** — e aí a troca é um upgrade de compromisso, não de
  preço, e não gera acerto.

  **A data não se move, e isso é medido:** trocar o `cycle` **não altera
  o `nextDueDate`**. Então o desenho natural é *alinhar no vencimento que
  já existe*: o acerto cobre os dias restantes, e na data que já era do
  assinante entra o plano novo inteiro, com o ciclo novo contando dali.
  Nenhuma data muda, nenhuma cobrança é perdida.

  **O rebaixamento é o caso fácil, e sai quase de graça:** um `PUT` com o
  valor menor, **sem** `updatePendingPayments`. Medido: a cobrança
  pendente já gerada fica no valor antigo, e a assinatura passa a cobrar
  o valor novo no ciclo seguinte. É exatamente "espera o fim e cobra
  menos", sem código de proporcional e sem devolução.

  **As sete decisões que a regra não respondia, e nenhuma era técnica.**
  ⚠️ **As sete foram respondidas pelo dono em 17/09/2026**, e a resposta
  de cada uma está escrita no cabeçalho de
  `src/services/proporcionalService.js` — que é o código que faz a
  conta, e por isso é a fonte, não esta lista. Ficam aqui porque a
  pergunta explica a resposta:

  1. **Acerto abaixo do piso de R$ 5,00.** A Asaas recusa a cobrança
     (medido: `400 invalid_value`). Absorve e sobe só no vencimento?
     Arredonda para R$ 5,00? Acumula? *Sugestão: absorver — nunca cobrar
     mais do que o devido, e a perda é de centavos.*
  2. **Acerto negativo** (o caso do trimestral acima). Pela regra dele,
     não devolve — então não cobra nada e segue. Confirmar que é isso.
  3. **Assinante com cobrança pendente não paga.** Não existe crédito de
     período que não foi pago. *Sugestão: recusar a troca até resolver.*
  4. **Duas trocas no mesmo período.** O crédito da segunda é do que foi
     pago no período, já descontado o acerto da primeira — ou cada troca
     recalcula do zero? Sem regra, dá para ganhar crédito trocando.
  5. **Base de dias.** Mês comercial de 30 e ano de 365, ou os dias
     reais do calendário entre vencimentos? Muda centavos, e muda o que
     o cliente confere na mão.
     → **Respondida em 17/09/2026: mês comercial de 30 dias**, e por
     consequência ano de **360** (não 365 — 12 × 30). É por isso que a
     linha do anual na tabela acima dá R$ 50,00 e não R$ 48,63: a
     primeira versão desta tabela dividia por 365 e contradizia a
     decisão. Quem manda é `src/services/proporcionalService.js`.
  6. **O acerto estornado.** Ele é pedido avulso: se for estornado ou
     contestado, a troca já aconteceu. Reverte o plano? Mantém?
  7. **Consentimento (CDC).** Upgrade pedido pelo assinante é
     consentimento dele. **Aumento que ele não pediu não é** — e aí o
     caminho honesto é cancelar e assinar de novo, onde ele autoriza o
     valor novo ao pagar.

  ⚠️ **Autorizado a construir NESTA versão, por decisão do dono em
  17/09/2026** ("isso eu estou falando pra fazer nessa mesmo"), depois de
  responder as sete. Esta entrada deixou de ser "próxima versão" —
  enquanto estava sendo construída, o trabalho ficou em
  `docs/pendencias.md`; construída, quem manda é `API.md` (a rota) e
  `docs/funcional.md` (as regras). O que sobrar aqui é histórico de como
  a decisão foi tomada, não descrição do sistema.

- **As duas coreografias possíveis, agora que o `PUT` está medido.** A
  escolha é de produto, não técnica, e as duas exigem autorização
  (caminho de dinheiro):

  **A · Alterar a assinatura existente** (`PUT` com `value` e, se o
  plano de destino tiver outro, `cycle`).
  - *Ganha:* o assinante **não digita o cartão de novo**, o vínculo
    continua o mesmo, não existe janela sem assinatura, e o histórico
    fica numa linha só.
  - *Exige:* validar o piso de R$ 5,00 antes de mandar (a Asaas recusa
    com `400`); decidir se a cobrança pendente muda junto
    (`updatePendingPayments`); **escrever `valor`, `ciclo` e o plano
    novo no nosso banco na mesma operação**, porque nenhum evento vai
    contar depois; e saber que `nextDueDate` não se move — o preço novo
    vale da próxima data em diante.
  - *Cuidado de produto, não de código:* mudar o valor que um cartão
    salvo vai cobrar exige **concordância do assinante** (CDC). Um
    upgrade que ele pediu é uma coisa; um aumento que ele não pediu é
    outra, e a segunda não se resolve com API.

  **B · Cancelar e criar outra**, a coreografia que a renovação já sabe
  fazer (`API.md` §7.3): cria a nova e encerra a antiga **só depois** da
  nova confirmar, com token HMAC para ninguém mexer na assinatura alheia
  (RN-25).
  - *Ganha:* nada de novo para construir na Asaas, e o assinante
    **autoriza explicitamente** o valor novo ao pagar.
  - *Custa:* cartão digitado de novo, vínculo antigo morto, e a janela
    entre as duas.

  Com o `PUT` na mesa, **A** é o caminho mais simples para
  upgrade/downgrade pedido pelo assinante, e **B** continua sendo o
  caminho honesto quando o preço sobe sem ele ter pedido. Não é ou-ou.

- **O que toca** — `asaasCheckoutController.js` (a mesma porta da
  renovação), `tokenRenovacao.js` (o token precisaria carregar o plano
  de DESTINO, não só o de origem, senão um token de renovação vira um
  token de troca), `encerrarAssinaturaSubstituida`, a tabela
  `assinaturas` (de qual plano veio, e `valor`/`ciclo` reescritos), uma
  função nova em `asaasService.js` para o `PUT` (hoje o único `PUT` que
  existe é o de pausar/retomar), e o cálculo proporcional, que hoje não
  existe em lugar nenhum do sistema. Caminho de dinheiro: exige
  autorização.
- **Quando vale a pena** — quando algum contratante tiver assinantes
  suficientes para a troca ser rotina, e não exceção que se resolve na
  mão. Antes disso, o pedido avulso que o MostrAí escolheu é mais
  simples e não constrói cálculo proporcional para dois casos por mês.

## Converter o registro da conta Asaas para CNPJ, e ligar o split

- **O quê** — pedir ao suporte da Asaas a conversão do **registro** da
  conta-mãe de pessoa física para pessoa jurídica, e a partir daí criar
  subconta por contratante e ligar o `split` nas cobranças.
- **Por que** — hoje **100% de toda cobrança cai na conta-mãe** e o
  repasse ao contratante é manual, por fora do sistema. Funciona com um
  contratante e alguém olhando; deixa de funcionar quando o volume
  crescer ou o segundo contratante existir, porque o repasse manual erra
  em silêncio e ninguém confere transferência que não foi feita. O
  `split` existe exatamente para o dinheiro do terceiro nunca passar
  pela nossa mão.
- **De onde veio** — 17/09/2026. A criação de subconta devolvia 403, e a
  medição mostrou a causa: `/v3/myAccount` reporta a conta como `FISICA`
  (CPF) enquanto `/v3/myAccount/commercialInfo` reporta `JURIDICA`
  (CNPJ) — a regra de subconta olha o registro, e preencher o CNPJ no
  comercial não converte a conta. Decisão do dono no mesmo dia: operar
  na conta como está e deixar o jurídico de lado por agora.
- **O que toca** — nada de código: `criarSubconta`, a tabela `subcontas`,
  a tela do painel e o `split` em `asaasService` **já existem e já
  funcionam**; estão sem uso porque a conta não permite. O que toca é o
  cadastro da conta na Asaas, por ambiente (a de produção precisa ser
  conferida em `/v3/myAccount` separadamente), e depois preencher o
  `wallet_id` de cada contratante.
- **Quando vale a pena** — **no segundo contratante, ou no primeiro mês
  em que o repasse manual passar de um punhado de transferências.** Antes
  disso, converter registro de conta de pagamento no meio de uma
  integração em andamento troca um custo conhecido (repasse na mão) por
  um desconhecido.

---

## Dois monitores de queda — a receita pronta, se a decisão mudar

- **O quê** — um monitor externo (pega queda total da plataforma) e um
  interno no Northflank (pega app caído, OOM, deploy ruim e o `503` do
  banco fora). O sinal já existe: `/api/saude` → `200 ok` /
  `503 degradado` / sem resposta.
- **Por que está aqui, e não no `RUNBOOK`** — este texto era um plano de
  14/09/2026 que a decisão de 17/09 substituiu: **o canal de alerta é o
  e-mail de falha da Asaas**. O plano ficou ~30 linhas no `RUNBOOK` §2,
  em modo "faça assim", como se os monitores existissem — e foi o teste
  da pessoa número dois que apontou a contradição com a §6.3, que diz o
  contrário. Plano superado dentro do manual de operação engana; aqui,
  não.
- **O que a decisão de 17/09 aceita como custo** — o e-mail da Asaas
  depende de **algum evento acontecer**. Silêncio total (app fora do ar,
  sem cobrança e sem mexida na conta) não gera aviso.
- **Quando vale a pena** — quando houver tráfego real, porque aí o
  silêncio passa a ser anormal e detectável.

**A receita, como estava escrita e medida em 14/09:**

*Interno — Northflank* (`app.northflank.com/s/account/integrations/notifications`):
1. Integração: Create → Slack ou Discord → autorizar → escolher o canal
   (push no celular). Em "handle events only from specific projects",
   marcar `san-checkout`.
2. Infrastructure alerts: ligar container crashed / high CPU / high
   memory / volume low, roteadas para a integração.
3. Cron Job para o banco fora (o `503`, que o infra alert não vê):
   projeto `san-checkout` → Jobs → Create → Cron.
   - schedule `*/5 * * * *` · plano `nf-compute-10` · concurrency Forbid
   - imagem `curlimages/curl:latest`
   - secret do job `ALERTA_WEBHOOK` = URL do webhook do canal
   - comando (Discord usa `content`, Slack usa `text`):
     `sh -c 'curl -fsS -o /dev/null https://api.sancocore.com.br/api/saude || curl -fsS -X POST -H "Content-Type: application/json" -d "{\"content\":\"San Checkout: /api/saude nao-2xx\"}" "$ALERTA_WEBHOOK"'`
   - o `-f` faz o curl sair !=0 em HTTP ≥400, então o `503` dispara o
     POST; no caminho feliz o job sai 0, sem ruído.

*Externo — UptimeRobot:* conta grátis → Add New Monitor → HTTP(s) →
`https://api.sancocore.com.br/api/saude`, intervalo 5 min; **keyword
monitor** alertando quando **faltar** `"status":"ok"` no corpo (pega
503, degradado e fora-do-ar de uma vez); Alert Contacts com e-mail e o
app no celular.

**Ponto cego que sobraria mesmo com os dois:** "fila do webhook
pausada". Hoje, com volume zero, qualquer limiar de silêncio dá alarme
falso — ver a entrada própria neste arquivo.

---

## Alerta de orçamento nas contas pagas

- **O quê** — ligar o aviso de gasto em cada uma das três contas pagas
  (Northflank, Supabase, e o domínio/Cloudflare), com um teto e um
  e-mail de destino.
- **Por quê** — hoje a primeira notícia de um gasto fora do normal é a
  fatura. Um laço acidental, um pico de tráfego ou um plano que sobe de
  faixa aparecem com um mês de atraso, e não existe nenhum sinal antes
  disso.
- **O que NÃO é** — não é controle de custo nem otimização de plano. É
  só um aviso; quem decide o que fazer com ele é o dono.
- **Por que foi cortado** — decisão do dono em 17/09/2026. O gasto de
  hoje é baixo e previsível, e o checkout ainda não move dinheiro real:
  o risco que o alerta cobre não chegou.
- **Quando vale a pena** — quando houver tráfego real, ou quando
  qualquer uma das três contas sair do plano em que está hoje.

---

## Cópia periódica do banco fora do provedor

- **O quê** — uma cópia do Postgres do Supabase guardada em outro lugar
  que não o Supabase, gerada sozinha e com prazo de guarda.
- **Por quê** — a Lei 6 pede cópia **fora do provedor**, e a razão é o
  caso em que o provedor é o problema: conta suspensa, projeto apagado
  por engano, região fora do ar. O ensaio de restauração de 17/09
  (`npm run ensaio-restauracao`, RTO 1 s, zero divergência) prova que
  **sabemos restaurar** — ele não prova que teremos de onde.
- **O que NÃO é** — não é o ensaio de restauração, que já existe e
  continua rodando. E não é o backup do próprio Supabase, que é a
  mesma conta: se ela cair, ele cai junto.
- **Por que foi cortado** — decisão do dono em 17/09/2026: **a Asaas é a
  cópia.** Todo dado de cobrança e de assinatura que importa existe
  também lá, e a conciliação já sabe reconstruir status, ciclo e próxima
  cobrança a partir dela (`API.md` §5.2 e §5.3) — o que foi exercitado
  ao vivo, reparando três linhas erradas em 16/09.
- **O que essa escolha NÃO cobre, e fica escrito para não se descobrir
  na hora errada** — a Asaas não guarda o que é só nosso: o cadastro de
  contratantes (inclusive `api_key`, `webhook_url` e os domínios de
  retorno), o log de auditoria do webhook, a captura de erro, e o
  vínculo entre a cobrança na Asaas e o `pedidoId` do contratante. Perder
  o banco significa recadastrar contratante e perder a conciliação com o
  lado do lojista, mesmo com a Asaas inteira.
- **Quando vale a pena** — no primeiro dinheiro real, ou no segundo
  contratante — o que vier primeiro. A partir daí, recadastrar à mão
  deixa de ser uma tarde de trabalho.
