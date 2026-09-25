# 25/09/2026 — primeiro pagamento real: o Pix sem QR e a assinatura "ativa" sem débito

Os dois primeiros testes com dinheiro real em produção, feitos pelo dono
em 24/09 à noite (horário de Brasília), logo depois da troca da Asaas
para produção. **Os dois falharam, e nenhum dos dois cobrou nada**: o Pix
ficou pendente sem QR na tela; a assinatura mostrou sucesso e o cartão
não foi debitado. Investigado só com leitura antes de qualquer
correção. Nenhum dado pessoal neste arquivo: nome, CPF, e-mail e o final
do cartão do pagador estão no banco e na Asaas, não aqui.

**Estes registros são evidência de homologação e não se apagam.** A
limpeza de sandbox (`npm run limpar-teste`) recusa tudo se uma cobrança
de `ambiente = producao` cair no conjunto — e estas duas são.

## Os identificadores

| | Pix | Assinatura |
|---|---|---|
| linha local (`cobrancas.id`) | `a7854b98-48b9-4027-8935-adea63aa4fee` | `bda7f6e9-26d5-485d-8305-6353a0751782` |
| contratante / referência | `testemaster` / `ped_isento` | `testemaster` / `plano_anual` |
| ambiente gravado | `producao` | `producao` |
| id na Asaas | `pay_x9eixae4vkg6ugzg` | assinatura `sub_39mjscz7vl2jwx7g`; 1º ciclo `pay_v6f2xr6j98reaxb9` |
| sessão | — | `842e6f11-9ea5-4814-9a2e-cb1d501b85c5` |
| cotação | nenhuma gravada na linha (o fluxo parou antes) | `0ad53c36-9daa-40a8-b942-ea92e1a4e25a` (usada) |
| valor | R$ 5,00 (taxa isenta) | R$ 10,00, `YEARLY`, cartão |
| estado na Asaas (lido em 25/09) | `PENDING`, vencimento 25/09 | assinatura `ACTIVE`; 1º ciclo **`PENDING`**, vencimento **25/09**, cartão guardado |
| estado local antes do reparo | `pendente` (completada pelo reconciliador) | **`confirmado`**, `confirmado_em` preenchido, **sem `charge_id`**, **sem assinatura** em `assinaturas` |

## Linha do tempo (UTC; Brasília = UTC − 3)

| hora | o que aconteceu | evidência |
|---|---|---|
| 01:24:14 | cliente criado na Asaas de produção | `clientes_asaas` (`cus_000202637723`) |
| 01:24:15 | reserva do Pix gravada | `cobrancas.criado_em` |
| 01:24:15 | `POST /v3/payments` → **criou** `pay_x9eixae4vkg6ugzg` | Asaas: `externalReference = reserva-a7854b98…` |
| 01:24:16 | `GET /pixQrCode` → **"Você não possui uma chave Pix cadastrada para recebimentos de cobranças via Pix."** | `erros` (duas linhas) |
| 01:24:16 | resposta ao navegador: **502**, reserva mantida **sem `charge_id`** | `erros` (`checkout/pix`, 502) |
| 01:24–01:31 | clique de novo → **409 "Já existe uma cobrança sendo criada"** | relato do dono; o código só respondia isso com reserva sem `charge_id` |
| 01:26:21 | reserva da assinatura; sessão criada com `nextDueDate` **`2026-09-25 01:26:21`** | `cobrancas.criado_em`; o `CHECKOUT_PAID` devolve `nextDueDate 2026-09-25T03:00Z` |
| 01:26:34 | cartão digitado na pop-up; Asaas cria a assinatura e o **1º ciclo `PENDING` para 25/09** | Asaas |
| 01:26:38 | `SUBSCRIPTION_CREATED` chega (200) → `ignorado` | `webhook_inbox`, `webhook_eventos` |
| 01:26:44 | `CHECKOUT_PAID` chega (200) → **linha vira `confirmado`** | `webhook_inbox`, `cobrancas.confirmado_em` |
| 01:26:44+ | polling da tela lê `CHECKOUT_PAID` → **"Assinatura Ativa ✓"**, pop-up fecha | `consultarStatusCheckout` mapeava `confirmado → CHECKOUT_PAID` |
| 01:31:21 | reconciliador acha o Pix pela referência e completa a reserva (sem dado do pagador) | `erros` (`reconciliacaoService.completada`) |
| depois | conta passa a ter uma chave Pix `EVP` `ACTIVE`; o QR de `pay_x9eixae4vkg6ugzg` agora é gerado | `GET /v3/pix/addressKeys`, `GET /pixQrCode` |

