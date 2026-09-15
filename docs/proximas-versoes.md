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
