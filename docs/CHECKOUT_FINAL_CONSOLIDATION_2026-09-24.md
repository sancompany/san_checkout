# San Checkout — Consolidação final · 24/09/2026

> Relatório da consolidação executada em 24/09/2026 sobre a auditoria
> externa (`docs/CODEX_CHECKOUT_AUDIT_2026-09-24.md`) e a auditoria
> própria. O estado curto e retomável está em
> `docs/CHECKOUT_CONSOLIDATION_STATE.md`.

## 1. Sumário executivo

| item | estado |
|---|---|
| CRITICAL da auditoria (C-01..C-04) | **construídos, testados, na branch** |
| HIGH (H-01..H-08) | **construídos** (H-07 provado na Fase 0: HEAD = main = servido) |
| MEDIUM/LOW relevantes (M-03, M-05, M-07, M-08, M-10, L-02, L-03) | construídos; os demais decididos/declarados (seção 6) |
| Revisão adversarial da própria consolidação | 5 HIGH + 7 MEDIUM achados e **fechados** (seção 5) |
| Suítes | 57, todas verdes em Node 22 (`npm run check`) |
| Migration 0015 | **aplicada** em `zacuaroarelaqnzjjlcz` (24/09), registrada no histórico |
| Contrato v2 Checkout → contratante | documentado (`API.md`), lado MostrAí ajustado (seção 8) |
| Deploy | **no ar**: PR #42 mesclado (`899fa5f`), Northflank `deployedSHA = 899fa5f`, Pages servindo o front novo; MostrAí `main = 78235a7` deployado antes (seção 10) |
| E2E sandbox | Pix criado → pago (cash, no sandbox) → inbox `processado` → `confirmado` com carimbo → outbox `enviada` (200 do contratante de teste); 10 POST simultâneos → 1 cobrança; cotação falsa/ausente → 409; sessões de cartão e assinatura com reserva e cotação (seção 10) |
| Matriz MostrAí × Checkout | 12 planos × ciclos, promoção, parceiro, ciclo inválido, token de renovação, HMAC e `criada` v2 — tudo ok (seção 10) |
| Access | ON (nunca desligado nesta sessão; smoke na seção 10) |

## 2. Estado inicial provado (Fase 0)

Ver tabela em `docs/CHECKOUT_CONSOLIDATION_STATE.md` — repo, branch,
`origin/main = f7b1cb9`, deployedSHA Northflank = `f7b1cb9`, Pages em
`main`, 11 variáveis de ambiente (só nomes), `ASAAS_AMBIENTE=sandbox`,
migrations 0001–0014 aplicadas, Access ON em `/admin`, webhook da Asaas
`enabled`, `SEQUENTIALLY`, 61 eventos, `/api/saude` 200.

## 3. Matriz da auditoria externa (Codex) — classificação com evidência