Webhooks: **só os dois acima chegaram**, os dois 200, nenhum 401, nenhum
falho, nenhum em retry; `outbox_notificacoes` vazia — **nada foi avisado
ao contratante** (nem testemaster nem MostrAí, que não participou).
Nenhum `PAYMENT_*` porque nada foi pago: `PAYMENT_CREATED` não está entre
os eventos marcados, de propósito. O token do webhook está certo nos
dois lados — os dois eventos passaram pela guarda.

## Pix — onde parou

| etapa | resultado |
|---|---|
| reserva local | PASS |
| `POST /v3/payments` | PASS (criado) |
| `GET /pixQrCode` | **FAIL** — conta sem chave Pix |
| persistência do `charge_id` | **FAIL** — só 5 min depois, pelo reconciliador |
| resposta ao navegador | FAIL (502 genérico) |
| renderização | NOT REACHED |
| segundo clique | **FAIL** — 409 "sendo criada", beco sem saída |

**Causa raiz, duas camadas.** A de fora: a conta de produção não tinha
chave Pix — exigência da Asaas para gerar QR, que o sandbox não tem. A
nossa: `criarCobrancaPix` já marcava o erro com `pagamentoJaCriado` e o
`chargeId`, mas o controlador tratava isso como caso **ambíguo** e não
gravava o id — e `reaproveitarCobrancaPendente` devolvia `null` tanto
para "não existe" quanto para "existe, mas o QR falhou", então o segundo
clique ia reservar, batia na reserva e respondia 409 para sempre.

## Assinatura — o estado financeiro real

**Resposta objetiva: (B) — assinatura criada, primeira cobrança
pendente.** O cartão não foi autorizado nem capturado; não houve
`PAYMENT_CONFIRMED`, `RECEIVED`, `AWAITING_RISK_ANALYSIS` nem recusa. O
único "sucesso" foi a sessão (`CHECKOUT_PAID`).

**Causa raiz, duas camadas.**

1. **Vencimento em UTC.** `formatarDataHoraAsaas(new Date())` usava
   `getDate()/getHours()` do processo, que roda em UTC (medido em 16/09,
   `src/utils/diaCivil.js`). Às 22:26 de Brasília já era dia 25 em UTC:
   a Asaas recebeu o 1º vencimento como **amanhã**, e assinatura no
   cartão com vencimento futuro é cobrada no vencimento, não no ato. No
   sandbox nunca apareceu porque todos os testes foram de dia (UTC e
   Brasília no mesmo dia). `dataDeHoje()` (Pix, acerto de troca) e o
   vencimento do boleto tinham o mesmo defeito por `toISOString()`, sem
   dano aqui.
2. **`CHECKOUT_PAID` tratado como dinheiro.** O receptor gravava
   `confirmado` (e `confirmado_em`) no `CHECKOUT_PAID`, e a tela lia isso
   como aprovado. O contratante não foi avisado — o aviso já esperava o
   `PAYMENT_CONFIRMED` —, mas o banco, a tela e a métrica afirmavam um
   pagamento que não existia. E se o cartão fosse recusado no
   vencimento, a linha ficaria `confirmado` para sempre.

A arquitetura **já não presumia** "assinatura criada = 1º ciclo pago"
no aviso ao contratante (`criada` só sai no `PAYMENT_CONFIRMED`, e a
linha `assinaturas` só nasce aí). Presumia no status local e na tela.

## O que mudou (commit do PR deste incidente)

