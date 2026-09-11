# San Checkout — Plano de execução: todos os problemas e soluções

> 10/09/2026. Lista completa e ordenada do que sai desta auditoria.
> Cada item traz: o problema, a evidência, a solução, e os arquivos
> tocados (caminho completo a partir da raiz `D:\san-checkout-v2\`).
>
> **Legenda de esforço:** 🟩 pequeno (menos de uma hora) ·
> 🟨 médio (algumas horas) · 🟥 grande (um dia ou mais).

---

## Índice dos blocos

| Bloco | O que é | Itens | Quando fazer |
|---|---|---|---|
| **A** | Defeitos — segurança e dinheiro | A1–A4 | Antes de fechar a versão |
| **B** | Conjuntos incompletos — a causa raiz da Vitrina | B1–B4 | Antes de fechar a versão |
| **C** | Lacunas de produto | C1–C10 | Fecham o produto |
| **D** | Pendências que já existiam | D1–D7 | Manutenção |

---

# BLOCO A — Defeitos

## A1 · Webhook de saída sem autenticação 🔴 🟩

**Problema.** O webhook que o San Checkout envia ao contratante vai sem
nenhuma credencial. Quem descobrir a `webhook_url` de um parceiro pode
forjar `{"status": "confirmado"}` e a loja libera o pedido sem
pagamento.

**Evidência.** `src/controllers/webhookController.js`, `tentarNotificar`:
o `fetch` leva só `Content-Type: application/json`. Nenhum
`X-Checkout-Key`, nenhuma assinatura.

**Solução.** Assinar o corpo com HMAC-SHA256 usando a `api_key` que o
contratante já tem, e enviar em dois headers novos:

```
X-Checkout-Signature: sha256=<hmac do corpo cru>
X-Checkout-Timestamp: <epoch em segundos>
```

O timestamp entra no cálculo do HMAC (evita replay: o parceiro recusa
se o timestamp tiver mais de 5 minutos). Usa `crypto` nativo do Node,
sem dependência nova. Documentar a verificação no `INTEGRACAO.md` com
exemplo em Node e em PHP, porque o parceiro precisa implementar do lado
dele.

**Decisão que preciso de você:** os contratantes atuais (se já houver
algum em produção) vão precisar implementar a verificação. Como ninguém
está no ar ainda, sugiro já nascer obrigatório — sem período de
tolerância. Se preferir tolerância, eu mando os headers e deixo a
verificação como "recomendada" na doc por enquanto.

**Arquivos:** `src/controllers/webhookController.js`,
`src/utils/assinaturaWebhook.js` (novo), `INTEGRACAO.md`.

---

## A2 · Cobrança duplicada — sem idempotência 🔴 🟨

**Problema.** Recarregar a página e clicar em "Gerar Pix" de novo cria
uma **segunda cobrança na Asaas** para o mesmo pedido. Os dois QR Codes
ficam válidos. Se o comprador pagar os dois (acontece — gente paga o QR
antigo que ficou no WhatsApp), é estorno manual. Em boleto é pior: o
antigo segue pagável por dias.

**Evidência.** `src/controllers/checkoutController.js` (`gerarPix` e
`gerarBoleto`) não consultam cobrança existente antes de criar. O
índice `idx_cobrancas_pedido` em `supabase/schema.sql` é índice comum,
**não é `unique`**. O front desabilita o botão
(`public/js/modules/pixHandler.js`), mas isso só protege o duplo clique
na mesma tela — não sobrevive a um F5.

**Solução.** Antes de criar, procurar cobrança pendente do mesmo
`(contratante_id, pedido_id, metodo_pagamento)`. Se existir e ainda for
válida, **devolver a que já existe** em vez de criar outra. Para Pix,
buscar o QR de novo via `GET /v3/payments/{id}/pixQrCode`; para boleto,
devolver a `bankSlipUrl` guardada.

Isso resolve dois problemas de uma vez: mata a duplicidade **e** é
exatamente o mecanismo que faz o comprador recuperar a cobrança dele ao
voltar na página (item C1).

**Arquivos:** `src/services/cobrancaService.js` (função de busca nova),
`src/controllers/checkoutController.js`,
`src/controllers/asaasCheckoutController.js`, `supabase/schema.sql`
(índice parcial único sobre cobranças pendentes).

---

## A3 · A Asaas está notificando seus clientes finais 🟠 🟩

**Problema.** A Asaas cria 8 notificações automáticas por cliente, com
e-mail e SMS ligados por padrão. O comprador da Trimundi recebe e-mail
da *Asaas* — empresa que ele nunca ouviu falar. Quebra o whitelabel, e
SMS/voz são tarifados.

**Evidência.** `src/services/asaasService.js`, `buscarOuCriarCliente`,
cria o cliente sem `notificationDisabled`. E contradiz a decisão já
tomada no projeto de que o e-mail ao pagador é responsabilidade do
contratante (foi por isso que o `emailService.js` foi removido).

**Solução.** `notificationDisabled: true` no `POST /v3/customers`. Uma
linha.

**Cuidado.** Isso vale só para clientes criados **daqui pra frente**.
Se já existir cliente criado em sandbox ou produção, precisa de um
`PUT /v3/notifications/batch` para desligar retroativamente — me avise
se quiser que eu escreva esse script de uma vez.

**Arquivos:** `src/services/asaasService.js`.

---

## A4 · Taxas da Asaas fixas no código 🟠 🟨

**Problema.** A tabela de taxas está chumbada. No dia em que a Asaas
reajustar, ou no dia em que você negociar taxa melhor por volume, o
checkout continua cobrando o número velho do comprador e repassando o
número velho pro contratante — **silenciosamente, sem erro nenhum**.
Erra pra mais, você cobra a mais do cliente; erra pra menos, você paga a
diferença.

**Evidência.** `src/services/taxaService.js` linha 12,
`TAXA_ASAAS_POR_METODO` com valores fixos.

**Solução.** Buscar de `GET /v3/myAccount/fees` com cache diário,
mantendo a tabela atual como fallback se a chamada falhar. A tabela não
sai do código — vira rede de segurança em vez de fonte da verdade.

**Arquivos:** `src/services/asaasService.js` (função nova),
`src/services/taxaService.js`.

---

# BLOCO B — Conjuntos incompletos (a causa raiz)

> Regra que fecha esse bloco de vez: **onde a Asaas define um conjunto
> fechado de valores, o checkout conhece o conjunto inteiro — não o
> pedaço que o projeto da vez usa.**

## B1 · Faltam 3 ciclos de assinatura 🟠 🟩

**Problema.** O front conhece 4 ciclos; a Asaas aceita 7. Um plano
semanal exibe a palavra **"weekly"** em inglês pro comprador
brasileiro. É o mesmo defeito que a Vitrina já te custou, ainda vivo.

**Evidência.** `public/js/modules/assinaturaHandler.js` linha 11 tem
`MONTHLY, QUARTERLY, SEMIANNUALLY, YEARLY`. A Asaas define também
`WEEKLY, BIWEEKLY, BIMONTHLY`.

**Solução.** Completar o mapa: `WEEKLY: 'semanal'`,
`BIWEEKLY: 'quinzenal'`, `BIMONTHLY: 'bimestral'`. E validar no backend
que o ciclo recebido do contratante está no conjunto — hoje passa
direto pra Asaas e o erro só aparece lá.

**Arquivos:** `public/js/modules/assinaturaHandler.js`,
`src/controllers/asaasCheckoutController.js`, `INTEGRACAO.md` (tabela de
ciclos aceitos).

---

## B2 · Status de cobrança mapeados pela metade 🟡 🟨

**Problema.** A Asaas tem 14 status de cobrança; o checkout trata 5.
Os não mapeados caem no "ignorado silenciosamente" — o pagamento muda
de estado na Asaas e nem o checkout nem o contratante ficam sabendo.

**Evidência.** `src/controllers/webhookController.js`, as constantes
`EVENTOS_PAYMENT_*`. Os que faltam e importam:
`AWAITING_RISK_ANALYSIS`, `PAYMENT_REPROVED_BY_RISK_ANALYSIS`,
`PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`, `PAYMENT_CHARGEBACK_REQUESTED`,
`PAYMENT_RECEIVED_IN_CASH_UNDONE`.

**Solução.** Mapear os que têm significado de negócio para status que o
contratante entenda (`em_analise`, `recusado`, `chargeback`), e
documentar no `INTEGRACAO.md`. Os puramente informativos continuam
ignorados, mas de propósito e por escrito.

**Arquivos:** `src/controllers/webhookController.js`,
`src/services/cobrancaService.js`, `INTEGRACAO.md`.

---

## B3 · O contrato não exige `pedidoId` imprevisível 🟠 🟩

**Problema.** `GET /api/checkout/pedido/:contratanteId/:pedidoId` é
público por necessidade — o comprador precisa dela. Se um parceiro usar
id sequencial (`1`, `2`, `3`), qualquer um varre
`?c=parceiro&pedido=N` e vê valor, itens e os dados do pagador que
vierem pré-preenchidos.

**Evidência.** Procurei no `INTEGRACAO.md` — não há nenhuma menção a id
opaco, imprevisível ou UUID. A defesa depende do parceiro adivinhar
sozinho que precisa disso.

**Solução.** Escrever como **obrigação** no `INTEGRACAO.md`, com
exemplo do que é aceitável (UUID, hash) e do que não é (sequencial). E
uma validação de sanidade no backend: recusar `pedidoId` puramente
numérico com menos de 8 dígitos, com mensagem explicando o porquê.

**Arquivos:** `INTEGRACAO.md`, `src/services/pedidoService.js`.

---

## B4 · Não existe regra de compatibilidade escrita 🟡 🟩

**Problema.** Nada impede que uma mudança futura no payload do webhook
quebre um parceiro antigo. Com um parceiro isso é gerenciável; com
cinco, é um incidente.

**Solução.** Uma seção curta no `INTEGRACAO.md`: *"só adicionamos
campos ao payload, nunca removemos nem renomeamos; se um dia for
preciso quebrar, entra como `/v2` e o `/v1` continua funcionando"*.
Mais um campo `versao: 1` no payload do webhook, que custa nada agora e
é impossível de introduzir depois.

**Arquivos:** `INTEGRACAO.md`,
`src/controllers/webhookController.js`.

---

# BLOCO C — Lacunas de produto

## C1 · Comprador não consegue recuperar Pix ou boleto 🔴 🟨

**Problema.** Fechou a aba, o QR sumiu. Não existe nenhuma rota que
devolva uma cobrança já criada — as de status exigem o `chargeId`, que
o comprador nunca vê. O boleto vence em 3 dias e ele quer segunda via.
Hoje o único caminho é ligar pro parceiro, que liga pra você.

**Evidência.** Listei todas as rotas: não há nada entre
`/pedido/:c/:pedidoId` (que só resolve o pedido) e
`/pix/status/:chargeId` (que exige um id interno).

**Solução.** Página pública por pedido que mostra o estado atual — QR
ainda válido, linha digitável, "pago", "vencido" — e reexibe a cobrança
existente em vez de criar outra. Depende do A2 estar feito: é a mesma
consulta.

**[JULGAMENTO] É o melhor custo-benefício da lista inteira.** Transforma
cada venda em boleto de "ticket de suporte em potencial" em
"autoatendimento".

**Arquivos:** `src/controllers/pedidoController.js` (ou controller
novo), `src/routes/pedidoRoutes.js`, `public/status.html` (novo),
`public/js/status.js` (novo), `src/services/cobrancaService.js`.

---

## C2 · Contratante não tem como consultar status 🔴 🟩

**Problema.** Só existe push. O retry do webhook é 3 tentativas em
memória — se o servidor do parceiro cair 20 minutos, ou o Render
reiniciar no meio, **a notificação se perde pra sempre**. O dinheiro
entrou e o pedido nunca foi liberado, e o parceiro não tem como
descobrir sozinho nem conciliar no fim do dia.

**Evidência.** O próprio `INTEGRACAO.md` seção 4.3 admite: *"vale ter
uma forma manual de conferir isso (ex.: uma tela sua que consulta o San
Checkout por pedidoId, se algum dia precisar)"*. A doc reconhece a
lacuna e passa adiante.

**Solução.** `GET /api/checkout/cobranca/:contratanteId/:pedidoId`
autenticado por `X-Checkout-Key` — a mesma credencial que o `/estornar`
já usa. Devolve o mesmo payload do webhook.

**Arquivos:** `src/controllers/cobrancaConsultaController.js` (novo),
`src/routes/checkoutRoutes.js`, `INTEGRACAO.md`.

---

## C3 · Não dá pra trocar o cartão de uma assinatura 🟠 🟨

**Problema.** Assinante com cartão vencido **não tem como continuar
assinante** — tem que cancelar e assinar de novo, o que na prática vira
cancelamento. Para um produto B2B recorrente como a Vitrina, é perda de
receita garantida no primeiro vencimento de cartão da base.

**Evidência.** `src/services/asaasService.js` só tem
`cancelarAssinatura`. A Asaas tem `PUT /v3/subscriptions/{id}/creditCard`.

**Solução.** Endpoint novo que gera uma sessão de troca de cartão, e um
evento de webhook avisando o contratante quando a troca acontece.

**Arquivos:** `src/services/asaasService.js`,
`src/controllers/assinaturaController.js`,
`src/routes/assinaturaRoutes.js`, `INTEGRACAO.md`.

---

## C4 · Não dá pra pausar e retomar assinatura 🟡 🟩

**Problema.** Só existe cancelar, que é irreversível.

**Solução.** `PUT /v3/subscriptions/{id}` com `status: INACTIVE` para
pausar e `ACTIVE` para retomar. Sai junto com o C3, mesmo arquivo.

**Arquivos:** `src/services/asaasService.js`,
`src/controllers/assinaturaController.js`,
`src/routes/assinaturaRoutes.js`.

---

## C5 · Cartão recusado deixa o comprador na rua 🟠 🟨

**Problema.** Negou o cartão na pop-up, o comprador volta pro checkout
sem caminho nenhum. Venda que some.

**Nota honesta:** cascata de adquirentes (o que Yampi e Pagar.me vendem)
**você não consegue fazer** — precisaria ser gateway, e o cartão passa
pela pop-up da Asaas. Não recomendo perseguir isso.

**Solução (o recorte que cabe).** Detectar o retorno de recusa e
oferecer, ali mesmo: "tentar outro cartão" ou "pagar com Pix", com o
Pix já pronto num clique. Custa quase nada e recupera venda.

**Arquivos:** `public/js/modules/cartaoHandler.js`,
`public/js/app.js`, `public/index.html`.

---

## C6 · Chave de API pode expirar sem aviso 🟠 🟩

**Problema.** A Asaas expira chave de API por inatividade. Sem escutar
o evento, **a integração morre sozinha um dia** e ninguém sabe por quê.

**Solução.** Escutar `ACCESS_TOKEN_EXPIRING_SOON` e `ACCESS_TOKEN_EXPIRED`
no webhook e registrar em log de erro bem visível. Ligar os eventos no
painel da Asaas.

**Arquivos:** `src/controllers/webhookController.js` + configuração no
painel da Asaas (manual).

---

## C7 · Não sabe quando uma subconta foi aprovada 🟡 🟩

**Problema.** Você cria subcontas via API, mas a aprovação da Asaas é
conferida na mão.

**Solução.** Escutar os eventos `ACCOUNT_STATUS_*` e gravar o estado na
tabela `subcontas`, mostrando no admin como selo (a coluna e o selo já
existem no painel novo — falta o dado).

**Arquivos:** `src/controllers/webhookController.js`,
`supabase/schema.sql`, `public/js/admin.js`.

---

## C8 · Sem métricas de funil 🟡 🟨

**Problema.** Não existe registro de quem abriu o checkout e não gerou
cobrança, nem de quantos Pix gerados viraram Pix pagos. **Taxa de
pagamento do Pix gerado** é a métrica que mais diz sobre a saúde de um
checkout brasileiro, e hoje ela não existe.

**[JULGAMENTO]** Sem isso, qualquer decisão futura sobre o checkout —
inclusive quais itens desta lista priorizar — é chute.

**Solução.** Duas colunas de timestamp na tabela `cobrancas` e uma
consulta no admin. Não precisa de BI.

**Arquivos:** `supabase/schema.sql`,
`src/services/cobrancaService.js`, `src/controllers/adminController.js`,
`public/admin.html`, `public/js/admin.js`.

---

## C9 · Pix Automático 🟠 🟥

**Problema.** Assinatura só existe no cartão de crédito. Isso exclui
quem não tem cartão e sofre com a maior causa de perda silenciosa de
receita em recorrência: cartão vencido ou sem limite.

**Solução.** Integrar `/v3/pix/automatic/*` como método de assinatura
alternativo. É débito recorrente autorizado pelo banco do pagador — sem
cartão, sem chargeback, sem churn involuntário.

**[JULGAMENTO] Se fosse pra fazer um único recurso novo da lista
inteira, eu escolheria esse.** É o que mais muda o alcance do produto, e
a Asaas já entrega pronto. Como a Vitrina é produto de assinatura B2B,
provavelmente é o próximo pedido que vai chegar.

**Arquivos:** `src/services/asaasService.js`,
`src/controllers/asaasCheckoutController.js`, `supabase/schema.sql`,
frontend de assinatura, `INTEGRACAO.md`.

---

## C10 · Sem ambiente de teste para o parceiro 🟡 🟥

**Problema.** Seu produto exige que **o parceiro escreva código**. Hoje
ele só consegue testar em produção.

**Solução.** Um modo sandbox que o parceiro usa sozinho — pedido fake,
pagamento simulado, webhook disparado. Você já tem o sandbox da Asaas
embaixo; falta expor.

**Arquivos:** a definir, depende do desenho. Deixaria por último.

---

# BLOCO D — Pendências que já existiam

| # | Pendência | Onde |
|---|---|---|
| **D1** | Rodar migração da tabela `subcontas` no Supabase | `supabase/schema.sql`, final do arquivo |
| **D2** | Rodar migração da coluna `metodos_habilitados` | idem, bloco "MIGRAÇÃO v3" |
| **D3** | Contratante master + link `?pedido=master` | Decisão sua; endpoint mora no próprio Render |
| **D4** | Termos e Privacidade ainda dizem que a SAN & CO. emite nota fiscal | `public/termos.html` §15, `public/privacidade.html` §14 |
| **D5** | Ativar 2FA em Render, Cloudflare, Supabase, GitHub e Asaas | Manual, fora do código |
| **D6** | Rodar `npm audit` / ativar Dependabot | Manual |
| **D7** | Apagar arquivos órfãos (`driveService.js`, `emailService.js`, `googleDrive.js`) | Comando PowerShell no `status-atual.md` |

---

# Anexos — coisas que registrei mas NÃO são para fazer agora

**Mina terrestre documentada.** No objeto de split, a API de cobranças
usa `percentualValue` e a API de Checkout usa `percentageValue`
(escrito diferente). Hoje **não é bug** porque o código só usa
`fixedValue` nos dois caminhos — verifiquei. Mas no dia em que alguém
implementar split percentual, o campo errado vai ser ignorado em
silêncio. Fica o aviso.

**Estorno parcial** não é suportado (só tudo ou nada). A Asaas permite.
Não vi necessidade no seu fluxo — se surgir, é pequeno.

**O que decidi recomendar NÃO fazer**, registrado pra você não ser
convencido depois: upsell one-click pós-compra (joga você dentro do
escopo PCI), prova social sintética (sem base séria em checkout), timer
de escassez falso (risco de CDC art. 37 — e você já tem expiração real
pra mostrar), multimoeda, e order bump com catálogo próprio (quebra o
princípio da sua arquitetura; se um dia precisar, o parceiro devolve as
ofertas no próprio `GET /pedido/{id}`).

---

# Ordem de execução sugerida

**Etapa 1 — fecha os defeitos (tudo pequeno, menos o A2):**
A1 → A3 → A4 → A2

**Etapa 2 — mata a causa raiz da Vitrina (tudo pequeno):**
B1 → B3 → B4 → B2

**Etapa 3 — fecha o produto:**
C1 (depende do A2) → C2 → C6 → C7 → C3+C4 → C5

**Etapa 4 — quando fizer sentido comercial:**
C8 → C9 → C10

**Etapa 5 — manutenção, na sua mão:**
D1 a D7

A Etapa 1 e a Etapa 2 juntas são o que separa "um dev olha e aprova" de
"um dev olha e faz cara feia". São 8 itens e só um deles é médio.