| id | sev | veredito | evidência / o que foi feito |
|---|---|---|---|
| C-01 | CRIT | **CONFIRMED → FIXED** | receptor respondia 200 mesmo com processamento estourando. `webhook_inbox` (0015), `registrarNaInbox` antes do 200, worker 60 s, arrendamento 5 min, reprocesso admin. RN-39 |
| C-02 | CRIT | **CONFIRMED → FIXED** | valor cobrado vinha do pull no clique, não do que a tela mostrou. `cotacoes` (0015), `exigirCotacaoParaCobrar`, 409 `cotacao_alterada`, tela redesenha. RN-42, `API.md` §9.3 |
| C-03 | CRIT | **CONFIRMED → FIXED** | status regredia por evento atrasado. `transicoesFinanceiras.js`, `status_evento_em`, UPDATE condicional, também nos `CHECKOUT_*`. RN-40 |
| C-04 | CRIT | **CONFIRMED → FIXED** | pop-up criava sessão antes da linha. Reserva → sessão → completa, `externalReference = reserva-<id>`, índice único de assinatura (0015). RN-41, `tests/dez-cliques-uma-sessao.js` |
| H-01 | HIGH | **CONFIRMED → FIXED** | retry em memória. `outbox_notificacoes`, recuo 1 min…24 h, `abandonada`, reenvio admin. RN-43, `tests/outbox-sobrevive-a-reinicio.js` |
| H-02 | HIGH | **CONFIRMED → FIXED** | evento de assinatura sem ids/valor. Contrato v2: `eventoId`, `assinaturaId`, `chargeId`, `valor`, `ciclo`, `cicloCanonico`, `statusFinanceiro` |
| H-03 | HIGH | **CONFIRMED → FIXED** | estorno do acerto não avisava. `troca_revertida` |
| H-04 | HIGH | **CONFIRMED → FIXED** | parcial virava total. `estornado_parcialmente`, `valor_estornado`, `POST /estornar` com `valor`. RN-45, `CONSTRAINTS` §1.7 |
| H-05 | HIGH | **CONFIRMED → FIXED** | busca-então-cria. `clientes_asaas` com reivindicação ANTES da Asaas. RN-44, `tests/cliente-asaas-uma-vez-por-documento.js` |
| H-06 | HIGH | **CONFIRMED → FIXED** | órfão sem reconciliador. `reconciliacaoService` (5 min) + resolução por `externalReference` no webhook + reenfileiramento |
| H-07 | HIGH | **FALSE_POSITIVE (no ambiente do auditor)** | provado na Fase 0: HEAD = origin/main = deployedSHA = Pages |
| H-08 | HIGH | **CONFIRMED → FIXED** | listagem devolvia `api_key`. `mascararChave` em contratantes e subcontas. RN-46, `tests/segredo-nao-sai-do-admin.js` |
| M-01 | MED | **CONFIRMED → DECLARED** | a Asaas não assina corpo; token + idempotência por `id` na inbox + máquina de estados é o teto do provedor (`docs/pendencias.md`) |
| M-02 | MED | **ALREADY_MITIGATED** | 1 instância no Northflank (medido); limitador em memória correto para isso; `CONSTRAINTS` §2 |
| M-03 | MED | **CONFIRMED → FIXED** | checks `valor_cobrado > 0`, `parcelas 1..12`, estorno coerente (0015) |
| M-04 | MED | **CONFIRMED → FIXED** | `statusFinanceiro` canônico no contrato v2; tabela de status com `estornado_parcialmente` (`API.md` §4.3.3) |
| M-05 | MED | **CONFIRMED → FIXED** | `src/utils/dinheiro.js` (centavos) em toda comparação do caminho do dinheiro; `valorBase` arredondado |
| M-06 | MED | **PARTIAL** | `exigirIdImprevisivel` já existia; `documento` não sai em nenhuma rota pública; token opaco assinado fica para o contratante (declarado) |
| M-07 | MED | **CONFIRMED → FIXED** | aba Filas com reenfileirar/reenviar |
| M-08 | MED | **CONFIRMED → FIXED** | `corpoAsaas` só em `console.error` e nunca com dado de pessoa (a redação da auditoria já cobria); inbox por lista branca |
| M-09 | MED | **NOT REQUIRED** | painel do lojista: decisão — o contratante tem a própria tela; o Checkout expõe API e webhook |
| M-10 | MED | **CONFIRMED → FIXED** | `src/utils/ciclos.js` + `contratantes.ciclos_permitidos` (mostrai = MONTHLY/QUARTERLY/SEMIANNUALLY/YEARLY); sem default silencioso |
| L-01 | LOW | **ALREADY_FIXED** | revogação: arquivar contratante invalida a chave (11/09) |
| L-02 | LOW | **CONFIRMED → FIXED** | "vendedor" → "loja" nas duas telas |
| L-03 | LOW | **CONFIRMED → FIXED** | comentários "só Pix nesta leva", "gated no dono", "sem lista de métodos" corrigidos |
| L-04 | LOW | **CONFIRMED → FIXED** | colunas novas comentadas na 0015; `cotacao_id` nulo em linhas antigas documentado |
| L-05 | LOW | **DECLARED** | MED Pix não existe — `API.md` não declara suporte |
| L-06 | LOW | **ALREADY_FIXED** | rótulos da métrica (17/09) |
| L-07 | LOW | **DECLARED** | registro de configuração vive em `CONSTRAINTS.md` §2.2 + `RUNBOOK` §1 |

## 4. Achados próprios (Fable) — antes de construir

1. Lista branca do expurgo sem `mutation_version` — anonimização de
   assinatura cancelada falharia. **Corrigido**, com checagem derivada das migrations.
2. Total exibido era sempre o do Pix, qualquer método/parcelas. **Corrigido** pela cotação.
3. `trocando_em` ficava setado numa assinatura cancelada (arrendamento não liberado). Menor; documentado.
4. `GET /v3/webhooks` reporta `authTokenSet: false` embora o token funcione — inconclusivo, sem ação.

## 5. Revisão adversarial da consolidação (3 agentes, 24/09) — o que ela achou no meu próprio código

