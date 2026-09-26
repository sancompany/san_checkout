# Estação 6 — remediação final, hardening, validação de produção e convergência

**Data:** 2026-09-25
**Entradas (não alteradas):** `docs/SECURITY_STATION_6_BASELINE_2026-09-25.md` (baseline do Claude, commit `5ff3e93`) e `docs/SECURITY_STATION_6_JULES_REVIEW_2026-09-25.md` (revisão independente do Jules, PR #49, mesclada sem alteração em `17c3ef6`).
**Estado deste documento:** o ledger (§2) foi escrito **antes de qualquer alteração de código** desta rodada. As seções seguintes são preenchidas conforme a rodada avança; nenhuma delas afirma o que não foi medido.

---

## 1. Snapshot antes

| Item | Valor | Como |
|---|---|---|
| Momento | 2026-09-25T06:19:49Z | `date -u` |
| `main` | `43635c46875ea5655402bbec37a5f2fd0317ff54` (PR #48) | `git fetch` |
| Branch de trabalho | `claude/nifty-meitner-4ffp9s` em `17c3ef6` = `main` + 2 commits **só de documentação** (baseline `5ff3e93` e merge do relatório do Jules) | `git log` |
| Backend servido | `43635c4`, deploy `COMPLETED` (Northflank, 1 instância) | `northflank get service` |
| Frontend servido | `43635c4`, Pages produção `success` | API da Cloudflare |
| Saúde | `/api/saude` 200 `ok`; Supabase respondendo; `alertasChaveAsaas: []`; inbox 0/0; outbox 0/0; os 5 workers com carimbo do último minuto (reconciliador, dos últimos 5) | produção |
| Migrations | 17 arquivos, 18 linhas no histórico do Supabase (a 0010 em duas) | catálogo |
| Cobranças em produção | 4: `ped_isento` Pix `confirmado`; assinatura `pendente` com sessão concluída e sem `charge_id` (1º ciclo aguardando); `ped_dez_boleto` boleto `pendente` (aguardando compensação); `ped_dez_cartao` cartão `confirmado` | banco, só leitura |
| Drift código × produção | **nenhum** (backend e frontend = `main`) | comparação dos SHAs |

As duas cobranças vivas (boleto e assinatura) **não são manipuladas nesta rodada**. Se mudarem de estado sozinhas, isso é registrado na §11 com a cadeia do evento.

---

## 2. Ledger unificado de achados

Legenda de status final: **FIXED** · **FALSE_POSITIVE** · **DUPLICATE** · **RISK_ACCEPTED** · **EXTERNAL_PENDING**. Na criação do ledger, todo item estava em **TRIAGEM**, com o alvo provável anotado; a coluna "Status final" só é preenchida com evidência.

Severidade "atual" = a maior entre a baseline, o Jules e a triagem desta rodada, a menos que a triagem prove que ela é menor (e aí a prova vai na nota).

### 2.1 Achados da baseline (SEC-001…SEC-034)

| ID | Origem | Sev. orig. | Sev. atual | Componente | Classe | Causa raiz | Alcançável | Impacto | Evidência | Triagem (antes do código) | Status final |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SEC-001 | Claude + Jules (EXPANDIDO) | HIGH | HIGH | `pedidoService.resolverPedido`/`resolverPlano` | CR-01 | id cru interpolado em URL de saída; Express decodifica `%2F`/`%3F` e `URL` normaliza `..` | sim, anônimo | proxy autenticado de GET na API do contratante | reprodução local (baseline §7) | alvo FIXED | **FIXED** `a5d552e` — guarda canônica em toda fronteira; 2177 checagens; 10/10 sabotagens |
| SEC-002 | Claude + Jules | HIGH | HIGH | `refundController.estornar` | CR-02 | estorno sem identidade durável; repetição sequencial indistinguível de 2º parcial | sim, contratante | devolução em dobro | código + `API.md` §5.4 manda repetir | alvo FIXED | **FIXED** `69b5228` + C1-04 — estorno como operação durável (migration 0018); 108 checagens |
| SEC-003 | Claude + Jules | MEDIUM | MEDIUM | `pedidoService` + `cobrancas.pedido_id` | CR-01 | mesma chave lógica com duas grafias | sim, link adulterado | pagamento duplicado sem detecção | normalização local | alvo FIXED (mesma raiz da SEC-001) | **FIXED** `a5d552e` (mesma raiz da SEC-001) |
| SEC-004 | Claude + Jules | MEDIUM | MEDIUM | `checkoutController.gerarPix`/`gerarBoleto` | CR-03 | reaproveita instrumento antes da guarda de pedido pago e da cotação | sim, API direta | irmã obsoleta entregue; preço ≠ exibido | código (linhas 267/272/380) | alvo FIXED | **FIXED** `d651f62` — reaproveita só se ainda é o instrumento do pedido, pelo preço da tela |
| SEC-005 | Claude | MEDIUM | MEDIUM | `cobrancaService.buscarCobrancaPorPedido` | CR-03 | "a cobrança do pedido" = a mais recente | sim | status/estorno errados | código | alvo FIXED | **FIXED** `d651f62`/`69b5228` — linha representativa: paga › pendente vigente › mais recente |
| SEC-006 | Claude + Jules | MEDIUM | **HIGH** (Jules) | `outboxService.entregar` | CR-04 | `fetch` segue redirect; destino não revalidado no envio | sim, contratante hostil | POST assinado com CPF para rede interna; entrega contada | reprodução local | alvo FIXED | **FIXED** `c8f4e20` — saída nunca segue redirect; destino revalidado no envio |
| SEC-007 | Claude + Jules | MEDIUM | **HIGH** (Jules) | `webhookController` | CR-05 | transição autoritativa aceita do corpo do evento | com o token vazado | confirmação forjada; estado congelado por carimbo futuro | código | alvo FIXED (reconsulta no provedor) | **FIXED** `af6f597` — todo `PAYMENT_*` confere `GET /v3/payments/{id}`; vínculo e valor vêm da Asaas |
| SEC-008 | Claude + Jules | MEDIUM | MEDIUM | `webhookController` | CR-05 | "estado anterior ainda não chegou" tratado como descartável | sim, falha transitória | divergência silenciosa | código | alvo FIXED | **FIXED** `af6f597` — transição que ainda não se aplica LANÇA e a inbox reaplica |
| SEC-009 | Claude + Jules | MEDIUM | MEDIUM | `trocaExecucaoService`/`trocaSweeperService` | CR-02 | `PROCESSING_PAYMENT` gravado antes de cobrar; sweeper ignora sem `charge_id` | sim, crash/deploy | cobrado sem trocar o plano | código + comentário falso | alvo FIXED | **FIXED** `5475d69` — sweeper procura o acerto pela referência `troca:<id>` |
| SEC-010 | Claude | MEDIUM | MEDIUM | `trocaExecucaoService`/`trocaPlanoController` | CR-02 | arrendamento liberado em falha ambígua; sem unicidade de intenção aberta | provável | acerto cobrado duas vezes | código | alvo FIXED | **FIXED** `5475d69` — migration 0019 (uma troca em voo); arrendamento não volta em falha ambígua |
| SEC-011 | Claude | MEDIUM | MEDIUM | `webhookController` (assinatura) | CR-08 | assinatura só vinculada no 1º `confirmado`; ciclo de assinatura desconhecida descartado | depende da Asaas | recorrência sem registro | código | a triar: parte FIXED (não descartar calado), parte EXTERNAL_PENDING (comportamento da Asaas) | **FIXED** `5475d69` (vínculo no 1º evento; recusa do 1º ciclo chama humano). O comportamento da Asaas depois da recusa segue não medido → §14 RES-04 |
| SEC-012 | Claude | MEDIUM | MEDIUM | `asaasCheckoutController.criarCheckoutAssinatura` | CR-08 | unicidade só para `pendente` | sim | duas assinaturas no mesmo cartão | código | alvo FIXED | **FIXED** `5475d69` — `409 assinatura_ja_existe` |
| SEC-013 | Claude + Jules (como "SEC-012/SEC-016") | MEDIUM | MEDIUM | `assinaturaController:133`, `trocaPlanoController:364`, `trocaExecucaoService:177` | CR-06 | promessa sem dono + `unhandledRejection → exit(1)` | sim, falha de banco | processo derrubado; aviso perdido | código + comentário falso em `server.js` | alvo FIXED | **FIXED** `5475d69` + C1-01 (a classe estendida aos handlers do Express) |
| SEC-014 | Claude | MEDIUM | MEDIUM | `assinaturaService.upsertAssinatura` e vínculos | CR-06 | erro engolido; "primeira confirmação" decidida por estado já gravado | provável | assinatura órfã, 404 enquanto cobra | código | alvo FIXED | **FIXED** `5475d69` + C1-03 (a refeitura da renovação ainda encerra a antiga) |
| SEC-015 | Claude | MEDIUM | MEDIUM | `/api/admin/*` | CR-09 | Access só no HTML; API alcançável pelo hostname e pela origem; sem 2FA nem trilha | sim | admin depende só de senha | medição ao vivo (baseline) | a triar: medir de novo; alvo FIXED ou exceção com compensação | **FIXED** `8be71d3` — JWT do Access conferido na origem + Pages Function; login real do operador feito pelo dono em 26/09/2026 (EP-01 fechado) |
| SEC-016 | Claude | MEDIUM | MEDIUM | `adminController.criarSubconta`/`atualizarLinkAtivacaoSubconta` | CR-09 | segredo logado; `select('*')` devolvido | condicional (subconta bloqueada na conta PF) | segredo no log/UI | código | alvo FIXED | **FIXED** `8be71d3` — nem log nem resposta levam a chave da subconta |
| SEC-017 | Claude + Jules (EXPANDIDO) | LOW | LOW | `asaasService.consultarStatus` via `/pix|boleto/status/:chargeId` | CR-01 | id público cru no caminho da Asaas | sim, anônimo | oráculo de status; cota | ao vivo (baseline) | alvo FIXED | **FIXED** `a5d552e` |
| SEC-018 | Claude | MEDIUM | MEDIUM | cartão parcelado | CR-05 | semântica da Asaas desconhecida | não medido | estorno/chargeback parcial | — | provável EXTERNAL_PENDING (exige medição com dinheiro ou sandbox parcelado) | **EXTERNAL_PENDING** EP-03 — guarda `409 estorno_de_parcelamento` no ar desde `8be71d3`; a semântica de estorno de parcela da Asaas exige medição em sandbox parcelado (sem chave de sandbox nesta sessão). Produção sem compra parcelada |
| SEC-019 | Claude | MEDIUM | MEDIUM | `transicoesFinanceiras` (chargeback) | CR-05 | `chargeback → confirmado` por qualquer confirmação mais nova | não medido | acesso restaurado durante disputa | código | alvo FIXED (sair de chargeback só por evento de disputa) | **FIXED** `af6f597` — sair de chargeback só por evento de disputa |
| SEC-020 | Claude | MEDIUM | MEDIUM (latente) | Pix Automático | CR-05 | `ACTIVATED → confirmado` sem dinheiro; sem CAS | não (desligado) | — | `CONSTRAINTS.md` §2.4 | a triar: FIXED se barato, senão RISK_ACCEPTED com trava | **FIXED** `8be71d3` + C1-09 (CAS e refeitura idempotente). A semântica "autorização = confirmado" é RES-02 (método desligado) |
| SEC-021 | Claude | LOW | LOW | `alvoDeRede.js` | CR-04 | lista de faixas incompleta | sim, cadastro | SSRF residual | reprodução local | alvo FIXED | **FIXED** `c8f4e20` |
| SEC-022 | Claude | LOW | LOW | `atualizarStatusCobranca`, `registrarEstorno` | CR-07 | escrita sem CAS | provável | regressão de estado | código | alvo FIXED | **FIXED** `69b5228`/`8be71d3` — escrita condicional; a guarda exercitada na função real (C1-08) |
| SEC-023 | Claude | LOW | LOW | `outboxService`/`webhookInboxService` | CR-07 | CAS de reivindicação ignora o recuo; passadas sobrepostas | provável | tentativas queimadas | código | alvo FIXED | **FIXED** `af6f597` |
| SEC-024 | Claude | LOW | LOW | `webhookInboxService.reenfileirar` | CR-07 | não zera tentativas | sim (admin) | reprocesso esgota na 1ª falha | código | alvo FIXED | **FIXED** `af6f597` |
| SEC-025 | Claude | LOW | LOW | `cobrancaService.liberarReservaCobranca` | CR-07 | DELETE sem condição de estado | janela estreita | reserva vinculada apagada | código | alvo FIXED | **FIXED** `8be71d3` — delete condicional que devolve se apagou |
| SEC-026 | Claude + Jules (EXPANDIDO) | LOW | LOW | `public/js/modules/*Handler.js`, `status.js` | CR-01 | segmento sem `encodeURIComponent` | sim, link | pedido de outro contratante na tela | código | alvo FIXED | **FIXED** `a5d552e` |
| SEC-027 | Claude | LOW | LOW | `validadores.js` | CR-14 | `String()` em qualquer tipo | sim | dado malformado gravado | código | alvo FIXED | **FIXED** `8be71d3` — `comoTexto`/`passaNoTeto`, só texto ou número finito |
| SEC-028 | Claude | LOW | LOW | `chamarAsaas`, `asaasCheckoutController`, `server.js` | CR-12 | CPF e corpo cru no stdout | sim | PII em log | código | alvo FIXED | **FIXED** `8be71d3` — corpo cru da Asaas fora do log; texto redigido na fonte |
| SEC-029 | Claude | LOW | LOW | `assinaturaController` pausar/retomar | CR-07 | arrendamento não devolvido no sucesso | sim | 409 por 5 min | código | alvo FIXED | **FIXED** `5475d69` |
| SEC-030 | Claude | LOW | LOW | `clientes_asaas`, `subcontas`, `intencoes_troca_plano` | CR-12 | hash sem sal; sem retenção | — | pseudonimização fraca | código | a triar: hash FIXED se não quebrar busca; prazos = decisão jurídica (EXTERNAL_PENDING) | **EXTERNAL_PENDING** EP-05 — o prazo de retenção é decisão jurídica; o hash sem sal é RES-06 (documento em claro já existe por desenho) |
| SEC-031 | Claude | LOW | LOW | `/api/saude`, Northflank | CR-11 | 200 com worker parado; sem health check | sim | processo pendurado não reinicia | ao vivo | alvo FIXED | **FIXED** `8be71d3` — `/api/saude` 503 com `workersAtrasados`; health check do Northflank configurado em 26/09/2026 como readiness TCP na porta 3001, sem liveness — não em `/api/saude`, porque com instância única o 503 de worker atrasado tiraria o serviço inteiro do ar (EP-06 fechado; `RUNBOOK` §6.3) |
| SEC-032 | Claude | LOW | LOW | `atualizarLinkAtivacaoSubconta` | CR-09 | sem validação de esquema | só admin | `javascript:` (barrado pela CSP) | código | alvo FIXED | **FIXED** `8be71d3` — link de ativação só `https`, ≤ 2048 |
| SEC-033 | Claude + Jules | LOW | LOW | `qs` 6.15.3 | CR-13 | dependência com aviso moderado | sim (parser) | DoS / limite de array | `npm audit` | alvo FIXED (atualização segura, sem `--force`) | **FIXED** `8be71d3` — express 4.22.3, qs 6.16.0, `npm audit` 0 |
| SEC-034 | Claude | LOW | LOW | CI | CR-13 | sem `permissions:`; gitleaks sem checksum; sem Dependabot | — | supply chain | `.github/workflows/` | alvo FIXED no que é código; branch protection = EXTERNAL_PENDING (não legível daqui) | **FIXED** `8be71d3`/`8c96576` — `permissions: contents: read`, gitleaks por SHA-256, semgrep por digest, Dependabot com cooldown; branch protection = EXTERNAL_PENDING EP-07 |

### 2.2 INFO da baseline

| ID | Assunto | Classe | Triagem | Status final |
|---|---|---|---|---|
| INFO-01 | Rate limit em memória, `trust proxy 1` sem prova | CR-11 | DUPLICATE de JULES-002 (medir) | **DUPLICATE** de JULES-002 |
| INFO-02 | Pages com `Access-Control-Allow-Origin: *` no estático | CR-11 | a triar (conteúdo público) | **RISK_ACCEPTED** — `*` só no estático público; a Function do admin não o devolve (§11) |
| INFO-03 | CSP do front com `style-src 'unsafe-inline'`, `img-src https:` | CR-11 | a triar | **RISK_ACCEPTED** — sem entrada de usuário refletida em estilo; RES-07 |
| INFO-04 | Imagem do contratante como pixel de rastreio | CR-12 | a triar | **RISK_ACCEPTED** — imagem vem do contratante, que já recebe o evento; RES-08 |
| INFO-05 | `compararSeguro` vaza tamanho | CR-09 | alvo FIXED (barato) | **FIXED** `8be71d3` — SHA-256 dos dois lados antes do `timingSafeEqual` |
| INFO-06 | IP do log de rejeição do webhook do 1º item de XFF | CR-11 | alvo FIXED junto com JULES-002 | **FIXED** `8be71d3` — o log usa `req.ip`; conferido em produção depois do deploy (§11) |
| INFO-07 | Token de renovação e `pedidoId` na query string | CR-12 | a triar | **RISK_ACCEPTED** — `strict-origin-when-cross-origin` não leva a query a terceiro; RES-09 |
| INFO-08 | Reprocesso de evento depois do expurgo de 90 dias da inbox | CR-05 | a triar | **RISK_ACCEPTED** — reprocesso manual depois de 90 dias é operação de humano; RES-10 |
| INFO-09 | Cliente Supabase sem teto de tempo | CR-15 | alvo FIXED | **FIXED** `8be71d3` — `fetchComTeto` 20 s no cliente Supabase |
| INFO-10 | URL da outbox congelada no enfileiramento | CR-04 | a triar junto com SEC-006 | **FIXED** `c8f4e20` — destino revalidado no ENVIO, não no enfileiramento |
| INFO-11 | Mensagem de erro da Asaas repassada ao cliente | CR-12 | alvo FIXED | **FIXED** `8be71d3` — 401/403/5xx da Asaas viram 502 genérico |
| INFO-12 | Documento cita prefixo/sufixo de chave de sandbox | CR-09 | alvo FIXED | **FIXED** `8be71d3` |
| INFO-13 | Grants padrão do `anon` nas 12 tabelas | CR-09 | alvo FIXED (defesa em profundidade) | **FIXED** 0020 — aplicada em produção em 26/09/2026 pelo MCP do Supabase, com aprovação do dono (EP-02 fechado): `anon`/`authenticated` com 0 privilégios em tabela e função, a chave pública recebe `42501` em tabela e RPC, e o `service_role` mantém `EXECUTE` nas 4 funções (FP1C-1 conferido) |
| INFO-14 | Tela Pix de irmã cancelada segue "aguardando" | CR-03 | a triar (UX) | **RISK_ACCEPTED** — UX; o pagamento em si é recusado pela Asaas depois de a irmã ser cancelada; RES-11 |

### 2.3 Achados novos do Jules

| ID | Sev. Jules | Classe | Alegação | Triagem (antes do código) | Status final |
|---|---|---|---|---|---|
| JULES-001 | HIGH | CR-10 | `buscarCobrancaPorReferenciaExterna`, `buscarCobrancaPorCheckoutId`, `buscarIntencao`, `buscarAssinaturaPorId` sem `contratante_id` permitem A → B | a provar ou refutar: toda busca por id único precisa ser classificada pela ORIGEM do id (webhook autenticado, linha do nosso banco, capacidade não enumerável, ou entrada do contratante) | **FALSE_POSITIVE** — as 142 consultas classificadas pela origem do id: nenhuma leva de A para B; a única frágil (irmãs) coberta por teste |
| JULES-002 | MEDIUM | CR-11 | `trust proxy 1` estrito demais; contorna rate limit | medir a cadeia real em produção antes de mexer | **FALSE_POSITIVE** — medido em produção (§11.3): com `X-Forwarded-For: 203.0.113.99` forjado, o `b8f3b07` gravou `160.79.106.139`, o IP de saída real desta sessão, e não o forjado nem o do proxy; o `17c3ef6`, servido por engano minutos antes, gravou o forjado — controle positivo de que a sonda distingue |
| JULES-003 | MEDIUM | CR-09 | `service_role` ignora RLS | arquitetura/defesa em profundidade, salvo exploração demonstrada | **RISK_ACCEPTED** — arquitetura (backend único, `service_role`); defesa em profundidade = INFO-13 |
| JULES-004 | MEDIUM | CR-05 | reconciliador só olha reservas sem `charge_id` | alvo FIXED com reconciliador **dirigido** (não polling global) | **FIXED** `af6f597` + C1-11 — reconciliador dirigido, que não fica preso nas que não resolve |

### 2.4 Alegações adicionais do relatório do Jules (fora da numeração)

| ID nesta rodada | Alegação | Classe | Triagem (antes do código) | Status final |
|---|---|---|---|---|
| JX-01 | IDs como `planoId`, `asaasCheckoutId` e chaves "de cache" aceitam `|` e `../`, "quebrando delimitações do Redis/Supabase" | CR-01 | parte procede (mesma raiz da SEC-001, vale para todo id de fronteira); **não há Redis no projeto**; verificar se algum filtro PostgREST por texto (`.or()`) interpola entrada | **FIXED** — SEC-001 + `tests/filtro-or-so-interpola-o-que-o-servidor-fez.js` (C1-13); a parte "Redis" é FALSE_POSITIVE (não há Redis) |
| JX-02 | `POST /v3/payments` sem chave de idempotência | CR-02 | a verificar: reserva antes de cobrar + `externalReference reserva-<id>` + reconciliador — é idempotência por nossa conta; a Asaas não documenta cabeçalho | **FALSE_POSITIVE** — reserva antes de cobrar + `externalReference reserva-<id>` + reconciliador é a idempotência |
| JX-03 | Admin sem CSRF | CR-09 | provável FALSE_POSITIVE (token em header, nenhuma rota lê cookie) | **FALSE_POSITIVE** — token em header, nenhuma rota do admin lê cookie; e agora o JWT do Access |
| JX-04 | `process.exit(1)` pode corromper operação em memória | CR-06 | DUPLICATE parcial de SEC-013; e janela de crash (CR-02) | **DUPLICATE** de SEC-013 |
| JX-05 | Mocks da Asaas não modelam timeout; testes do webhook não consideram rejeição assíncrona | teste | a cobrir com os testes de classe desta rodada | **FIXED** — mocks com timeout e rejeição (estorno, webhook, outbox, processo filho) |
| JX-06 | Cobrança irmã gerada sem `bloqueioPorPagamentoLocal` em rotas que "ignoram `status=pendente`" | CR-03 | provável DUPLICATE de SEC-004; conferir também o cartão | **DUPLICATE** de SEC-004 |
| JX-07 | Validações que exigiriam produção: cabeçalhos de IP (Northflank/Cloudflare), `v3/refunds` real sem idempotência, `unhandledRejection` nos logs | — | (1) medir; (2) sem estorno real — a correção torna a pergunta desnecessária; (3) ler logs | **DUPLICATE** — (1) JULES-002; (2) SEC-002 torna a pergunta desnecessária; (3) SEC-013/C1-01 |

### 2.5 Classes de causa raiz

| Classe | Nome | Achados |
|---|---|---|
| CR-01 | Identificador não canônico atravessando fronteira | SEC-001, SEC-003, SEC-017, SEC-026, JX-01 |
| CR-02 | Efeito financeiro sem identidade durável antes do provedor | SEC-002, SEC-009, SEC-010, JX-02 |
| CR-03 | Instrumento de pagamento entregue sem reconferir o estado | SEC-004, SEC-005, JX-06, INFO-14 |
| CR-04 | Saída para destino de terceiro sem revalidação no envio | SEC-006, SEC-021, INFO-10 |
| CR-05 | Estado financeiro aceito do corpo do evento / ordem de eventos | SEC-007, SEC-008, SEC-018, SEC-019, SEC-020, JULES-004, INFO-08 |
| CR-06 | Efeito assíncrono sem dono (promessa solta, erro engolido) | SEC-013, SEC-014, JX-04 |
| CR-07 | Escrita de estado fora da máquina/CAS; filas | SEC-022, SEC-023, SEC-024, SEC-025, SEC-029 |
| CR-08 | Ciclo de vida e unicidade de assinatura | SEC-011, SEC-012 |
| CR-09 | Fronteira administrativa e segredos | SEC-015, SEC-016, SEC-032, JULES-003, JX-03, INFO-05, INFO-12, INFO-13 |
| CR-10 | Isolamento multi-tenant | JULES-001 |
| CR-11 | Borda: proxy, limitador, saúde, cabeçalhos | JULES-002, SEC-031, INFO-01, INFO-02, INFO-03, INFO-06 |
| CR-12 | Dado pessoal em log, retenção, analytics | SEC-028, SEC-030, INFO-04, INFO-07, INFO-11 |
| CR-13 | Dependências e CI | SEC-033, SEC-034 |
| CR-14 | Tipo na fronteira | SEC-027 |
| CR-15 | Dependência sem teto de tempo | INFO-09 |

---

## 3. Classes de causa raiz — correção

As contagens de checagens NÃO ficam neste relatório: cada suíte imprime a sua quando roda (`npm test`), e um número copiado aqui envelheceria no próximo commit — envelheceu três vezes nesta rodada. Cada classe foi corrigida **na raiz**, com busca transversal pelo resto do código antes de fechar, e uma suíte de classe que varre o `src/` inteiro em vez de confiar em memória.

| Classe | Correção na raiz | Suíte de classe | Commit |
|---|---|---|---|
| CR-01 identificador não canônico | `exigirParametrosCanonicos` em todo roteador + `segmentoAsaas` em todo caminho de saída; front com `encodeURIComponent` | `identificador-canonico-em-toda-fronteira`, `filtro-or-so-interpola-o-que-o-servidor-fez` | `a5d552e`, `baa3a88` |
| CR-02 efeito financeiro sem identidade durável | estorno como operação durável (tabela `estornos`, 0018); acerto de troca procurado pela referência `troca:<id>`; uma troca em voo (0019) | `estorno-repetido-nao-devolve-duas-vezes`, `acerto-de-troca-nunca-fica-orfao` | `69b5228`, `5475d69`, `baa3a88` |
| CR-03 instrumento entregue sem reconferir | reaproveitar só se ainda é o do pedido, pelo preço da tela; linha representativa determinística | `instrumento-obsoleto-nunca-volta` | `d651f62` |
| CR-04 saída sem revalidação no envio | `redirect: 'error'`/manual em toda saída; destino revalidado no envio | `saida-nunca-segue-redirecionamento`, `nenhuma-chamada-de-saida-sem-teto` | `c8f4e20` |
| CR-05 estado do corpo do evento / ordem | o provedor decide: `GET /v3/payments/{id}` antes de mover dinheiro; transição fora de ordem lança e é reaplicada; reconciliador dirigido | `webhook-confere-na-asaas` | `af6f597`, `baa3a88` |
| CR-06 efeito assíncrono sem dono | promessa com dono em todo `src/`; **todo handler do Express com dono** (`rotaSegura.js`) | `nenhuma-promessa-sem-dono`, `rota-que-lanca-nao-derruba-o-processo` | `5475d69`, `baa3a88` |
| CR-07 escrita fora da CAS | toda transição por `aplicarTransicao`/CAS; escrita incondicional removida; delete condicional | `escrita-de-estado-e-condicional` | `8be71d3`, `baa3a88` |
| CR-08 ciclo de vida da assinatura | uma assinatura viva por plano; vínculo no 1º evento; ciclo identificado pela assinatura | `uma-assinatura-viva-por-plano`, `assinatura-nasce-inteira` | `5475d69`, `baa3a88` |
| CR-09 fronteira administrativa | JWT do Access na origem (RS256, aud, iss, exp) + Pages Function; segredo nunca em log/resposta; grants públicos revogados (0020) | `admin-so-pelo-access`, `segredo-nao-sai-do-admin`, `banco-sem-privilegio-publico` | `8be71d3`, `baa3a88` |
| CR-10 multi-tenant | refutado por classificação das 142 consultas | teste da irmã (única frágil) | — |
| CR-11 borda | `/api/saude` 503 com worker parado; orçamento nas passadas; teto de resposta do webhook | `rotas-http`, autotestes de `passadas.js`, `webhookController` | `8be71d3`, `baa3a88` |
| CR-12 dado pessoal em log | corpo cru fora do log; erro da Asaas redigido | `erro-da-asaas-nao-vaza` | `8be71d3` |
| CR-13 dependências e CI | versões corrigidas; CI só leitura, ferramentas fixadas por hash, Dependabot com cooldown | `ci-so-le-e-fixa-o-que-roda` | `8be71d3`, `8c96576` |
| CR-14 tipo na fronteira | validadores só aceitam texto ou número finito | autoteste de `validadores.js` | `8be71d3` |
| CR-15 dependência sem teto | cliente Supabase com 20 s | `nenhuma-chamada-de-saida-sem-teto` | `8be71d3` |

## 4. Achados do Claude

34 SEC + 14 INFO da baseline. Status de cada um na §2.1 e §2.2, com o commit e a prova. Contado da própria tabela: SEC — **32 FIXED**, **2 EXTERNAL_PENDING** (SEC-018, SEC-030); INFO — **6 FIXED**, **1 EXTERNAL_PENDING** (INFO-13, a aplicação da 0020), **6 RISK_ACCEPTED**, **1 DUPLICATE**. Nenhum CRITICAL existia; os HIGH (SEC-001, SEC-002 e, pela régua do Jules, SEC-006 e SEC-007) estão FIXED.

## 5. Achados do Jules

4 numerados (§2.3) e 7 alegações fora da numeração (§2.4). **JULES-001 (HIGH) é FALSE_POSITIVE** — não por palavra: as 142 consultas foram classificadas pela origem do id, e nenhuma leva de um contratante a outro. JULES-002 foi medido em produção e é FALSE_POSITIVE (§11.3). JULES-003 é arquitetura (RISK_ACCEPTED, com a defesa em profundidade do INFO-13). JULES-004 FIXED. Das alegações: 2 FIXED (JX-01, JX-05), 2 FALSE_POSITIVE (JX-02, JX-03), 3 DUPLICATE.

## 6. Achados novos desta rodada

### 6.1 Na busca transversal (antes da PR)

| ID | Sev. | Classe | Achado | Status final |
|---|---|---|---|---|
| NEW-01 | MEDIUM | CR-07 | `atualizarStatusCobranca`/`atualizarStatusPorCheckoutId` escreviam status sem condição (um `confirmado` atrasado apagava um estorno) | **FIXED** `8be71d3` — removidas; toda transição por CAS |
| NEW-02 | HIGH | CR-09 | com o CPF de alguém, a rota pública de assinatura devolvia a sessão pendente dela — página da Asaas preenchida com nome, e-mail, telefone e endereço | **FIXED** `8be71d3` + C1-05 — só volta para o mesmo pagador (e-mail e telefone) |
| NEW-03 | LOW | CR-12 | o `409 pagamento_em_processamento` confirma a quem tem o CPF que existe assinatura em curso daquele plano | **EXTERNAL_PENDING** EP-08 — decisão do dono (fechar o oráculo muda a experiência de quem tenta de novo) |

### 6.2 No ciclo adversarial 1 (sobre a PR, antes do merge)

Quatro revisores independentes, cada achado relido por mim no código antes de contar. **Duas regressões desta própria branch** (C1-01 e C1-02) — por isso a PR não foi mesclada antes do ciclo.

| ID | Sev. | Classe | Achado | Status final |
|---|---|---|---|---|
| C1-01 | HIGH | CR-06 | JWT com `alg` = `{"toString":0}` lançava na interpolação do log, dentro de handler `async`, sem login e antes de todo limitador — `unhandledRejection` encerrava a única instância. Reproduzido contra o `server.js` real | **FIXED** `baa3a88` — na classe: todo handler com dono (`rotaSegura.js`); decodificador estrito; guarda fecha em 401 |
| C1-02 | HIGH | CR-08 | a conferência de vínculo exigia `reserva-<id da linha>`, mas todo ciclo da assinatura leva a referência da 1ª: do 2º ciclo em diante, todo evento lançava para sempre | **FIXED** `baa3a88` — ciclo amarrado é conferido pela assinatura |
| C1-03 | HIGH | CR-06 | a refeitura da renovação com a nova já gravada pulava o cancelamento da antiga — as duas cobrando | **FIXED** `baa3a88` |
| C1-04 | MEDIUM | CR-02 | o webhook do próprio estorno fazia a reconciliação "provar" ausência; a mesma chave estornava de novo | **FIXED** `baa3a88` |
| C1-05a | LOW | CR-09 | corrida: a 2ª reserva, depois de substituir, podia devolver a sessão de outra pessoa | **FIXED** `baa3a88` |
| C1-05b | MEDIUM | CR-09 | quem tem o CPF cancela a sessão aberta da vítima (sem vazar nada; ela reabre) | **RISK_ACCEPTED** RES-01 |
| C1-06 | MEDIUM | CR-11 | a conferência na Asaas segurava o `200` do webhook — 15 lentos seguidos pausam a fila da conta | **FIXED** `baa3a88` — teto de 8 s |
| C1-07 | MEDIUM | CR-11 | contratante pendurado estourava a passada da outbox e punha `/api/saude` em 503 | **FIXED** `baa3a88` — orçamento de passada |
| C1-08 | MEDIUM | teste | a guarda do estorno só era testada numa cópia; o banco falso comparava número como texto | **FIXED** `baa3a88` |
| C1-09 | LOW | CR-06 | Pix Automático: falha depois da CAS ficava permanente | **FIXED** `baa3a88` |
| C1-10 | LOW | CR-05 | a consulta de status confirmava sem o binding de valor | **FIXED** `baa3a88` |
| C1-11 | LOW | CR-05 | o reconciliador dirigido ficava preso nas mesmas 20 que não resolve | **FIXED** `baa3a88` |
| C1-12 | LOW | teste | banco falso divergente do PostgREST em 4 pontos | **FIXED** `baa3a88` |
| C1-13 | LOW | teste | a conferência do `.or()` tinha dois furos | **FIXED** `baa3a88` |
| C1-14 | LOW | CR-09 | privilégio padrão revogado só para objetos do `postgres` | **RISK_ACCEPTED** RES-05 — toda migration roda como `postgres` |
| C1-15 | LOW | CR-09 | buscador de chaves do Access sem busca única nem recuo depois de falha | **FIXED** `baa3a88` |

### 6.3 No ciclo adversarial 2 (sobre `baa3a88`)

Dois revisores. **Não conta como passada limpa**: achou 1 MEDIUM e 6 LOW que pediram código. O contador de passadas limpas foi zerado depois de corrigir tudo.

| ID | Sev. | Classe | Achado | Status final |
|---|---|---|---|---|
| C2-M1 | MEDIUM | CR-02 | o estorno que a Asaas pode ter feito e não dá para provar ficava travado para sempre, sem saída escrita | **FIXED** `ba36881` — trava mantida de propósito; o alerta nomeia a operação e aponta o procedimento do RUNBOOK §6.3, com as duas saídas; a suíte confere os dois |
| C2-L1 | LOW | CR-06 | a refeitura do Pix Automático (C1-09) reescrevia a assinatura existente para `ativa` no plano de origem | **FIXED** `ba36881` |
| C2-L2 | LOW | CR-08 | a refeitura da renovação (C1-03) cancelava a antiga também no evento de liquidação, 30 dias depois | **FIXED** `ba36881` — só em 72 h e com a nova ativa |
| C2-L1b | LOW | CR-09 | quem tem o CPF cancela a pop-up aberta de outra pessoa | **DUPLICATE** de C1-05b |
| C2-L2b | LOW | teste | banco falso gravava a escrita `single` que casava duas linhas | **FIXED** `7c0c94d` |
| C2-L3b | LOW | teste | índice único do update no banco falso contra o estado anterior | **FIXED** `7c0c94d` |
| C2-L4 | LOW | CR-06 | invólucro sem `head`, `options` e `route()` | **FIXED** `7c0c94d` |
| C2-L5 | LOW | teste | a prova no `server.js` real não exercitava o invólucro | **FIXED** `7c0c94d` — handler real que rejeita, com exceção injetada |

### 6.4 Na passada limpa #1 (sobre `ccfedc5`) — **não limpa**

Três revisores (dinheiro e estado; crash, auth e tenant; regressões do diff inteiro). O de regressões do diff veio **limpo**; o de dinheiro achou um defeito confirmado **na própria correção DIF-01** — a passada não conta, e o contador continua em 0.

| ID | Sev. | Classe | Achado | Status final |
|---|---|---|---|---|
| CP1-01 | MEDIUM | CR-05 | a `PAYMENT_REFUND_DENIED` velha, reprocessada (reenfileiramento do admin ou refeitura da inbox) depois de um novo pedido aceito, marcava `estorno_negado` e reabria a operação viva com a Asaas ainda em `REFUND_REQUESTED` — o próximo `/estornar` mandaria o estorno de novo. Reproduzido | **FIXED** `0808a13` — a negativa exige respaldo do provedor: o pagamento de volta a pago |
| CP1-02 | INFO | CR-08 | assinatura de sessão substituída que a Asaas liquidou vira assinatura ativa; se a substituta também pagou, são duas, sem alerta (a de pedido vira duplicidade pelo pedido) | **FIXED** `0808a13` — chama um humano (`erros`) |
| CP1-03 | INFO | CR-02 | corrida estreita no reconciliador de estorno de boleto: lê `REFUND_REQUESTED`, a negativa é processada, e a operação é marcada `CONFIRMED` — a chave padrão devolve um `200` velho até a próxima negativa | **RISK_ACCEPTED** RES-14 — nenhum dinheiro sai; exige a negativa no intervalo de uma leitura |
| CP1-04 | INFO | CR-08 | pop-up de assinatura nova cancelada pelo pagador que a Asaas ainda liquidasse mandaria `cancelada` e depois `criada` | **RISK_ACCEPTED** RES-15 — antes o pagamento sumia calado, o que era pior; exige a Asaas liquidar sessão que ela deu como cancelada |
| CP1-05 | INFO | CR-02 | com a escrita do novo pedido na nossa linha falhando depois da Asaas aceitar, a regra "negado não conta" do restante deixaria de fora um pedido vivo | **RISK_ACCEPTED** RES-16 — exige falha de banco num instante exato e novo pedido dentro da janela; a Asaas tende a recusar o segundo pedido de estorno de boleto |
| CP1-06 | INFO | CR-02 | até o `reabrirEstornosNegados` rodar, a chave padrão do total ainda devolve o `200` antigo | **RISK_ACCEPTED** RES-17 — a refeitura da inbox fecha; a chave nova já funciona no intervalo (teste 7e) |
| CP1-07 | INFO | CR-14 | `listarInbox`/`listarOutbox` não limitam `limite`; `?limite=-5` dá 502 (só admin, atrás do Access) | **RISK_ACCEPTED** RES-18 — endurecimento opcional, sem exploração |
| CP1-08 | INFO | CR-11 | o redirecionamento para HTTPS reflete o `Host` e roda antes do `no-store` | **RISK_ACCEPTED** RES-19 — a API é servida só em HTTPS pela borda; o 301 não é alcançável de fora com `Host` arbitrário na Northflank |
| CP1-09 | INFO | CR-11 | respostas da Function do admin sem `nosniff` (`_headers` não vale para Function) | **RISK_ACCEPTED** RES-20 — resposta é JSON com `content-type` explícito, atrás do Access |
| CP1-10 | INFO | teste | a conferência de cobertura do invólucro só casa `Router()`/`express()` com parênteses vazios | **RISK_ACCEPTED** RES-21 — nenhuma construção com opções existe em `src/`; endurecimento opcional do teste |
| CP1-11 | INFO | CR-04 | `alvoDeRedeSeguro` aceita nome interno de cluster sem resolver DNS | **RISK_ACCEPTED** RES-22 — decisão registrada (sem resolução de DNS); só admin; o TLS falha |
| CP1-12 | INFO | CR-07 | `dispararCancelador` pode sobrepor a passada periódica | **RISK_ACCEPTED** RES-23 — cada linha é reivindicada por CAS; sem efeito duplicado |
| CP1-13 | INFO | CR-11 | corpo menor que o `Content-Length` segura a conexão até o `requestTimeout` padrão (300 s) | **RISK_ACCEPTED** RES-24 — limitador por IP e a borda da Northflank; sem derrubar o processo (medido) |
| CP1-14 | INFO | CR-12 | POST público sem `cotacaoId` válido cria uma cotação por chamada | **RISK_ACCEPTED** RES-25 — limitado pelo rate limit e pelo expurgo diário |

### 6.5 Na passada limpa #1, segunda tentativa (sobre `d9adebe`) — **não limpa**

| ID | Sev. | Classe | Achado | Status final |
|---|---|---|---|---|
| CP2-01 | LOW | CR-08 | o alerta de assinatura substituída e paga (CP1-02) só olhava `cancelado`; a sessão substituída por ter TRAVADO (65 min → `expirado`) e paga depois virava a segunda assinatura cobrando, sem alerta. Reproduzido | **FIXED** — o alerta cobre `cancelado` e `expirado` |
| CP2-02 | INFO | CR-05 | a confirmação pela consulta de status não dispara irmãs nem aviso; se a linha da inbox já esgotou, o reconciliador vê os dois lados iguais e os efeitos não rodam | **RISK_ACCEPTED** RES-26 — exige o webhook esgotar ANTES da consulta confirmar; o esgotamento já vira `erros` para um humano |
| CP2-03 | INFO | CR-05 | passo do reconciliador sem respaldo lança e só adia uma hora (log de console) | **RISK_ACCEPTED** RES-27 — a linha esgotada da inbox já está em `erros` |
| CP2-04 | INFO | CR-06 | o segundo `estorno_solicitado` depois de uma negativa não gera webhook ao contratante (a chave do fato deduplica); a resposta síncrona 200 avisa | **RISK_ACCEPTED** RES-28 |
| CP2-05 | INFO | CR-02 | corrida estreita da mesma família da RES-14 (negativa velha lendo a Asaas antes do novo pedido e reabrindo depois dele) | **RISK_ACCEPTED** RES-29 — exige as duas coisas no intervalo de uma chamada à Asaas |
| CP2-06 | INFO | CR-02 | estorno de cartão/Pix tratado como síncrono: um `REFUND_IN_PROGRESS` depois negado deixa a cobrança `estornado` | **RISK_ACCEPTED** RES-30 — termina em `erros` para um humano; o comportamento da Asaas para cartão/Pix não foi medido |
| CP2-07 | LOW | doc | RN-56 e RN-71 não diziam que a negativa de estorno exige respaldo da Asaas (mudança do `0808a13`) | **FIXED** — `docs/funcional.md` |
| CP2-08 | LOW | doc | `API.md` §5.4 dizia "a mesma chave devolve o resultado gravado" sem a exceção do estorno de boleto negado | **FIXED** — `API.md` §5.4 |
| CP2-09 | INFO | CR-02 | a suposição de que a Asaas devolve o boleto a `RECEIVED` depois de negar o estorno não foi medida | **EXTERNAL_PENDING** EP-10 — `docs/pendencias.md`; medir no primeiro estorno de boleto negado |
| CP2-10 | LOW | teste | o filtro de `status_resultado` em `reabrirEstornosNegados` não era protegido por teste: tirá-lo passava as 82 suítes, e reabriria um estorno parcial que DE FATO devolveu dinheiro na mesma cobrança | **FIXED** — o caso D-1 ganhou a operação que devolveu, na mesma cobrança; sabotagem pega |
| CP2-11 | INFO | CR-14 | `/troca/contexto` e `/troca/aprovar` com token objeto lançavam no `.test` (502 + linha em `erros`) | **FIXED** — só texto; autoteste nas duas rotas, sabotagem pega |
| CP2-12 | INFO | teste | o `catch` síncrono do invólucro é redundante no Express 4 (que já pega o síncrono), por isso tirá-lo não reprova | **RISK_ACCEPTED** RES-31 — cinto e suspensório de propósito; o assíncrono, que é o que importa, é provado |
| CP2-13 | INFO | teste | a conferência de cobertura não vê `import { Router as R0 }` | **DUPLICATE** de CP1-10 |
| CP2-14 | INFO | CR-05 | dois eventos sem `id` e corpo mínimo idêntico são deduplicados como um | **RISK_ACCEPTED** RES-32 — a Asaas sempre manda `id` |
| CP3-01 | LOW | doc | o alerta `assinaturaSubstituidaPaga` (duas assinaturas cobrando o mesmo cartão) não tinha primeira ação no RUNBOOK nem frase no RN-70 | **FIXED** — RUNBOOK §6.3 e RN-70 |
| CP3-02 | LOW | doc | o próprio relatório contradizia o HEAD: contagens de checagens da §3 velhas e a §7 com "doze commits" e sem os commits dos ciclos | **FIXED** — a §3 deixou de copiar contagens (cada suíte imprime a sua); a §7 lista os 24 commits e todos os que mudam código |
| CP3-03 | INFO | CR-08 | o alerta de assinatura substituída também dispararia para uma linha de Pix Automático `cancelado` que recebesse um pagamento tardio | **RISK_ACCEPTED** RES-33 — método desligado nesta conta (`CONSTRAINTS.md` §2.4) e a linha é achada pelo id da autorização; falso positivo seria só um alerta a mais |
| CP3-04 | INFO | doc | ~20 contextos novos de `erros` (reconciliador "sem caminho", `semRespaldo`, órfãos do sweeper) sem linha própria na tabela do RUNBOOK §6.3 | **RISK_ACCEPTED** RES-34 — cada mensagem já diz o que conferir; a tabela não se propõe completa |
| CP3-05 | LOW | CR-08 | os dois alertas que chamam um humano (`assinaturaSubstituidaPaga`, CP1-02/CP2-01; `primeiroCicloFalhou`, SEC-011) só saíam com a transição aplicada NA MESMA passada: uma escrita que lançasse entre a transição e o alerta (`upsertAssinatura`, `buscarAssinaturaPorId`) fazia a retentativa chegar como reentrega e o alerta nunca sair — duas assinaturas cobrando sem ninguém saber (invariante 10) | **FIXED** — os dois alertas saem ANTES da transição (repetir é inofensivo: `erros` agrega); regressão com falha injetada nos dois caminhos em `tests/assinatura-nasce-inteira.js`, 2 sabotagens pegas |
| CP3-06 | INFO | CR-02 | se `reabrirEstornosNegados` lança depois de `estorno_negado` gravado e uma confirmação da mesma cobrança entra antes da retentativa, a negativa repetida é ignorada como obsoleta e a operação fica CONFIRMED (o sintoma do DIF-01) | **RISK_ACCEPTED** RES-35 — exige falha num instante exato mais uma confirmação depois de negativa que a Asaas não foi medida mandando; a operação presa aparece pelo 409 e pelo RUNBOOK §6.3 |
| CP3-07 | INFO | CR-05 | desde o D-3, uma linha `cancelado`/`expirado` que recebe recusa de cartão ou reprovação de risco lança "falta o estado anterior" até a inbox esgotar e virar `erros` | **RISK_ACCEPTED** RES-36 — ruído, nenhum dinheiro; a mesma lógica existia antes do D-3 |
| CP3-08 | INFO | CR-08 | o alerta de sessão substituída também sai para uma sessão de assinatura só expirada localmente, sem substituta, e paga tarde | **RISK_ACCEPTED** RES-37 — alarme a mais, nunca a menos; o humano confere e encerra |
| CP3-09 | MEDIUM (teste) | CR-05 | o respaldo do provedor, a sessão da pop-up e o binding de valor quase sem prova: 18 sabotagens no webhook passavam as 82 suítes — acrescentar `vencido` ao respaldo de `confirmado`, apagar a linha de `chargeback`, `Boolean(estado) &&` → `!estado ||`, tirar a comparação de `checkoutSession`, tirar a isenção de assinatura. O código de produção estava certo; um evento forjado sob a sabotagem confirmava cobrança vencida | **FIXED** `158df5d` — respaldo fixado célula por célula (todo alvo × todo estado da Asaas, inclusive nulo), seis eventos forjados pelo receptor real com controle positivo, sessão divergente, estorno total sobre parcial; as 18 reprovam |
| CP3-10 | MEDIUM (teste) | CR-02 | o CAS de `estornoService.transitar` (`.in('estado', de)`) sem prova: sob sabotagem, o reconciliador com um retrato velho sobrescrevia uma operação CONFIRMED e a mesma chave estornava R$ 30 duas vezes | **FIXED** — serviço real contra o banco falso, com controle positivo de que a escrita passa quando a operação está de fato aberta |
| CP3-11 | LOW (teste) | CR-02 | o filtro `estado = CONFIRMED` de `reabrirEstornosNegados` sem prova: sob sabotagem, uma negativa velha reabria uma tentativa ambígua que podia já ter estornado | **FIXED** — com controle de que a CONFIRMED é reaberta |
| CP3-12 | LOW (teste) | CR-02 | as demais guardas do estorno sem prova própria: exclusões e `Math.max` de `restanteEstornavel`, prova por valor com outras em aberto, espera de 15 min do boleto, estorno CANCELLED contando, arrendamento da chamada viva, FAILED_FINAL e o 409 `estorno_impossivel`, e o filtro de status e o arrendamento de `reivindicarEstorno` | **FIXED** — blocos 15–21 da suíte de estorno, o 21 com os serviços reais; 15 das 16 sabotagens reprovam (a 16ª é o CP3-18) |
| CP3-13 | LOW (teste) | CR-05 | ler o primeiro `X-Forwarded-For` em vez do `req.ip` na origem do webhook não reprovava nada — no modo estrito, qualquer um "seria" a Asaas | **FIXED** — autoteste com XFF forjado nos dois sentidos |
| CP3-14 | LOW (teste) | CR-03 | a matriz de transições só era conferida quanto a citar status que existem: acrescentar `estorno_negado → pendente` ou `estornado_parcialmente → confirmado` passava | **FIXED** — a matriz inteira fixada no autoteste |
| CP3-15 | LOW (teste) | CR-13 | a lista de métodos do invólucro de rota (`use`, `all`, `head`/`options`, o ramo de lista) sem prova — o C2-L4 estava FIXED sem teste que o travasse | **FIXED** `dd81e79` — todo método prometido e todo método que o `src/` registra, em `app` e `roteador()`, direto, por `route()`, em lista e lista aninhada |
| CP3-16 | LOW (teste) | CR-06 | guardas condicionais anteriores a `43635c4`, de que a remediação depende, sem prova: `aplicarTransicaoPorCheckoutId`, CAS e reivindicação da intenção de troca (status e validade), `mutation_version` de `aplicarTrocaDePlano`, filtro de status de `marcarReconciladas` | **FIXED** `dd81e79` — um teste de CAS por escritor, contra o serviço real, cada um com controle positivo |
| CP3-17 | INFO | CR-09 | as camadas do JWT do Access se cobriam (`alg` no veredito e na assinatura, `kty`), e o teto de 8192 caracteres não tinha teste | **FIXED** `dd81e79` — cada camada sozinha, e o teto com controle logo abaixo |
| CP3-18 | INFO | CR-02 | tirar o `excetoId` de `restanteEstornavel` não tem efeito observável: nos dois chamadores a própria operação nunca alcança os termos lidos (FAILED_RETRYABLE sob arrendamento; ou CONFIRMED, e aí o CAS do CP3-10 recusa a escrita) | **RISK_ACCEPTED** RES-38 — o pior efeito é um alerta falso de "não permite decidir"; o raciocínio está no comentário do bloco 15 da suíte |
| FP1A-1 | MEDIUM | CR-06 | `registrarCicloAssinatura` lia QUALQUER `23505` como "charge repetido"; a linha do ciclo 2+ também cai no índice único da reserva de pop-up (`idx_cobrancas_assinatura_pendente_unica`, 0015), e com uma renovação aberta do mesmo plano e documento o ciclo PAGO sumia: nenhuma linha, nenhum aviso, inbox `processado`, reconciliador sem ver. Reproduzido contra o código real | **FIXED** — `duplicado` só se a linha daquele charge existe; senão lança e a inbox refaz com recuo (a reserva se resolve em minutos; os recuos somam ~42 h), esgotado vira `erros`. Regressão com a reserva aberta e depois resolvida, e controle do charge repetido de verdade (RN-23); 2 sabotagens pegas |
| FP1A-2 | LOW | CR-06 | cancelar entre o `GET` da aprovação e `reivindicarTroca`, ou durante uma intenção órfã em `PROCESSING_PAYMENT` depois do arrendamento, deixa o acerto ser cobrado sobre uma assinatura cancelada — o cancelamento não mexe em `mutation_version` | **RISK_ACCEPTED** RES-39 — janela de milissegundos, ou uma intenção órfã que o sweeper resolve; o desfecho depende de como a Asaas responde a um `PUT` em assinatura removida, não medido; o `PUT` que lança vai a `erros` |
| FP1A-3 | INFO | CR-04 | se a Asaas der um id NOVO de pagamento a uma retentativa dentro da mesma sessão de pop-up recusada, o pagamento vai para `duplicidadeDeReserva` com o conselho de "estornar um" — o único pagamento real | **RISK_ACCEPTED** RES-40 — não medido se a Asaas troca o id na retentativa; o alerta leva um humano à Asaas antes de qualquer estorno |
| FP1A-4 | LOW | CR-04 | `PAYMENT_*` de um charge nosso, com a nossa referência `reserva-<uuid>` e sem linha local, voltava calado | **FIXED** — alerta `reservaSemLinha` em `erros` e linha no RUNBOOK §6.3; teste com controle (referência alheia continua ignorada), sabotagem pega |
| FP1B-1 | INFO | CR-13 | o invólucro de rota passava a `next()` uma falha sem `Error` (`throw undefined`, `reject(null)`, `'route'`) — numa guarda, isso seria seguir adiante | **FIXED** — todo motivo vira `Error`; teste com quatro guardas que falham sem Error, e a sabotagem mostrou as quatro entregando a rota protegida (200) |
| FP1B-2 | INFO | CR-13 | o `.catch` do receptor lia `erro.message`; uma rejeição com `null` faria o próprio `catch` lançar | **FIXED** — `erro?.message ?? String(erro)` |
| FP1B-3 | INFO | CR-10 | o limitador chaveia pelo IP exato; um cliente com um /64 IPv6 pode trocar de endereço a cada pedido | **RISK_ACCEPTED** RES-41 — os limites protegem custo e força bruta, e as chaves têm 192 bits; se os clientes chegam por IPv6 à Northflank não foi medido (a sonda do JULES-002 chegou por IPv4) |
| FP1C-1 | LOW | CR-09 | a 0020 tira o EXECUTE de `PUBLIC` em todas as funções do `public`; o backend só segue se o `service_role` tiver grant próprio, e nada no repositório confere isso — sem ele, `registrar_erro` falha calado | **DUPLICATE** de INFO-13/EP-02 — a conferência pós-aplicação está escrita na §7 |
| FP1C-2 | LOW | doc | a §7.1 estava velha: `trocaAprovacaoController.js` sem classificação e contagens de linhas de um commit anterior | **FIXED** — tabela regerada pelo script contra o HEAD |
| FP1C-3 | INFO | ops | `scripts/limpar-registros-de-teste.mjs` não conhece a tabela `estornos`, e por isso a primeira trava dele recusa rodar | **RISK_ACCEPTED** RES-42 — recusa é o modo seguro; classificar `estornos` (antes de `cobrancas`, pela FK) é decisão para quando o script voltar a ser usado, e nesta rodada nenhum registro se apaga |
| FP1C-4 | INFO | CR-05 | `checkoutSession`/`externalReference` agora só vêm do `GET` da Asaas; amarrar a primeira cobrança da pop-up depende de um dos dois estar lá | **EXTERNAL_PENDING** EP-11 — conferir no próximo pagamento real de cartão (§11) |
| FP1C-5 | INFO | ops | com o backend no ar antes do front, o painel velho chama a API direto e recebe `401` até o deploy do Pages | **RISK_ACCEPTED** RES-43 — só o operador; os dois saem da `main` juntos |
| FP1RA-1 | MEDIUM | CR-06 | o conserto do FP1A-1 ainda lia "a linha deste charge existe" como "este MESMO evento já foi tratado": com dois eventos DIFERENTES do mesmo ciclo novo juntos (vencimento ou recusa com a confirmação — o teto de 8 s e o worker da inbox permitem), a confirmação perdia a inserção e era descartada; ciclo `vencido`/`recusado` com a Asaas dizendo pago, inbox `processado`, sem aviso e fora do reconciliador. Reproduzido contra o código real | **FIXED** — a perdedora segue com a linha que existe; perde o UPDATE condicional, lança, e a inbox a refaz (`vencido → confirmado` e `recusado → confirmado` estão na matriz). O aviso tem chave do fato, então a mesma confirmação sai uma vez (RN-23, autoteste reescrito). Regressão com os dois pares concorrentes; sabotagem pega |
| FP1RA-2 | LOW | CR-04 | o alerta novo `reservaSemLinha` (FP1A-4) disparava para as parcelas 2..N de cartão parcelado, que levam a mesma referência com a reserva viva — e a ação do RUNBOOK mandaria estornar | **FIXED** — só alerta se a reserva não existe; teste da parcela 2, sabotagem pega |
| FP1RA-3 | INFO | CR-04 | `reservarCobrancaPopup` trata como travada qualquer linha `assinatura` pendente com mais de 65 min, inclusive uma linha de ciclo presa em `pendente` (depois de `RECEIVED_IN_CASH_UNDONE`); a marcaria `expirado` e a confirmação posterior dispararia um `assinaturaSubstituidaPaga` falso | **RISK_ACCEPTED** RES-44 — nenhum dinheiro se move; alarme a mais |
| FP1RA-4 | INFO | CR-06 | `registrarAcertoDeTroca` trata qualquer erro, inclusive `23505` de uma refeitura depois de queda, como "não registrado" — alerta `acertoNaoRegistrado` falso | **RISK_ACCEPTED** RES-45 — alarme a mais, nunca a menos |
| FP1RA-5 | INFO | CR-05 | a releitura da inbox depois de `23505` ignora o próprio erro (id nulo vira "duplicado", 200) | **RISK_ACCEPTED** RES-46 — a Asaas reenvia; o evento não se perde enquanto houver reenvio |
| FP1RB-1 | INFO | CR-13 | o conserto do FP1B-1 chamava `String(erro)`, que LANÇA para `Object.create(null)`: dentro do invólucro, rejeição sem dono e o processo caía | **FIXED** — conversão em `try` com texto fixo; teste, sabotagem pega (o processo morria) |
| FP1RB-2 | INFO | CR-13 | o erro do PostgREST (objeto puro) virava `Error("[object Object]")`, perdendo `code` e `message` e colapsando toda falha de banco numa impressão digital só em `erros` | **FIXED** — a mensagem e o `code` passam para o Error, o original vai em `cause`; teste. A impressão digital em `erros` continua a mesma para toda falha sem Error (o primeiro quadro é o invólucro) — isso é o FP2B-1, aceito à parte |
| FP1RC-1 | LOW | CR-04 | o mesmo alarme falso das parcelas 2..N | **DUPLICATE** de FP1RA-2 |
| FP1RC-2 | INFO | CR-13 | o mesmo `[object Object]` | **DUPLICATE** de FP1RB-2 |
| FP2B-1 | INFO | CR-13 | toda falha sem Error que chega ao tratador final ganha a mesma impressão digital (`rotaSegura.js:43` é o primeiro quadro), e o `registrar_erro` sobrescreve a mensagem no conflito: falhas de banco diferentes viram uma linha só em `erros`, com a última mensagem | **RISK_ACCEPTED** RES-47 — observabilidade; nenhum handler público rejeita com objeto puro (todos passam por `responderErro`), nada vaza e nada financeiro se perde |
| FP2B-2 | INFO | CR-12 | o tratador final loga o erro inteiro (`server.js`); um erro do PostgREST embrulhado leva `cause.details`, que numa violação de único pode trazer `documento` | **RISK_ACCEPTED** RES-48 — mesma classe do SEC-028; nenhuma rota pública chega a isso hoje; fica para a manutenção logar só `message`/`code` |
| FP2B-3 | INFO | CR-13 | `morrerContando` chama `String(motivo)` fora de `try`; um motivo sem texto vira `uncaughtException` — o processo sai com código 1 do mesmo jeito, perde-se só o primeiro motivo | **RISK_ACCEPTED** RES-49 — exige uma rejeição já sem dono |
| FP2B-4 | INFO | CR-09 | o token de sessão do admin não é amarrado à identidade do Access: outro operador liberado no Access que tenha um token vazado o reutiliza | **RISK_ACCEPTED** RES-50 — as duas camadas continuam exigidas; o Access libera só o e-mail do dono |
| FP2C-1 | LOW | doc | `409 estorno_impossivel` não estava no `API.md` §5.4 | **FIXED** — linha nova na tabela de respostas do estorno |
| FP2C-2 | INFO | doc | a §7.1 tinha contagens de linhas velhas em seis arquivos e três justificativas erradas (`CHECKOUT_CONSOLIDATION_STATE.md` é a INFO-12; `CLAUDE.md`/`README.md` só mudam a contagem de suítes) | **FIXED** — tabela regerada com as regras corrigidas |
| FP2C-3 | INFO | CR-02 | a 0018 declara as FKs de `estornos` sem `ON DELETE`, ao contrário das outras tabelas: apagar um contratante ou uma cobrança com estorno falharia | **RISK_ACCEPTED** RES-51 — nenhum caminho apaga essas linhas hoje (só reserva sem charge, que nunca tem estorno); é a trava certa para dinheiro que saiu |
| FP2A-1 | MEDIUM | CR-05 | duas passadas do MESMO charge em paralelo (o teto de 8 s, o worker da inbox, o reconciliador) terminavam em qualquer ordem, e a que aplicou a transição, achando a chave do fato já gravada pela outra, enfileirava um segundo aviso com `eventoId` novo — "o mesmo fato aconteceu de novo". O contratante que dá um período por confirmação dava dois (direito sem pagamento). O FP1RA-1 tornou o caminho do ciclo alcançável; o da renovação (`criada` dobrado) é anterior a esta remediação. Reproduzido: 4/40 e 10/60 no ciclo, 12/30 na renovação | **FIXED** — uma passada por charge de cada vez (`umaPassadaPorCobranca`, fila em memória; vale por haver uma instância só, escrito no `CONSTRAINTS.md` §2). Depois: 0/40 no ciclo e 0/30 na renovação. Autoteste determinístico da fila e da fiação, e regressão ponta a ponta com latência da Asaas; três sabotagens pegas |
| FP2A-2 | INFO | CR-08 | na mesma corrida, as duas passadas mandavam `DELETE` da assinatura antiga à Asaas (30/30); a segunda podia virar um "Cancele na mão" falso | **FIXED** — a mesma fila (0/30 depois); a antiga termina `cancelada` na regressão |
| FP2A-3 | LOW | CR-08 | se o 1º ciclo falhou e o ciclo 2 cria a assinatura, o contratante ouve `criada` para aquele charge e, depois, `cobranca_confirmada` para o mesmo `chargeId` | **RISK_ACCEPTED** RES-53 — dentro da borda do SEC-011/RES-04, cujo comportamento na Asaas não foi medido; o contratante recebe dois fatos diferentes, não o mesmo duas vezes |
| FP2A-4 | INFO | CR-05 | um `OVERDUE`/recusa atrasado se aplica com a Asaas já dizendo `CONFIRMED` (alvo informativo não pede respaldo): o contratante ouve `cobranca_falhou` antes do `cobranca_confirmada` | **RISK_ACCEPTED** RES-54 — o estado final é o certo e os dois avisos chegam; a ordem é a documentada no `API.md` §4.3.6 (eventos podem chegar fora de ordem) |
| FP2A-5 | INFO | CR-05 | a fila por charge é em memória: na troca de versão, a instância antiga e a nova convivem por segundos e podem processar o mesmo charge ao mesmo tempo | **RISK_ACCEPTED** RES-52 — janela de segundos, a cada deploy; o estado segue protegido pelo UPDATE condicional; `CONSTRAINTS.md` §2 manda trocar por arrendamento no banco antes de qualquer réplica |
| FP2RA-1 | MEDIUM | CR-05 | a consulta pública de status (`statusPublico`, polled pela tela a cada 10 s) gravava `pendente → confirmado` sozinha, sem aviso e fora da fila do charge. Numa reconfirmação (baixa desfeita, paga de novo), o `PAYMENT_RECEIVED` seguinte achava o status já no alvo (`aplicada = false`) e a chave do fato já usada: o contratante nunca ouvia o pago de novo, a inbox ficava `processado` e o reconciliador via os dois lados iguais (evento financeiro perdido). Reproduzido contra o código real | **FIXED** — a confirmação que a consulta descobre entra por `processarWebhook` como evento sintético (o que o reconciliador já faz): fila do charge, respaldo, UPDATE condicional e aviso com a chave certa (o sufixo de "aconteceu de novo" na reconfirmação). RN-69; regressão com e sem a tela no meio; sabotagem pega |
| FP2RA-2 | LOW | CR-02 | a rota de estorno avisava o contratante mesmo quando a sua escrita na cobrança perdia o CAS para o `PAYMENT_REFUNDED`; o webhook, que aplicou a transição, re-chaveava o fato — segundo `estornado` com `eventoId` novo (3/60 com latência). Nada é devolvido duas vezes | **FIXED** — a rota só avisa se ELA gravou (`gravouNaCobranca`); regressão com o webhook gravando no meio e controle; sabotagem pega |
| FP2RA-3 | INFO | CR-08 | renovação cuja 1ª cobrança da pop-up falhou: se é um ciclo seguinte que cria a assinatura nova, a antiga nunca é cancelada (a linha do ciclo não leva `substitui_assinatura_id`) | **RISK_ACCEPTED** RES-55 — dentro da borda do SEC-011/RES-04/RES-53; o alerta `primeiroCicloFalhou` já chama um humano |
| FP2RB-1 | INFO | CR-05 | com o `ASAAS_WEBHOOK_TOKEN` vazado, eventos com ids novos para UM charge conhecido enfileiram atrás da fila dele; o evento real daquele charge espera | **RISK_ACCEPTED** RES-56 — exige credencial vazada; outros charges não são afetados, o estado segue protegido e o limitador vale |
| FP2RB-2 | INFO | CR-05 | serializar por charge soma a latência da Asaas entre passadas do mesmo charge; o worker da inbox pode esperar atrás da cadeia de um charge lento, dentro do orçamento de 120 s | **RISK_ACCEPTED** RES-57 — troca de vivacidade por correção, escolhida de propósito (FP2A-1) |
| FP2RC-1 | INFO | CR-02 | o aviso dobrado de estorno entre a rota e o webhook | **DUPLICATE** de FP2RA-2 |
| FP2RC-2 | INFO | doc | a §7.1 ficou velha de novo depois do `47520b1` (sete arquivos) e a linha do banco falso dizia "regressão de classe" | **FIXED** — regerada; o banco falso passa a ser classificado como infraestrutura de teste |
| FP2RC-3 | INFO | teste | o caso do ciclo 2+ do FP2A-1 não tem regressão ponta a ponta própria (só a renovação tem) | **RISK_ACCEPTED** RES-58 — a fila e a fiação são provadas por autoteste determinístico, que reprova a sabotagem; o caminho do ciclo passa pela mesma fiação |
| FP3A-1 | MEDIUM | CR-05 | o "aconteceu de novo" (reconfirmação depois de baixa desfeita, chargeback vencido, negativa de estorno) só era reconhecido pela passada que APLICOU a transição: se ela falhava entre a transição e a outbox (banco piscando, reinício), a retentativa via o status já no alvo, a chave do fato já usada, e o aviso da segunda vez se perdia para sempre — o contratante ficava com "trate como não pago" (pagamento sem direito). Anterior a esta remediação (a mesma lógica está em `43635c4`). Reproduzido com falha injetada | **FIXED** — o "de novo" também é reconhecido pelo que está GRAVADO: o momento do estado atual (`status_evento_em`, que só a transição do webhook escreve) posterior ao aviso existente, com folga de 5 min entre relógios; a chave leva esse momento gravado, então a retentativa cai na mesma linha. Regressão com e sem a falha, controle do RECEIVED de D+30 (não vira "de novo"); sabotagem pega |
| FP3A-2 | LOW | CR-10 | no caminho síncrono da troca de plano, a chave do `plano_trocado` é por plano anterior, sem intenção nem charge: A→B, B→A, A→B de novo deduplica a terceira | **RISK_ACCEPTED** RES-59 — o contratante fez a chamada e recebeu o `200` com o `planoId` novo; o `API.md` §5.6 só faz o evento ser a fonte no caminho assíncrono |
| FP3A-3 | INFO | CR-03 | a segunda transição (`estornado_parcialmente → estornado`) ignora o resultado do CAS | **RISK_ACCEPTED** RES-60 — nenhum escritor concorrente a torna nociva: o CAS da rota de estorno não passa ali e a fila do charge serializa o webhook |
| FP3B-1 | INFO | CR-05 | na janela em que a linha está `pendente` e a Asaas já diz pago, cada consulta anônima que leu `pendente` enfileira uma passada completa (um GET a mais na Asaas cada); 40 simultâneas fizeram 84 GETs | **DUPLICATE** de FP2RB-2 — a primeira passada confirma e fecha a janela; um aviso só; o limitador por IP vale |
| FP3B-2 | INFO | CR-12 | a linha de log nova `[consulta]` repete a `description` do erro da Asaas | **RISK_ACCEPTED** RES-61 — o log do `chamarAsaas` já imprime o mesmo texto; nunca vai à resposta |
| FP3B-3 | INFO | front | o polling da tela de status usa `setInterval` sem guarda de pedido em voo | **RISK_ACCEPTED** RES-62 — no máximo um pedido a mais a cada 10 s por navegador; comportamento, não segurança |
| FP3C-1 | INFO | doc | o `API.md` definia `ocorridoEm` só como o momento do lado da Asaas e não dizia que uma consulta de status pode disparar o aviso | **FIXED** — `API.md`, tabela do payload: o fato descoberto por conciliação leva o momento da descoberta, e o aviso pode chegar junto com a resposta da consulta |
| FP3C-2 | INFO | CR-05 | a consulta de status pode esperar atrás de uma passada do mesmo charge e custa um GET a mais na Asaas | **DUPLICATE** de FP2RB-2 |
| FP3C-3 | INFO | CR-05 | o "de novo" depende do `aplicada` em memória | **DUPLICATE** de FP3A-1 |
| FP3C-4 | INFO | CR-08 | `consultarAssinatura` lê a assinatura antes da conciliação; se a passada sintética cria a assinatura durante a chamada, aquela resposta traz `assinaturaId: null` | **RISK_ACCEPTED** RES-63 — a chamada seguinte já vem certa; nada se perde |
| FP4A-1 | MEDIUM | CR-05 | FINANCIAL_INVARIANT, introduzido pelo conserto do FP3A-1: a chave do "de novo" colava o instante como texto, e o mesmo instante chega em dois textos — `…000Z` na passada que aplica (JavaScript) e `…+00:00` na seguinte (o `timestamptz` que o PostgREST devolve, medido num Postgres 16/17). Uma reconfirmação real saía duas vezes, com `eventoId` diferentes — direito sem pagamento. O banco falso guarda o texto como recebeu, e por isso a regressão passava | **FIXED** — `instanteCanonico()` em todo instante que entra numa chave; a regressão do FP3A-1 passou a gravar `status_evento_em` no formato do PostgREST e a entregar um segundo evento do mesmo estado; sabotagem pega (a chave `+00:00` volta a aparecer) |
| FP4B-1 | MEDIUM | CR-05 | o mesmo, reproduzido pela rota pública de status seguida do `PAYMENT_RECEIVED` | **DUPLICATE** de FP4A-1 |
| FP4C-1 | MEDIUM | CR-05 | o mesmo, reproduzido por retomada da inbox e por nova entrega | **DUPLICATE** de FP4A-1 |
| FP4A-2 | INFO | CR-05 | uma reconfirmação a menos de 5 min do aviso anterior, somada a uma queda entre a transição e a outbox, ainda perde o segundo aviso | **RISK_ACCEPTED** RES-64 — a folga existe porque os relógios são de lados diferentes; reconfirmação exige ação humana na Asaas (baixa desfeita) ou uma disputa resolvida, e as duas levam mais que isso |
| FP4B-2 | INFO | CR-14 | `POST /api/admin/contratantes` com `id` objeto responde 500 genérico e grava em `erros` | **RISK_ACCEPTED** RES-65 — exige Access e sessão de admin; o processo segue de pé |
| FP4B-3 | INFO | CR-05 | webhook com token válido e `event` objeto responde 503 (inbox indisponível), e a Asaas repetiria | **RISK_ACCEPTED** RES-66 — exige o token; a Asaas nunca manda esse formato |
| FP4B-4 | INFO | CR-13 | os `.catch((erro) => … erro.message)` dos workers lançariam com uma rejeição nula | **RISK_ACCEPTED** RES-67 — nada alcançável rejeita com `null`; mesma família do FP1B-2 |
| FP4C-2 | INFO | doc | a regra dos 5 min e da chave canônica não estava na RN-23 | **FIXED** — RN-23 revista |
| FP4C-3 | INFO | teste | o banco falso devolve o instante no texto em que foi gravado, não no do PostgREST — cego a esta classe | **RISK_ACCEPTED** RES-68 — a regressão do FP4A-1 grava o formato do PostgREST explicitamente; normalizar o banco falso inteiro mexeria em comparações de todas as suítes |
| FP5A-1 | LOW | CR-08 | ciclo de assinatura com baixa manual em dinheiro, desfeita e paga de novo: o `pendente` de assinatura é silencioso e a reconfirmação sai como um segundo `cobranca_confirmada` do mesmo `chargeId` — o contratante que credita por `eventoId` credita dois períodos. Anterior à remediação | **RISK_ACCEPTED** RES-69 — exige baixa em dinheiro e desfazê-la no painel num ciclo de cartão; o `API.md` passa a mandar creditar o ciclo uma vez por `chargeId` |
| FP5A-2 | INFO | CR-05 | evento sem `dateCreated` que aplica um "de novo" não grava carimbo, e a retentativa montaria outra chave | **RISK_ACCEPTED** RES-70 — a Asaas e todo evento sintético sempre mandam `dateCreated`, e a inbox o guarda |
| FP5A-3 | INFO | CR-05 | a passada sintética que falha entre a transição e a outbox, com a linha da inbox já esgotada, deixa o reconciliador vendo os dois lados iguais | **DUPLICATE** de FP1RA-5 (RES-26/RES-27 no ledger original) |
| FP5A-4 | INFO | doc | o comentário dizia que só o webhook escreve `status_evento_em`; `aplicarTransicaoPorCheckoutId` também escreve | **FIXED** — comentário corrigido |

## 7. Correções

24 commits na branch `claude/nifty-meitner-4ffp9s` sobre `43635c4` (PR #50): 3 de evidência (baseline, relatório do Jules e o merge dele, sem alteração), 1 do ledger antes do código, e os demais de correção e de registro. Lista completa: `git log --reverse 43635c4..HEAD`. Os que mudam código:

| Commit | Escopo |
|---|---|
| `a5d552e` | CR-01 — identificador canônico em toda fronteira |
| `69b5228` | CR-02 — estorno durável e idempotente |
| `d651f62` | CR-03 — instrumento só volta se ainda é o do pedido |
| `c8f4e20` | CR-04 — saída nunca segue redirect |
| `af6f597` | CR-05 — webhook confere na Asaas; reconciliador dirigido |
| `5475d69` | CR-06/CR-08 — janelas de crash, promessas, assinatura |
| `8be71d3` | CR-07/09/11/12/13/14/15 — Access na origem, segredos, CAS, NEW-01/02 |
| `8c96576` | CI — chaves de mentira, cooldown no Dependabot (achado do semgrep da própria PR) |
| `baa3a88` | ciclo adversarial 1 — C1-01…C1-15 |
| `ba36881` | ciclo adversarial 2 — C2-M1, C2-L1, C2-L2 |
| `7c0c94d` | ciclo 2, segundo revisor — C2-L2b…C2-L5; evidências imutáveis por hash |
| `ccfedc5` | auditoria do diff — DIF-01, DIF-03, DIF-04 (+ documentação DIF-05…07) |
| `0808a13` | passada limpa #1 — CP1-01, CP1-02 |
| `1b6a5b7` | passada limpa #1, 2ª tentativa — CP2-01 |
| `6ebc923` | passada limpa #1, 2ª tentativa — CP2-10, CP2-11 |

Migrations: **0018** (estornos) e **0019** (uma troca em voo) aplicadas em produção; **0020** (grants públicos) escrita e testada, aplicação pendente (EP-02). Depois de aplicá-la, conferir `has_function_privilege('service_role', 'public.registrar_erro(…)', 'EXECUTE')` para `registrar_erro`, `registrar_rejeicoes_webhook` e `resumo_rejeicoes_webhook`: a 0020 tira o EXECUTE de `PUBLIC`, e sem o grant próprio do `service_role` a captura de erro — para onde vão os alertas humanos — pararia calada (FP1C-1, provado num Postgres descartável).

### 7.1 Classificação de todo o diff (`43635c4` → HEAD)

Gerada por script sobre `git diff --numstat`, que **falha** se algum arquivo ficar sem classe; cada justificativa conferida contra o diff do próprio arquivo (três estavam imprecisas na primeira versão e foram corrigidas). A verificação das regressões que o diff poderia ter introduzido está na §7.2.

| Arquivo | Linhas | Classe | Justificativa |
|---|---|---|---|
| `.env.example` | +14 −0 | DOCUMENTATION | variáveis opcionais novas, comentadas (CF_ACCESS_CERTS_URL só loopback, ASAAS_WEBHOOK_IP_ESTRITO) |
| `.github/dependabot.yml` | +26 −0 | SECURITY_FIX | CI: permissions de leitura, ferramentas fixadas por hash, Dependabot com cooldown (SEC-034) |
| `.github/workflows/ci.yml` | +6 −0 | SECURITY_FIX | CI: permissions de leitura, ferramentas fixadas por hash, Dependabot com cooldown (SEC-034) |
| `.github/workflows/seguranca.yml` | +18 −3 | SECURITY_FIX | CI: permissions de leitura, ferramentas fixadas por hash, Dependabot com cooldown (SEC-034) |
| `.gitleaksignore` | +11 −0 | SECURITY_FIX | impressões digitais das chaves de MENTIRA dos testes e do token meta público (CI da PR) |
| `.ia/HANDOFF.md` | +1 −1 | DOCUMENTATION | contagem de suítes |
| `API.md` | +142 −24 | DOCUMENTATION | comportamento novo documentado onde o integrador/operador lê |
| `CLAUDE.md` | +1 −1 | DOCUMENTATION | contagem de suítes (63 → 82) |
| `CONSTRAINTS.md` | +85 −7 | DOCUMENTATION | comportamento novo documentado onde o integrador/operador lê |
| `README.md` | +1 −1 | DOCUMENTATION | contagem de suítes (63 → 82) |
| `RUNBOOK.md` | +35 −5 | DOCUMENTATION | comportamento novo documentado onde o integrador/operador lê |
| `docs/CHECKOUT_CONSOLIDATION_STATE.md` | +1 −1 | DOCUMENTATION | tira um fragmento de sufixo de chave do documento (INFO-12) |
| `docs/SECURITY_STATION_6_BASELINE_2026-09-25.md` | +553 −0 | DOCUMENTATION | evidência imutável: baseline pré-correção (hash travado) |
| `docs/SECURITY_STATION_6_JULES_REVIEW_2026-09-25.md` | +91 −0 | DOCUMENTATION | evidência imutável: revisão do Jules (hash travado) |
| `docs/SECURITY_STATION_6_REMEDIATION_2026-09-25.md` | +691 −0 | DOCUMENTATION | este relatório |
| `docs/TESTES.md` | +31 −0 | DOCUMENTATION | regras novas (RN-61…RN-69), pendências, passo a passo de teste |
| `docs/funcional.md` | +310 −3 | DOCUMENTATION | regras novas (RN-61…RN-69), pendências, passo a passo de teste |
| `docs/pendencias.md` | +71 −3 | DOCUMENTATION | regras novas (RN-61…RN-69), pendências, passo a passo de teste |
| `functions/api/admin/[[caminho]].js` | +71 −0 | SECURITY_FIX | Pages Function: o painel fala com a API atrás do Access (SEC-015) |
| `package-lock.json` | +12 −12 | SECURITY_FIX | express 4.22.3 / body-parser / qs 6.16.0 (SEC-033), sem --force |
| `public/js/admin.js` | +8 −8 | SECURITY_FIX | encodeURIComponent nos ids e filtros das chamadas do painel (SEC-026) |
| `public/js/modules/assinaturaCheckoutHandler.js` | +2 −2 | SECURITY_FIX | encodeURIComponent em todo segmento de URL (SEC-026) |
| `public/js/modules/assinaturaHandler.js` | +1 −1 | SECURITY_FIX | encodeURIComponent em todo segmento de URL (SEC-026) |
| `public/js/modules/assinaturaPixHandler.js` | +2 −2 | SECURITY_FIX | encodeURIComponent em todo segmento de URL (SEC-026) |
| `public/js/modules/boletoHandler.js` | +2 −2 | SECURITY_FIX | encodeURIComponent em todo segmento de URL (SEC-026) |
| `public/js/modules/cartaoHandler.js` | +2 −2 | SECURITY_FIX | encodeURIComponent em todo segmento de URL (SEC-026) |
| `public/js/modules/pedidoHandler.js` | +1 −1 | SECURITY_FIX | encodeURIComponent em todo segmento de URL (SEC-026) |
| `public/js/modules/pixHandler.js` | +2 −2 | SECURITY_FIX | encodeURIComponent em todo segmento de URL (SEC-026) |
| `public/js/status.js` | +1 −1 | SECURITY_FIX | encodeURIComponent em todo segmento de URL (SEC-026) |
| `public/js/utils/api.js` | +9 −1 | SECURITY_FIX | o admin chama a mesma origem, atrás do Access (SEC-015) |
| `scripts/checar.mjs` | +1 −1 | TEST | análise de sintaxe inclui functions/ |
| `scripts/ensaio-restauracao.sh` | +7 −0 | MIGRATION | ensaio de restauração cria os papéis que a 0020 revoga |
| `src/config/asaas.js` | +4 −1 | SECURITY_FIX | encodeURIComponent no id da sessão na URL do checkout que o navegador abre (SEC-001) |
| `src/config/supabase.js` | +24 −1 | CORRECTNESS_FIX | teto de 20 s e sem redirect no cliente do banco (INFO-09) |
| `src/controllers/adminController.js` | +32 −6 | SECURITY_FIX | chave da subconta fora do log e da resposta; link só https (SEC-016/032) |
| `src/controllers/asaasCheckoutController.js` | +115 −11 | SECURITY_FIX | sessão só para o mesmo pagador (NEW-02, C1-05), logs sem corpo cru (SEC-028) |
| `src/controllers/assinaturaController.js` | +88 −12 | CORRECTNESS_FIX | arrendamento devolvido no sucesso, falha local vira erros (SEC-029, SEC-013) |
| `src/controllers/checkoutController.js` | +265 −39 | CORRECTNESS_FIX | instrumento só volta se ainda é o do pedido, pelo preço da tela (SEC-004/005) |
| `src/controllers/cobrancaConsultaController.js` | +26 −6 | CORRECTNESS_FIX | CAS e binding de valor na consulta de status; a confirmação descoberta entra pelo webhook (SEC-022, C1-10, FP2RA-1) |
| `src/controllers/refundController.js` | +148 −375 | CORRECTNESS_FIX | estorno delegado à operação durável (SEC-002); só avisa se a rota gravou (FP2RA-2) — o grosso da remoção (-375) é a lógica antiga movida para estornoService |
| `src/controllers/trocaAprovacaoController.js` | +10 −2 | SECURITY_FIX | token da troca só texto e só UUID; handlers com try/catch (CP2-11) |
| `src/controllers/trocaPlanoController.js` | +51 −12 | RECOVERY | uma troca em voo, aviso com dono (SEC-010/013) |
| `src/controllers/webhookController.js` | +1060 −95 | SECURITY_FIX | confere na Asaas antes de mover dinheiro, ordem, reconciliador dirigido, ciclos, teto de resposta, alertas humanos antes da transição, reserva sem linha (SEC-007/008/019, JULES-004, C1-02/03/06/09/11, C2-L1/L2, CP3-05, FP1A-4, FP1B-2, FP1RA-1/2, FP2A-1 — uma passada por charge, FP3A-1 — o "de novo" pelo que está gravado) |
| `src/middlewares/exigirAccess.js` | +74 −0 | SECURITY_FIX | guarda do Access em /api/admin, fecha em 401/503 (SEC-015, C1-01) |
| `src/middlewares/idsCanonicos.js` | +37 −0 | SECURITY_FIX | guarda canônica dos parâmetros de id (SEC-001/003/017) |
| `src/routes/adminRoutes.js` | +15 −5 | SECURITY_FIX | Access antes de toda rota do admin (SEC-015); roteador com dono (C1-01) |
| `src/routes/asaasCheckoutRoutes.js` | +5 −2 | CORRECTNESS_FIX | roteador com dono (C1-01) e guarda canônica (SEC-001) |
| `src/routes/assinaturaRoutes.js` | +2 −2 | CORRECTNESS_FIX | roteador com dono (C1-01) e guarda canônica (SEC-001) |
| `src/routes/checkoutRoutes.js` | +5 −2 | CORRECTNESS_FIX | roteador com dono (C1-01) e guarda canônica (SEC-001) |
| `src/routes/pedidoRoutes.js` | +5 −2 | CORRECTNESS_FIX | roteador com dono (C1-01) e guarda canônica (SEC-001) |
| `src/routes/planoRoutes.js` | +5 −2 | CORRECTNESS_FIX | roteador com dono (C1-01) e guarda canônica (SEC-001) |
| `src/routes/refundRoutes.js` | +2 −2 | CORRECTNESS_FIX | roteador com dono (C1-01) e guarda canônica (SEC-001) |
| `src/routes/trocaAprovacaoRoutes.js` | +2 −2 | CORRECTNESS_FIX | roteador com dono (C1-01) e guarda canônica (SEC-001) |
| `src/routes/webhookRoutes.js` | +2 −2 | CORRECTNESS_FIX | roteador com dono (C1-01) e guarda canônica (SEC-001) |
| `src/server.js` | +134 −35 | SECURITY_FIX | Access na origem, app com dono, saúde com workers, teto dos workers (SEC-015/031, C1-01) |
| `src/services/asaasService.js` | +132 −26 | SECURITY_FIX | caminhos canônicos, texto da Asaas redigido, leitura de pagamento para conferir (SEC-017/028, SEC-007, C1-10) |
| `src/services/assinaturaService.js` | +17 −8 | RECOVERY | upsert/vínculos relançam em vez de engolir (SEC-014) |
| `src/services/auditoriaWebhookService.js` | +2 −1 | CORRECTNESS_FIX | promessa da descarga de rejeições com dono (SEC-013) |
| `src/services/cobrancaService.js` | +191 −48 | CORRECTNESS_FIX | escrita condicional, delete condicional, estorno só sobe; 23505 do ciclo só é duplicado se o charge existe (SEC-022/025, NEW-01, FP1A-1) |
| `src/services/estornoService.js` | +457 −0 | CORRECTNESS_FIX | estorno durável e idempotente, reconciliação que não repete (SEC-002, C1-04, C2-M1, FP2RA-2) |
| `src/services/outboxService.js` | +54 −10 | SECURITY_FIX | entrega sem seguir redirect, destino revalidado, orçamento de passada; devolve o criado_em da linha existente (SEC-006, C1-07, FP3A-1) |
| `src/services/pedidoService.js` | +30 −10 | SECURITY_FIX | id canônico na URL de saída do pull (SEC-001) |
| `src/services/transicoesFinanceiras.js` | +85 −8 | CORRECTNESS_FIX | sair de chargeback só por disputa; caminhos para o reconciliador (SEC-019, JULES-004) |
| `src/services/trocaExecucaoService.js` | +165 −64 | RECOVERY | cobrança do acerto nunca fica órfã; arrendamento não volta em falha ambígua (SEC-009/010) |
| `src/services/trocaIntencaoService.js` | +44 −2 | RECOVERY | vínculo do acerto por CAS (SEC-009) |
| `src/services/trocaSweeperService.js` | +126 −11 | RECOVERY | sweeper acha o acerto pela referência na Asaas (SEC-009) |
| `src/services/webhookInboxService.js` | +87 −9 | RECOVERY | CAS respeita recuo, reenvio zera tentativas, candidatas à divergência (SEC-023/024, JULES-004) |
| `src/utils/accessJwt.js` | +324 −0 | SECURITY_FIX | verificação RS256 do JWT do Access na origem (SEC-015, C1-01, C1-15) |
| `src/utils/alvoDeRede.js` | +108 −11 | SECURITY_FIX | faixas de rede completas; destino revalidado (SEC-006/021) |
| `src/utils/erros.js` | +21 −0 | SECURITY_FIX | erro da Asaas 401/403/5xx vira 502 genérico (INFO-11) |
| `src/utils/passadas.js` | +91 −0 | OBSERVABILITY | uma passada por vez (SEC-023) e worker atrasado derruba a saúde (SEC-031) |
| `src/utils/rotaSegura.js` | +73 −0 | CORRECTNESS_FIX | handler que lança não derruba o processo; falha sem Error nunca vira next(), e o erro do banco chega com code e mensagem (C1-01, C2-L4, FP1B-1, FP1RB-1/2) |
| `src/utils/validadores.js` | +163 −30 | SECURITY_FIX | tipo na fronteira, teto de tamanho, comparação sem vazar tamanho (SEC-027, INFO-05) |
| `supabase/migrations/0018_estornos_idempotentes.sql` | +66 −0 | MIGRATION | estornos como operação durável (SEC-002) — aditiva, aplicada |
| `supabase/migrations/0019_uma_troca_em_voo_por_assinatura.sql` | +35 −0 | MIGRATION | uma troca em voo por assinatura (SEC-010) — índice parcial, aplicada |
| `supabase/migrations/0020_anon_e_authenticated_sem_privilegio.sql` | +45 −0 | MIGRATION | revoga grants de anon/authenticated (INFO-13) — pendente EP-02; o código não depende dela |
| `tests/access-de-teste.js` | +64 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/acerto-de-troca-nunca-fica-orfao.js` | +244 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/admin-so-pelo-access.js` | +285 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/assinatura-nasce-inteira.js` | +311 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/banco-falso/supabase-falso.mjs` | +137 −18 | TEST | infraestrutura de teste: escrita condicional real, índices únicos, join de contratantes e latência opcional (JITTER_MS) |
| `tests/banco-sem-privilegio-publico.js` | +70 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/ci-so-le-e-fixa-o-que-roda.js` | +63 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/erro-da-asaas-nao-vaza.js` | +116 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/escrita-de-estado-e-condicional.js` | +554 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/estorno-repetido-nao-devolve-duas-vezes.js` | +971 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/executar.js` | +19 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/filtro-or-so-interpola-o-que-o-servidor-fez.js` | +79 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/identificador-canonico-em-toda-fronteira.js` | +219 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/instrumento-obsoleto-nunca-volta.js` | +207 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/nenhuma-chamada-de-saida-sem-teto.js` | +6 −2 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/nenhuma-promessa-sem-dono.js` | +144 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/o-que-os-documentos-afirmam.js` | +58 −2 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/outbox-sobrevive-a-reinicio.js` | +17 −3 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/pagamento-de-um-pedido-invalida-as-irmas.js` | +42 −21 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/rota-que-lanca-nao-derruba-o-processo.js` | +318 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/rotas-http-respondem-como-prometido.js` | +19 −2 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/saida-nunca-segue-redirecionamento.js` | +137 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/segredo-nao-sai-do-admin.js` | +62 −2 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/senha-nao-fica-no-navegador.js` | +10 −3 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/sessao-de-assinatura-nao-vaza-por-cpf.js` | +163 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/uma-assinatura-viva-por-plano.js` | +105 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |
| `tests/webhook-confere-na-asaas.js` | +649 −0 | TEST | regressão de classe, com sabotagem (ver §8 e §9) |

### 7.2 Auditoria de regressões do diff (`43635c4` → `7c0c94d`)

Dois revisores independentes sobre o diff inteiro, com a lista de verificação fixa. Cada item foi verificado no código antes de contar. **Achado real pediu código — o contador de passadas limpas continua em 0.**

| Pergunta | Resposta | Onde |
|---|---|---|
| Quebra de API para o integrador | intencionais e documentadas (estorno parcial com chave, 502 para falha da Asaas, 409s novos, Access no admin); **a regra de id não estava no `API.md`** → DIF-05 | `API.md` §3, §5.4, §6.3, §10 |
| Mudança comercial / de preço | **nenhuma** — taxa, parcelamento, valor do plano e momento da cobrança iguais; só deixou de reaproveitar sessão de preço antigo | — |
| Mudança de entitlement | eventos e formatos da outbox iguais; bloqueio de 2ª assinatura documentado, **com a ressalva de "ativa aqui" que faltava** → DIF-06 | `API.md` §2 |
| Nova race / deadlock / vazamento de arrendamento | nenhuma nova confirmada; dois pré-existentes reabertos → DIF-08, DIF-09 | — |
| Chamada externa duplicada | nenhuma nova (um DELETE repetido da assinatura antiga em confirmação concorrente, idempotente na Asaas) → DIF-09 | — |
| Nova janela de crash | **cobrança substituída e liquidada ficava invisível** → DIF-03 | `transicoesFinanceiras.js` |
| Migration incompatível | nenhuma: o HEAD **não depende** da 0020; depende da 0018/0019, já aplicadas; o código antigo roda com elas | — |
| Callback / webhook incompatível | nenhuma: autenticação igual (IP estrito desligado), `200` em até 8 s, assinatura e formato da nossa notificação iguais | RN-67 |
| Fronteira de tenant | nenhuma consulta nova sem `contratante_id` | — |
| Comportamento não documentado | DIF-05, DIF-06, DIF-07 | — |
| Repetição bloqueada por estado | **estorno negado não podia ser pedido de novo** → DIF-01; **chave do total fechada por condição provisória** → DIF-04 | `estornoService.js` |

| ID | Sev. | Classe | Achado | Status final |
|---|---|---|---|---|
| DIF-01 | MEDIUM | CR-02 | estorno de boleto negado pela Asaas não podia ser pedido de novo: a chave padrão devolvia o `200` antigo sem chamar a Asaas, e uma chave nova recebia "não há valor restante" — regressão contra o `API.md` §5.4 | **FIXED** — o `REFUND_DENIED` reabre a operação; o negado não conta no restante (RN-71) |
| DIF-02 | MEDIUM | CR-09 | quem tem o CPF cancela a pop-up aberta de outra pessoa | **DUPLICATE** de C1-05b |
| DIF-03 | MEDIUM | CR-05 | cobrança substituída (`cancelado`) que a Asaas liquidou no mesmo instante: dinheiro recebido, evento travado, reconciliador sem caminho | **FIXED** — `cancelado → confirmado` com o respaldo da Asaas; vira duplicidade (RN-70) |
| DIF-04 | LOW | CR-02 | a chave padrão do estorno total era fechada de vez (`FAILED_FINAL`) por um "não cabe" provisório (outro estorno em voo) | **FIXED** — só fecha com nada em voo (RN-71) |
| DIF-05 | LOW | doc | regra de id canônico (`[A-Za-z0-9_-]{1,128}`, texto) fora do `API.md` | **FIXED** — `API.md` |
| DIF-06 | LOW | doc | a "assinatura ativa" do `409 assinatura_ja_existe` é o registro local, que só muda na conciliação | **FIXED** — `API.md` §2 |
| DIF-07 | INFO | CR-11 | `/api/saude` 503 com worker atrasado derrubaria o serviço se virasse liveness do Northflank | **FIXED** — medido: nenhum health check configurado; RUNBOOK §6.3 manda usar como readiness, nunca liveness |
| DIF-08 | LOW | CR-07 | `liberarTroca`/`liberarEstorno` soltam o arrendamento sem conferir o dono (pré-existente; o diff acrescenta chamadores) | **RISK_ACCEPTED** RES-12 — exige processo travado além do arrendamento de 5 min, acima do teto de 20 s de toda chamada |
| DIF-09 | LOW | CR-08 | duas confirmações simultâneas da renovação podem mandar dois DELETE da assinatura antiga | **RISK_ACCEPTED** RES-13 — o segundo DELETE é idempotente na Asaas e só gera uma linha em `erros` |

## 8. Testes de regressão

**82 suítes**, `npm run check` verde (análise de sintaxe de todo JS, inclusive `public/js/`, e as suítes). Suítes novas desta rodada, uma por classe: `identificador-canonico-em-toda-fronteira`, `estorno-repetido-nao-devolve-duas-vezes`, `instrumento-obsoleto-nunca-volta`, `saida-nunca-segue-redirecionamento`, `webhook-confere-na-asaas`, `acerto-de-troca-nunca-fica-orfao`, `nenhuma-promessa-sem-dono`, `uma-assinatura-viva-por-plano`, `assinatura-nasce-inteira`, `admin-so-pelo-access`, `escrita-de-estado-e-condicional`, `erro-da-asaas-nao-vaza`, `ci-so-le-e-fixa-o-que-roda`, `sessao-de-assinatura-nao-vaza-por-cpf`, `filtro-or-so-interpola-o-que-o-servidor-fez`, `banco-sem-privilegio-publico`, `rota-que-lanca-nao-derruba-o-processo`.

O banco falso (`tests/banco-falso/`) foi corrigido para responder como o PostgREST onde isso decide teste — número comparado como número, `not.` dentro de `.or()`, índice único no UPDATE, `maybeSingle` com duas linhas é erro, projeção de colunas na escrita — e ganhou checagem própria (C1-12). Antes disso, a guarda do estorno só era testada numa cópia escrita à mão (C1-08).

## 9. Resultados de sabotagem

Protocolo por correção: verde → sabotar a correção → **vermelho pela asserção certa** → restaurar → verde. Sabotagem que passou é lacuna de teste, e foi fechada antes de contar.

| Classe / rodada | Sabotagens | Pegas | Lacunas achadas e fechadas |
|---|---|---|---|
| CR-01 | 10 | 10 | — |
| CR-02 (estorno) | 13 | 13 | — |
| CR-03 | 12 | 12 | 1ª rodada |
| CR-04 | 9 | 9 | — |
| CR-05 | 23 | 23 | — |
| CR-06/CR-08 | 22 | 22 | 3 (CAS nunca exercitado no serviço real; banco falso sem upsert) |
| CR-07/09/11–15 + NEW | 50 | 50 | 4 (H1, H9, H11, N5) |
| CI (Dependabot) | 1 | 1 | — |
| Ciclo 1 (C1-01…C1-15) | 24 | 24 | 2 (camada do decodificador sem prova própria; teste do buscador que pegava a sabotagem por travar, não por asserção) |
| Ciclo 2 (C2-*) | 6 | 6 | 1 (a sabotagem do L5 mirava o `app` com o handler no roteador — refeita no `roteador`) |
| Auditoria do diff (DIF-*) | 4 | 4 | — |
| Relatórios imutáveis e contador do ledger | 3 | 3 | — |
| Passadas limpas (CP1-01, CP1-02, CP2-01, CP2-10, CP2-11, CP3-05 ×2) | 7 | 7 | CP2-10 era, ela mesma, uma lacuna (achada pelo auditor) |
| Lacunas da 3ª tentativa (CP3-09…18), refeitas contra o HEAD com os testes novos e as 82 suítes inteiras | 48 | 47 | a sobrevivente é `rest-exceto-off`, sem efeito observável (CP3-18, RES-38) |
| Passada final #1 (FP1A-1 ×2, FP1A-4, FP1B-1) | 4 | 4 | — |
| Repetição da passada final #1 (FP1RA-1, FP1RA-2, FP1RB-1) | 3 | 3 | — |
| Passada final #2 (FP2A-1: a fiação da fila, a fila em si, e a fiação de novo contra a regressão ponta a ponta) | 3 | 3 | a regressão ponta a ponta não pegava a sabotagem sem latência da Asaas no dublê — fechada com `atrasoDaAsaasMs` |
| Repetição da passada final #2 (FP2RA-1, FP2RA-2) | 2 | 2 | — |
| Passada final #3 (FP3A-1: o "de novo" só por `aplicada`) | 1 | 1 | — |
| Passada final #4 (FP4A-1: o instante fora da forma canônica na chave) | 1 | 1 | a regressão do FP3A-1 era cega ao formato do PostgREST — fechada gravando `+00:00` |
| **Total** | **246** | **245** | **14**, todas fechadas; 1 sabotagem sem efeito observável, classificada |

**As 48 sabotagens da 3ª tentativa, por classe** (critério do dono de 25/09/2026 — toda SECURITY_CONTROL e FINANCIAL_INVARIANT relevante tem de ser detectada):

| Classe | Quantas | Detectadas | Quais |
|---|---|---|---|
| SECURITY_CONTROL | 23 | 23 | respaldo do provedor (13 variações), sessão da pop-up, origem do webhook, métodos do invólucro de rota (4), camadas do JWT do Access (4) |
| FINANCIAL_INVARIANT | 23 | 23 | CAS, exclusões, prova por valor, espera do boleto, FAILED_FINAL e arrendamentos do estorno (13); matriz de transições (2); reivindicação e CAS da cobrança (3); isenção de assinatura do binding de valor; CAS, reivindicação e validade da intenção de troca (3); `mutation_version` |
| TEST_QUALITY_ONLY | 1 | 1 | o filtro de status de `marcarReconciladas` (conta de observabilidade) |
| NOT_APPLICABLE | 1 | 0 | `excetoId` de `restanteEstornavel` — nenhum chamador alcança o termo (CP3-18) |

## 10. Validações externas

| Item | Fonte | Resultado |
|---|---|---|
| IPs oficiais do webhook da Asaas | documentação da Asaas | 52.67.12.206, 18.230.8.159, 54.94.136.112, 54.94.183.101 — em modo observação (`ASAAS_WEBHOOK_IP_ESTRITO` desligado até a origem real ser medida, EP-04) |
| `POST /v3/installments/{id}/refund` | documentação da Asaas | existe; o efeito sobre as demais parcelas não foi medido → SEC-018 EXTERNAL_PENDING |
| JWT do Access | chave pública real da equipe + token `meta` real | a verificação RS256 aceita a assinatura de verdade da Cloudflare (controle positivo offline) e recusa o `type: meta` |
| Aplicação do Access | API da Cloudflare | 9 destinos, política "Somente o operador"; cópia da configuração anterior guardada antes da mudança |
| gitleaks 8.28.0 / semgrep 1.177.0 | release oficial por SHA-256 / imagem por digest | limpos no CI da PR |
| `npm audit` | registro npm | 0 vulnerabilidades |

## 11. Validação de produção

Tudo só leitura: nenhum pagamento, estorno, cancelamento ou escrita no banco. O boleto e a assinatura reais existentes não foram tocados.

### 11.1 Deploy — e ele serviu o commit errado primeiro

| Momento (UTC) | Fato |
|---|---|
| 22:26:13 | PR #50 mesclada; build de `b8f3b07` criado no Northflank |
| 22:26:20 | um **segundo** build na `main`, de `17c3ef6` (o merge do relatório do Jules, 06:12, só documento) |
| 22:26:34 | os dois `SUCCESS`; o de `17c3ef6` terminou por último e foi o implantado (`buildSHA: latest`) |
| 22:27–22:34 | produção servindo **o código anterior à remediação**: `POST /api/admin/sessao` sem JWT devolvia "Usuário ou senha de admin inválidos." e `/api/saude` não tinha `workersAtrasados` — o painel dizia deploy `COMPLETED` |
| 22:34:17 | build de `b8f3b07` pedido explicitamente pelo sha (`tense-sponge-142`) |
| 22:34:47 | `deployedSHA = b8f3b0754f2f575ad4395f86a9b0382a3d300404` = `main` |

Nenhum evento financeiro passou pela janela errada: o último evento da inbox é de 20:18 e a última notificação da outbox de 15:30. O porquê do segundo build não foi descoberto (a API de builds com o token da organização exige `teamId`). O que fica é a regra: `COMPLETED` não diz qual commit, então confere-se o `deployedSHA` **e** o comportamento. Está escrita no `RUNBOOK` §3.

### 11.2 Conferências, depois de `b8f3b07` no ar

| Conferência | Resultado |
|---|---|
| `/api/saude` | `200`, `{"status":"ok","supabase":true,"atrasados":[]}` — os workers batem ponto |
| `/api/admin/sessao`, `/api/admin/contratantes`, `/API/ADMIN/contratantes` sem JWT do Access | `401 acessoRestrito` nas três (o caminho em maiúsculas não contorna) |
| JWT forjado com `alg` objeto (C1-01) | `401`; `/api/saude` `200` logo depois, e o log mostra só `JWT recusado (formato)` — o processo não caiu |
| Access na frente do painel | `302` para o login da equipe em `/admin`, `/admin.html` e `/api/admin/*`, no domínio e no `pages.dev` |
| Webhook sem token / com token errado | `401` / `401`; caminho inventado `404` |
| Cabeçalhos da API | `nosniff`, `no-store`, CORS de origem única (`checkout.sancocore.com.br`), HSTS de 1 ano |
| Páginas públicas | `/` `200`; `termos`, `privacidade` e `status.html` `308` para o caminho sem `.html` |
| Migrations | 0001–0019 no histórico do Supabase; **0020 não aplicada** (EP-02) |
| Inbox | 7 `processado`, 1 `ignorado`; nada `recebido`, `processando` ou `falhou` |
| Outbox | 4 `enviada`; nada `pendente`, `enviando`, `falhou` ou `abandonada` |
| `erros` nas últimas 24 h | só os três do incidente das 01:24 (Pix sem chave; `docs/erros/2026-09-25-primeiro-pagamento-real-pix-sem-chave-e-assinatura-com-vencimento-utc.md`); nenhum depois do deploy |
| Webhook na Asaas (lido de dentro do contêiner) | `enabled`, não `interrupted`, `sendType: SEQUENTIALLY`, 0 requisições penalizadas, 61 eventos, dos quais 7 `SUBSCRIPTION_*` |
| Health check do Northflank | **nenhum configurado** (`healthChecks: []`) em 25/09 — configurado em 26/09/2026 (readiness TCP, EP-06 fechado) |
| `npm audit` | 0 vulnerabilidades |

### 11.3 A sonda de IP forjado (JULES-002, INFO-06)

`POST /api/webhooks/asaas` com token errado e `X-Forwarded-For: 203.0.113.99`, e o IP lido de volta da amostra em `webhook_rejeicoes`:

| Código servido | IP gravado |
|---|---|
| `17c3ef6` (antes da remediação, 22:27:36) | `203.0.113.99` — o forjado |
| `b8f3b07` (22:59:57) | `160.79.106.139` — a saída real desta sessão (o proxy dela roda em `160.79.106.0/24`) |

O servido por engano virou o **controle positivo**: a mesma sonda, contra o código velho, grava o que o atacante escreveu, então ela distingue. Contra o código novo, grava o IP que chegou de fato — nem o forjado, nem o do proxy da Northflank. O limitador chaveia por esse mesmo `req.ip`, então o `trust proxy 1` não é estrito demais nem contornável. **JULES-002 é FALSE_POSITIVE, e INFO-06 está conferido em produção.** Continua não medido se algum cliente chega por IPv6 (RES-41).

### 11.4 O que ficou de fora, e por quê

Nada disto se resolve sem o dono ou sem dinheiro novo:

- ✅ **EP-01**: login do operador pelo Access — feito pelo dono em 26/09/2026.
- ✅ **EP-02**: aplicar a 0020, e depois conferir o `EXECUTE` do `service_role` — aplicada em 26/09/2026 pelo MCP do Supabase, com a aprovação do dono; conferência feita (INFO-13).
- **EP-03**: estorno de parcela no sandbox.
- **EP-04**: origem real do webhook antes do modo estrito.
- **EP-05**: prazo de retenção.
- ✅ **EP-06**: health check do Northflank — configurado em 26/09/2026 como readiness TCP na porta 3001, sem liveness (SEC-031).
- **EP-07**: branch protection.
- **EP-08**: oráculo do `409`.
- **EP-10**: boleto com estorno negado.
- **EP-11**: amarração da primeira pop-up no próximo cartão real.

## 12. Invariantes financeiras

| # | Invariante | Como está garantida | Prova |
|---|---|---|---|
| 1 | Duas cobranças por pagamento lógico nunca | reserva única antes da Asaas + `externalReference reserva-<id>` + reconciliador | `dez-cliques-uma-sessao`, `instrumento-obsoleto-nunca-volta` |
| 2 | Dois estornos na repetição nunca | operação durável por chave; ausência só provada se a Asaas não pode ter este estorno (C1-04) | `estorno-repetido-nao-devolve-duas-vezes` §7d |
| 3 | Pedido pago não paga de novo | guarda de pedido pago antes de todo instrumento (RN-04.1) | `pagamento-de-um-pedido-invalida-as-irmas` |
| 4 | Instrumento obsoleto nunca usável | irmãs invalidadas na Asaas; reaproveitamento reconfere | idem + `instrumento-obsoleto-nunca-volta` |
| 5 | Preço exibido = cobrado | cotação imutável; binding de valor no webhook e na consulta (C1-10) | `webhook-confere-na-asaas`, `escrita-de-estado-e-condicional` |
| 6 | A não altera B | guarda por chave e `contratante_id`; JULES-001 refutado | `identificador-canonico-em-toda-fronteira` |
| 7 | Sessão concluída ≠ pago | `CHECKOUT_PAID` só carimba `sessao_concluida_em` | `assinatura-nasce-inteira` |
| 8 | Webhook duplicado sem efeito duplicado | inbox por impressão digital + CAS + chave do fato na outbox | `webhook-confere-na-asaas`, `escrita-de-estado-e-condicional` (C1-09) |
| 9 | Fora de ordem não destrói estado | máquina de estados; transição que não se aplica lança e é reaplicada | `webhook-confere-na-asaas` S8/S9 |
| 10 | Crash não cria operação invisível | reserva/operação gravada antes da rede; sweeper e reconciliadores; handler que lança não mata o processo (C1-01) | `acerto-de-troca-nunca-fica-orfao`, `rota-que-lanca-nao-derruba-o-processo` |
| 11 | Callback perdido recuperável | reconciliador de reservas e dirigido; polling com o mesmo binding | `webhook-confere-na-asaas`, autoteste C1-11 |
| 12 | Pagamento duplicado real detectado | dois pagamentos da mesma reserva/pedido viram `erros` + `pagamentoDuplicado` (RN-52) | `pagamento-de-um-pedido-invalida-as-irmas` |
| 13 | Provedor reconcilia estado divergente | reconciliador dirigido leva ao estado da Asaas pelos passos permitidos, sem ficar preso (C1-11) | autoteste `webhookController` |
| 14 | Estorno acumulado ≤ elegível | restante = cobrado − max(local, confirmadas) − em voo; CAS de "só sobe" | `estorno-repetido-nao-devolve-duas-vezes`, `escrita-de-estado-e-condicional` (C1-08) |

As catorze estão provadas **em teste**, com sabotagem. Em produção, nenhuma foi exercitada com dinheiro novo — proibido nesta rodada; a §11 registra o que foi conferido só lendo.

## 13. Ciclos de convergência

Passada **limpa** = nenhum achado novo confirmado que exija mudança de código. INFO, observação arquitetural ou endurecimento opcional sem exploit não quebram a passada, mas entram no ledger. Qualquer achado que peça código **zera o contador**.

| Ciclo | Sobre | Revisores | Achados que pediram código | Contador depois |
|---|---|---|---|---|
| 1 | `8be71d3`…`8c96576` | 4 (dinheiro; admin/Access; webhook/crash/workers; tenant/entrada/testes) | 3 HIGH, 6 MEDIUM, 6 LOW (C1-01…C1-15) | 0 |
| 2 | `baa3a88` / `ba36881` | 2 (dinheiro e correções novas; auth/crash/entrada/testes, com 918 requisições de fuzz no `server.js` real) | 1 MEDIUM, 6 LOW (C2-*) | 0 |
| auditoria do diff | `43635c4` → `7c0c94d` | 2 (contratos e compatibilidade; concorrência e janelas de crash) | 2 MEDIUM + 1 LOW de código, 2 de documentação (DIF-*) | 0 |
| passada limpa #1 | `ccfedc5` | 3 (dinheiro/estado — **não limpo**; crash/auth/tenant com ~51 mil requisições hostis e 14 sabotagens — **limpo**; regressões do diff — **limpo**) | 1 MEDIUM (CP1-01) + 1 INFO endurecido; 12 INFO classificados | 0 |
| passada limpa #1 (2ª tentativa) | `d9adebe` | 3 (dinheiro/estado — **não limpo**; regressões do diff — **não limpo**, 2 de documentação; crash/auth/tenant com 24 sabotagens e sondas no `server.js` real — **não limpo**, 1 lacuna de teste) | 1 LOW de código (CP2-01), 2 LOW de documentação (CP2-07/08), 1 LOW de teste (CP2-10); INFO classificados | 0 |
| passada limpa #1 (3ª tentativa) | `6ebc923` | 3 (dinheiro/estado — **não limpo**, 1 LOW de código; regressões do diff — **não limpo**, 2 de documentação; crash/auth/testes com 81.285 requisições hostis e 151 sabotagens — **não limpo**, 48 sabotagens sobreviventes) | CP3-05 (LOW de código); CP3-09…CP3-17 (lacunas de teste, nenhum comportamento inseguro novo em produção); INFO classificados | 0 |

**Critério revisto pelo dono em 25/09/2026, a partir do HEAD que integra os testes da 3ª tentativa:** a passada deixa de ser "sem achado que peça código" e passa a ser "sem CRITICAL, HIGH, bloqueador financeiro, bypass de tenant/autorização, possibilidade real de cobrança ou estorno em dobro, direito sem pagamento, pagamento sem direito, evento financeiro perdido ou operação órfã, nem MEDIUM estrutural em dinheiro, tenant, credencial, recuperação de queda, fronteira de confiança do webhook, idempotência ou concorrência financeira". LOW, INFO, documentação e lacuna de teste que não revela comportamento inseguro não reiniciam o contador — continuam indo para o ledger com estado final. Depois de integrar a 3ª tentativa, o código funcional congela; seguem exatamente duas passadas finais.

| Passada final | Sobre | Revisores | Achados que reiniciam (critério revisto) | Resultado |
|---|---|---|---|---|
| #1 | `f30191f` (congelado) | 3 (dinheiro — **não limpo**; auth/infra com o `server.js` real e 200 requisições hostis — **limpo**; migrations aplicadas num Postgres 17 descartável e o diff inteiro — **limpo**) | FP1A-1 (MEDIUM estrutural: idempotência e perda permanente de evento financeiro) | corrigido, testado, sabotado; **#1 se repete uma vez** sobre `ba97202` |
| #1 (repetição, a única que o critério permite) | `2c959f0` | 3 (dinheiro — **não limpo**, e todo `23505` do `src/` conferido um a um; auth/infra com o `server.js` real, 30 alvos de SSRF e o invólucro contra Express 4.22.3 — **limpo**; migrations aplicadas três vezes num Postgres 17 descartável com `service_role` conferido depois da 0020, e o diff inteiro — **limpo**) | FP1RA-1 (MEDIUM estrutural, a mesma causa raiz do FP1A-1: o conserto estreitou o caso e não o fechou) | corrigido, testado, sabotado; segue a passada final #2 sobre o HEAD estabilizado, como o critério manda — sem terceira repetição da #1 |
| #2 | `e489cdc` | 3 (dinheiro com latência injetada no banco e na Asaas — **não limpo**; auth/infra com falha de banco injetada em 24 rotas — **limpo**; migrations aplicadas e reaplicadas com dados num Postgres 17 descartável, e o diff inteiro — **limpo**) | FP2A-1 (MEDIUM: aviso dobrado ao contratante, direito sem pagamento) | corrigido, testado, sabotado; **#2 se repete uma vez** sobre o HEAD estabilizado |
| #2 (repetição) | `47520b1` | 3 (dinheiro — **não limpo**; auth/infra com 40 eventos simultâneos no mesmo charge contra a fila nova — **limpo**; migrations reaplicadas com dados e o diff inteiro — **limpo**) | FP2RA-1 (MEDIUM: evento financeiro perdido — a reconfirmação que a tela do pagador gravava por fora) | corrigido, testado, sabotado |
| #3 | `5303359` | 3 (dinheiro, com todo escritor de `cobrancas.status` e todo aviso fora do webhook enumerados — **não limpo**; auth/infra com 40 consultas anônimas simultâneas contra a rota pública que agora dispara o webhook — **limpo**; migrations reaplicadas três vezes com dados e o diff inteiro, com 25 rodadas concorrentes da tela contra o webhook — **limpo**) | FP3A-1 (MEDIUM: a reconfirmação perdida numa falha entre a transição e a outbox — anterior à remediação) | corrigido, testado, sabotado |
| #4 | `b0ebcc7` | 3 (dinheiro, auth/infra e migrations/diff — os três **não limpos**, e os três pelo MESMO achado: FP4A-1 = FP4B-1 = FP4C-1, introduzido pelo conserto do FP3A-1; nenhum achado de autenticação, tenant ou migration) | FP4A-1 (MEDIUM, FINANCIAL_INVARIANT: aviso dobrado por formato de instante) | corrigido, testado, sabotado |

**Critério revisto pelo dono (25/09/2026, depois da #4):** auth/infra e migrations/diff **congeladas** — voltaram limpas em todas as passadas desde a #1 no domínio delas (o único achado da #4 nas duas é o do dinheiro, em arquivos que não são de autenticação nem de schema). Depois de um MEDIUM corrigido, não se rodam mais três auditores completos: regressão e sabotagem específicas, `npm run check` e **uma** auditoria de dinheiro incremental sobre os arquivos alterados e a família do achado. O fechamento não exige um número de passadas limpas; exige zero Critical/High/bloqueador conhecidos, as regressões verdes, as sabotagens pegas e uma auditoria de dinheiro limpa depois da última correção substantiva.

| Auditoria | Sobre | Revisor | Achados que reiniciam | Resultado |
|---|---|---|---|---|
| dinheiro incremental (a única que o critério revisto pede) | `d2fdcbd` — os arquivos alterados desde `5303359` e a família do achado | 1, com todo instante regravado no formato do PostgREST, e 50 rodadas concorrentes dos três escritores (webhook, consulta de status, reconciliador) sobre uma reconfirmação | nenhum | **LIMPA** — FP5A-1 (LOW) e três INFO no ledger |

**Critério de convergência atingido em 25/09/2026:** zero Critical, High, bloqueador financeiro, bypass de autenticação, acesso entre tenants, cobrança ou estorno dobrado, perda permanente de evento financeiro ou cobrança órfã conhecidos; `npm run check` verde; as regressões de todos os achados verdes e as sabotagens pegas; uma auditoria de dinheiro limpa depois da última correção substantiva; auth/infra e migrations/diff limpas e congeladas. **Código congelado** a partir daqui.

## 14. Riscos residuais

Gerada das próprias linhas do ledger: cada RES aponta para o achado que o aceitou, com a justificativa que está escrita lá (quando o ledger só traz o número, vai a descrição do achado). **RES-03 não existe** — o número foi pulado quando o ledger foi montado, e nenhum achado o cita.

**Nenhum CRITICAL ou HIGH está aberto.** Três MEDIUM não estão FIXED, e é aqui que o dono precisa olhar:

| Achado | Estado | O que é, e o que falta |
|---|---|---|
| `C1-05b` | RISK_ACCEPTED (RES-01) | quem tem o CPF do pagador consegue encerrar uma pop-up de assinatura ainda aberta dele (abre uma sessão nova, que substitui a antiga). Não move dinheiro nem dá acesso — derruba uma tentativa de pagamento. Fechar exige um segredo por pagador que a API não tem hoje; **é decisão do dono** se isso vira atualização futura |
| `JULES-003` | RISK_ACCEPTED | arquitetura: o backend único fala com o banco como `service_role`. A defesa em profundidade é a 0020 (INFO-13, EP-02) |
| `SEC-018` | EXTERNAL_PENDING (EP-03) | estorno de cartão parcelado bloqueado pela API (`409`) até a semântica da Asaas ser medida em sandbox |

| RES | Achado(s) no ledger | Por que é aceito (texto do próprio ledger) |
|---|---|---|
| RES-01 | C1-05b | (o achado) quem tem o CPF cancela a sessão aberta da vítima (sem vazar nada; ela reabre) |
| RES-02 | SEC-020 | FIXED `8be71d3` + C1-09 (CAS e refeitura idempotente). A semântica "autorização = confirmado" é (método desligado) |
| RES-04 | FP2A-3, FP2RA-3, RES-53, RES-55, SEC-011 | FIXED `5475d69` (vínculo no 1º evento; recusa do 1º ciclo chama humano). O comportamento da Asaas depois da recusa segue não medido → §14 |
| RES-05 | C1-14 | toda migration roda como `postgres` |
| RES-06 | SEC-030 | EXTERNAL_PENDING EP-05 — o prazo de retenção é decisão jurídica; o hash sem sal é (documento em claro já existe por desenho) |
| RES-07 | INFO-03 | sem entrada de usuário refletida em estilo; |
| RES-08 | INFO-04 | imagem vem do contratante, que já recebe o evento; |
| RES-09 | INFO-07 | `strict-origin-when-cross-origin` não leva a query a terceiro; |
| RES-10 | INFO-08 | reprocesso manual depois de 90 dias é operação de humano; |
| RES-11 | INFO-14 | UX; o pagamento em si é recusado pela Asaas depois de a irmã ser cancelada; |
| RES-12 | DIF-08 | exige processo travado além do arrendamento de 5 min, acima do teto de 20 s de toda chamada |
| RES-13 | DIF-09 | o segundo DELETE é idempotente na Asaas e só gera uma linha em `erros` |
| RES-14 | CP1-03 | nenhum dinheiro sai; exige a negativa no intervalo de uma leitura |
| RES-15 | CP1-04 | antes o pagamento sumia calado, o que era pior; exige a Asaas liquidar sessão que ela deu como cancelada |
| RES-16 | CP1-05 | exige falha de banco num instante exato e novo pedido dentro da janela; a Asaas tende a recusar o segundo pedido de estorno de boleto |
| RES-17 | CP1-06 | a refeitura da inbox fecha; a chave nova já funciona no intervalo (teste 7e) |
| RES-18 | CP1-07 | endurecimento opcional, sem exploração |
| RES-19 | CP1-08 | a API é servida só em HTTPS pela borda; o 301 não é alcançável de fora com `Host` arbitrário na Northflank |
| RES-20 | CP1-09 | resposta é JSON com `content-type` explícito, atrás do Access |
| RES-21 | CP1-10 | nenhuma construção com opções existe em `src/`; endurecimento opcional do teste |
| RES-22 | CP1-11 | decisão registrada (sem resolução de DNS); só admin; o TLS falha |
| RES-23 | CP1-12 | cada linha é reivindicada por CAS; sem efeito duplicado |
| RES-24 | CP1-13 | limitador por IP e a borda da Northflank; sem derrubar o processo (medido) |
| RES-25 | CP1-14 | limitado pelo rate limit e pelo expurgo diário |
| RES-26 | CP2-02, FP5A-3 | exige o webhook esgotar ANTES da consulta confirmar; o esgotamento já vira `erros` para um humano |
| RES-27 | CP2-03, FP5A-3 | a linha esgotada da inbox já está em `erros` |
| RES-28 | CP2-04 | (o achado) o segundo `estorno_solicitado` depois de uma negativa não gera webhook ao contratante (a chave do fato deduplica); a resposta síncrona 200 avisa |
| RES-29 | CP2-05 | exige as duas coisas no intervalo de uma chamada à Asaas |
| RES-30 | CP2-06 | termina em `erros` para um humano; o comportamento da Asaas para cartão/Pix não foi medido |
| RES-31 | CP2-12 | cinto e suspensório de propósito; o assíncrono, que é o que importa, é provado |
| RES-32 | CP2-14 | a Asaas sempre manda `id` |
| RES-33 | CP3-03 | método desligado nesta conta (`CONSTRAINTS.md` §2.4) e a linha é achada pelo id da autorização; falso positivo seria só um alerta a mais |
| RES-34 | CP3-04 | cada mensagem já diz o que conferir; a tabela não se propõe completa |
| RES-35 | CP3-06 | exige falha num instante exato mais uma confirmação depois de negativa que a Asaas não foi medida mandando; a operação presa aparece pelo 409 e pelo RUNBOOK §6.3 |
| RES-36 | CP3-07 | ruído, nenhum dinheiro; a mesma lógica existia antes do D-3 |
| RES-37 | CP3-08 | alarme a mais, nunca a menos; o humano confere e encerra |
| RES-38 | CP3-18 | o pior efeito é um alerta falso de "não permite decidir"; o raciocínio está no comentário do bloco 15 da suíte |
| RES-39 | FP1A-2 | janela de milissegundos, ou uma intenção órfã que o sweeper resolve; o desfecho depende de como a Asaas responde a um `PUT` em assinatura removida, não medido; o `PUT` que lança vai a `erros` |
| RES-40 | FP1A-3 | não medido se a Asaas troca o id na retentativa; o alerta leva um humano à Asaas antes de qualquer estorno |
| RES-41 | FP1B-3 | os limites protegem custo e força bruta, e as chaves têm 192 bits; se os clientes chegam por IPv6 à Northflank não foi medido (a sonda do JULES-002 chegou por IPv4) |
| RES-42 | FP1C-3 | recusa é o modo seguro; classificar `estornos` (antes de `cobrancas`, pela FK) é decisão para quando o script voltar a ser usado, e nesta rodada nenhum registro se apaga |
| RES-43 | FP1C-5 | só o operador; os dois saem da `main` juntos |
| RES-44 | FP1RA-3 | nenhum dinheiro se move; alarme a mais |
| RES-45 | FP1RA-4 | alarme a mais, nunca a menos |
| RES-46 | FP1RA-5 | a Asaas reenvia; o evento não se perde enquanto houver reenvio |
| RES-47 | FP2B-1 | observabilidade; nenhum handler público rejeita com objeto puro (todos passam por `responderErro`), nada vaza e nada financeiro se perde |
| RES-48 | FP2B-2 | mesma classe do SEC-028; nenhuma rota pública chega a isso hoje; fica para a manutenção logar só `message`/`code` |
| RES-49 | FP2B-3 | exige uma rejeição já sem dono |
| RES-50 | FP2B-4 | as duas camadas continuam exigidas; o Access libera só o e-mail do dono |
| RES-51 | FP2C-3 | nenhum caminho apaga essas linhas hoje (só reserva sem charge, que nunca tem estorno); é a trava certa para dinheiro que saiu |
| RES-52 | FP2A-5 | janela de segundos, a cada deploy; o estado segue protegido pelo UPDATE condicional; `CONSTRAINTS.md` §2 manda trocar por arrendamento no banco antes de qualquer réplica |
| RES-53 | FP2A-3, FP2RA-3, RES-55 | dentro da borda do SEC-011/RES-04, cujo comportamento na Asaas não foi medido; o contratante recebe dois fatos diferentes, não o mesmo duas vezes |
| RES-54 | FP2A-4 | o estado final é o certo e os dois avisos chegam; a ordem é a documentada no `API.md` §4.3.6 (eventos podem chegar fora de ordem) |
| RES-55 | FP2RA-3 | dentro da borda do SEC-011/RES-04/RES-53; o alerta `primeiroCicloFalhou` já chama um humano |
| RES-56 | FP2RB-1 | exige credencial vazada; outros charges não são afetados, o estado segue protegido e o limitador vale |
| RES-57 | FP2RB-2 | troca de vivacidade por correção, escolhida de propósito (FP2A-1) |
| RES-58 | FP2RC-3 | a fila e a fiação são provadas por autoteste determinístico, que reprova a sabotagem; o caminho do ciclo passa pela mesma fiação |
| RES-59 | FP3A-2 | o contratante fez a chamada e recebeu o `200` com o `planoId` novo; o `API.md` §5.6 só faz o evento ser a fonte no caminho assíncrono |
| RES-60 | FP3A-3 | nenhum escritor concorrente a torna nociva: o CAS da rota de estorno não passa ali e a fila do charge serializa o webhook |
| RES-61 | FP3B-2 | o log do `chamarAsaas` já imprime o mesmo texto; nunca vai à resposta |
| RES-62 | FP3B-3 | no máximo um pedido a mais a cada 10 s por navegador; comportamento, não segurança |
| RES-63 | FP3C-4 | a chamada seguinte já vem certa; nada se perde |
| RES-64 | FP4A-2 | a folga existe porque os relógios são de lados diferentes; reconfirmação exige ação humana na Asaas (baixa desfeita) ou uma disputa resolvida, e as duas levam mais que isso |
| RES-65 | FP4B-2 | exige Access e sessão de admin; o processo segue de pé |
| RES-66 | FP4B-3 | exige o token; a Asaas nunca manda esse formato |
| RES-67 | FP4B-4 | nada alcançável rejeita com `null`; mesma família do FP1B-2 |
| RES-68 | FP4C-3 | a regressão do FP4A-1 grava o formato do PostgREST explicitamente; normalizar o banco falso inteiro mexeria em comparações de todas as suítes |
| RES-69 | FP5A-1 | exige baixa em dinheiro e desfazê-la no painel num ciclo de cartão; o `API.md` passa a mandar creditar o ciclo uma vez por `chargeId` |
| RES-70 | FP5A-2 | a Asaas e todo evento sintético sempre mandam `dateCreated`, e a inbox o guarda |

## 15. Cobertura do fechamento

**Contagem do ledger, calculada das próprias linhas** por `tests/o-que-os-documentos-afirmam.js` — a suíte reprova se esta linha divergir do que a tabela soma, se um ID aparecer duas vezes ou se uma linha não tiver exatamente um estado final:

TOTAL_LEDGER = 205 = FIXED 111 + FALSE_POSITIVE 4 + DUPLICATE 17 + RISK_ACCEPTED 68 + EXTERNAL_PENDING 5