- **Datas para a Asaas no relógio de Brasília**: `dataHoraCivil()` e
  `hojeCivil()` (`src/utils/diaCivil.js`) no `nextDueDate`, no `dueDate`
  do Pix e do acerto, no vencimento do boleto e no início do Pix
  Automático. `tests/data-para-asaas-e-de-brasilia.js` varre `src/`
  inteiro e reprova qualquer leitura de dia/hora do relógio do processo.
- **`CHECKOUT_PAID` não muda status** (migration 0016,
  `sessao_concluida_em`): a linha segue `pendente` até o evento de
  pagamento; a tela recebe `PROCESSANDO` e diz "Pagamento em
  processamento", nunca "aprovado"; recusa virou `PAGAMENTO_RECUSADO`
  (antes a tela esperava para sempre). Sessão concluída nunca é tratada
  como reserva travada nem reaberta — o clique seguinte recebe 409
  `pagamento_em_processamento` e a tela acompanha a sessão que existe
  (senão, 65 min depois, abriria uma **segunda assinatura** no mesmo
  cartão). `CHECKOUT_EXPIRED/CANCELED` atrasado sobre sessão concluída é
  ignorado.
- **Pix com o QR falhando**: a reserva é completada com o `chargeId` e o
  pagador **na hora**; a resposta é 503 `qr_indisponivel` com o
  `chargeId`; o clique seguinte busca o QR do MESMO Pix. Reserva sem
  `charge_id` (timeout) é conferida na hora pela referência externa em
  vez de 409 até o reconciliador; sem nada na Asaas ainda, 409
  `cobranca_em_confirmacao` com texto que não parece beco sem saída.
- **Referência dos eventos**: `account` passou para o fim da prioridade
  em `extrairReferencia` — todo evento real traz `account`, e ele
  rotulava os `SUBSCRIPTION_*` como a conta, não a assinatura.
- Estrutura real do `SUBSCRIPTION_CREATED` homologada em `CONSTRAINTS.md`
  §2.2.

Regressão com os payloads reais redigidos: `webhookController.js`
(seção 16b), `checkoutController.js` (8b, 8c),
`tests/sessao-concluida-nao-e-pagamento.js`. Seis sabotagens, uma por
correção — todas reprovam.

## O reparo da linha da assinatura

`bda7f6e9` voltou de `confirmado` para `pendente`, com
`confirmado_em = null` e `sessao_concluida_em` = o instante do
`CHECKOUT_PAID` (01:26:34Z) — o estado que o código novo teria gravado.
`status_evento_em` ficou como estava (01:26:34Z), então um
`PAYMENT_CONFIRMED` de 25/09 é posterior e aplica normalmente.

## O que só o tempo (ou o dono) responde

- **O 1º ciclo da assinatura vence em 25/09 e a Asaas deve tentar o
  cartão nesse dia.** Não é medido: é o comportamento documentado de
  assinatura no cartão. Se cobrar, chega `PAYMENT_CONFIRMED` com
  `checkoutSession`, a linha vira `confirmado`, a assinatura nasce e o
  testemaster recebe `criada`. Se o dono não quiser os R$ 10,00, a
  assinatura precisa ser cancelada **antes** — decisão dele.
- **O Pix `pay_x9eixae4vkg6ugzg` continua pagável** (R$ 5,00, vence
  25/09), agora com QR. Pagar ou deixar vencer é decisão do dono.
- **A chave Pix**: existe uma `EVP` ativa na conta agora. Não se sabe
  daqui se foi criada pelo dono ou automaticamente pela Asaas.

## A lição

Sandbox não tem as exigências de conta que produção tem (chave Pix), e
um teste feito de dia não exercita o fuso. As duas coisas estavam fora
de alcance de qualquer teste em sandbox — e as duas **eram** alcançáveis
por leitura: a regra de "nunca ler dia do relógio do processo" já
existia no projeto desde 16/09, aplicada só na métrica. Regra conhecida
e aplicada num lugar só é regra que falta; agora ela é varredura.