| # | sev | achado | correção |
|---|---|---|---|
| 1 | HIGH | recuperação de sessão perdida gravava zero linhas (`where asaas_checkout_id` nulo) e a reserva era apagada 65 min depois, paga | `vincularSessaoAReserva` por `id` |
| 2 | HIGH | qualquer primeiro `PAYMENT_*` ativava a assinatura e cancelava a antiga (renovação com cartão recusado) | ativação derivada da LINHA e só no `confirmado` |
| 3 | HIGH | `criada`/aviso perdido quando a transição gravava e a outbox falhava | "mesmo status" ainda enfileira com a chave do fato; `criada` derivado da linha |
| 4 | HIGH | Pix/Boleto com resposta perdida: `PAYMENT_CONFIRMED` consumido sem efeito | resolução por `externalReference`; reconciliador reenfileira |
| 5 | HIGH | inbox `processando` sem arrendamento | arrendamento de 5 min; worker não disputa linha nova |
| 6–12 | MED | CHECKOUT_* fora da máquina; `/estornar` sem webhook; chave que apagava fato repetido; `estorno_negado` beco; erro de ciclo engolido; PII em `externalReference` legado e outbox abandonada; worker × inline | todos corrigidos (commit `b5d8ef2`) |
| front | HIGH | 409 redesenhava só o total: parcelas cortadas viravam "—" com botão ligado | redesenho completo + botões travados sem total |
| front | MED | `escapar` sem aspas em atributos; toast duplo; polling infinito do Pix Automático; CSS 360 px | corrigidos (commit `ac2de95`) |
| test | HIGH | `buscarOuCriarCliente` reivindicava DEPOIS da Asaas (N clientes lá) — achado ao escrever o teste de concorrência | reivindicação antes; teste `cliente-asaas-uma-vez-por-documento.js` |

## 6. Decisões e declarações

Ver `docs/pendencias.md`, seção "Consolidação financeira". Em resumo:
recusa síncrona de cartão não medida; `intencoes_troca_plano` sem
expurgo próprio; `PAYMENT_DELETED` desmarcado (consequência
documentada); M-01 é teto do provedor; AUD-004 fechado por medição
(`SEQUENTIALLY`); fencing token verdadeiro declarado.

## 7. Banco

Migration 0015 aplicada em 24/09/2026 (Management API; `schema_migrations`
`20260924120000 consolidacao_financeira`). Tabelas, colunas, checks e
índice verificados por `information_schema`/`pg_constraint`. RLS ON nas
quatro tabelas novas. Ordem deliberada: migration ANTES do deploy (código
antigo ignora as tabelas; código novo sem elas quebraria o receptor).

## 8. MostrAí (lado do contratante)

Repositório `/home/user/mostrai`, mudanças compatíveis com v1 e v2:
- `chaveDoEvento`: com `eventoId`, `ultima` vem do payload (`chargeId`,
  `statusFinanceiro`, `valor`) — sem isso o v2 creditava o ciclo duas
  vezes (webhook por `eventoId` + conciliação por `chargeId|status`);
- `chargeId|status` registrado para todo evento que credita;
- `cobrancaJaRegistrada` sem a pré-condição `criada|<id>`;
- `troca_revertida`: chargeback suspende, o resto vira pendência com o
  plano anterior; `cobranca_estornada` distingue parcial/total;
- `chamarApiCheckout` com teto de 20 s;
- `montarRespostaPlano` sem `|| 'MONTHLY'`;
- `limparTrocasAbandonadas` na conciliação (linhas `pendente_troca` > 1 dia);
- `processarWebhookPedido` deduplica por `eventoId` quando vem;
- testes v2 no `dedupe-webhook.test.js` do MostrAí; o `api.md` dele atualizado.

## 9. Testes

57 suítes (`npm run check`): as 53 anteriores + `dez-cliques-uma-sessao`,
`cliente-asaas-uma-vez-por-documento`, `outbox-sobrevive-a-reinicio`
(dois processos, banco falso em arquivo — `tests/banco-falso/`),
`segredo-nao-sai-do-admin`. Autotestes novos/reescritos: webhookController
(220), transicoesFinanceiras (87), webhookInboxService (38), outboxService
(22), cotacaoService (22), reconciliacaoService (19), refundController (16),
expurgoService (71).

## 10. Deploy, validação online, Access

**Ordem deliberada:** MostrAí primeiro (com `eventoId` o MostrAí antigo
creditaria cada ciclo duas vezes), Checkout depois.

