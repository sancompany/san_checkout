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