| passo | evidência |
|---|---|
| MostrAí `main` | `78235a7` (merge de `claude/checkout-contrato-v2` sobre o `a91f967` do PR #58); Northflank `mostrai` build SUCCESS, deploy COMPLETED, `deployedSHA 78235a7`; `/health` `{"ok":true}`. 397/397 testes verdes em banco local antes do push |
| Checkout PR #42 | CI `testes` verde nos 6 commits da branch; workflow Segurança: `segredos` reprovou uma vez (chave de MENTIRA `sk_…` num teste — trocada, `.gitleaksignore` para o commit histórico), depois verde; `estatica`/`dependencias` verdes; mesclado por squash em `899fa5f` |
| Checkout no ar | Northflank `san-checkout` `deployedSHA 899fa5f`, deploy COMPLETED; `/api/saude` traz `filas` e `workers` (só o código novo tem); Pages serve `api.js`/`pedidoHandler.js` novos e a linha de parcela no `index.html` |
| Migration | 0015 já estava aplicada antes do deploy — nenhuma escrita falhou (inbox/outbox/cotações/clientes gravadas ao vivo abaixo) |

**E2E no ar (sandbox Asaas, contratante `testemaster`):**

| cenário | resultado |
|---|---|
| `GET /pedido/ped_completo` | cotação com id, totais por método (pix 11,08 · boleto 11,08 · cartão 1x 10,77 · 2x com `valorParcela` 5,41), `maxParcelas 2` (piso por parcela) |
| `GET /pedido/ped_teste` (R$ 1,00) | `bloqueio valor_abaixo_do_piso`, sem cotação — correto |
| `POST /pix` com cotação falsa / sem cotação | `409 cotacao_ausente` com cotação nova no corpo |
| 10 `POST /pix` simultâneos em `ped_isento` | 1 × 200 + 9 × 409 "em andamento"; **um `chargeId` só** (`pay_kw9lv5m0x8pr6jsi`), uma linha, com `cotacao_id` |
| pagamento simulado (`receiveInCash` dentro do contêiner) | `PAYMENT_RECEIVED` → `webhook_inbox` `processado` → `cobrancas` `confirmado` com `status_evento_em`/`confirmado_em` → `outbox_notificacoes` `enviada`, HTTP 200, chave `pedido|pay_…|confirmado` |
| `POST /estornar` parcial (R$ 2,00) | Asaas recusa cobrança recebida "em dinheiro" (`400 Somente é possível estornar cobranças recebidas ou confirmadas`) — recusa limpa: arrendamento liberado, status intacto. **Estorno parcial não é mensurável ao vivo com pagamento simulado**; fica provado pelos autotestes (refundController 16, webhookController 220) |
| `POST /cartao/ped_completo` e `POST /assinatura/plano_trimestral` | sessões criadas (`asaasCheckoutId`), linhas com reserva completada, `cotacao_id` e `ciclo QUARTERLY`; `GET /plano` traz `cicloCanonico trimestral`; `consultar-assinatura` 200 (acusou `versao: 1` — corrigido em seguida, PR #43) |
| `clientes_asaas` | uma linha (hash do documento → `cus_…`) para todas as chamadas do mesmo pagador |
| quebra | sem chave → 401; JSON quebrado → 400; nome de 1 KB com `<script>` → 400; corpo de 300 KB → 413; pedido já pago → 409; contratante inexistente → 404; nada virou 500 |

**Matriz MostrAí × Checkout** (código real dos dois repos, banco local
do MostrAí com as 87 migrations): Essencial/Pro/Prime × 1/3/6/12 meses →
`MONTHLY/QUARTERLY/SEMIANNUALLY/YEARLY`, canônico
`mensal/trimestral/semestral/anual`, cobrado = valor do ciclo (99 ·
267,30 · 504,90 · 950,40 · 249 · 672,30 · 1.269,90 · 2.390,40 · 449 ·
1.212,30 · 2.289,90 · 4.310,40), todos acima do piso e permitidos; plano
de 2 meses → MostrAí responde `ciclo: null` e o Checkout recusa
(`BIMONTHLY` recusado por não estar em `ciclos_permitidos`; `trimestral`
e `6` normalizados); promoção 30 % (672,30 → 522,90) e parceiro 10 %
(→ 605,07) refletidos na cotação, promoção vencida volta ao normal;
token de renovação do MostrAí válido no Checkout (e não com outro
documento, nem `renovar=1`); HMAC do Checkout aceito pelo MostrAí (e
recusado quando errado); `criada` v2 entregue duas vezes credita **uma**
cobrança com o valor do evento, ativa a assinatura e registra
`eventoId` + `chargeId|status`.

**Access:** `checkout.sancocore.com.br/admin.html`, `/admin` e
`san-checkout.pages.dev/admin.html` → 302 para o login do Access;
`/api/admin/*` sem token → 401. ON do começo ao fim.

## 11. Bloqueadores e o que fica

Nenhum bloqueador. Fora do código, e só do dono: a troca da Asaas para
produção (hard gate) e o primeiro pagamento real. Declarado (seção 6):
estorno parcial e recusa síncrona de cartão sem medição ao vivo;
`intencoes_troca_plano` sem expurgo; `PAYMENT_DELETED`; fencing token.
Observação operacional: no teste de 10 requisições simultâneas, nove
recebem `409 "em andamento"` (a tela mostra o aviso e o pagador clica de
novo) — comportamento documentado, não erro.
