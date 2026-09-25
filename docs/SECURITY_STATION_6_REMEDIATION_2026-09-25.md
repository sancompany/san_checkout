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
| SEC-015 | Claude | MEDIUM | MEDIUM | `/api/admin/*` | CR-09 | Access só no HTML; API alcançável pelo hostname e pela origem; sem 2FA nem trilha | sim | admin depende só de senha | medição ao vivo (baseline) | a triar: medir de novo; alvo FIXED ou exceção com compensação | **FIXED** `8be71d3` — JWT do Access conferido na origem + Pages Function; login real do operador = EXTERNAL_PENDING EP-01 |
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
| SEC-031 | Claude | LOW | LOW | `/api/saude`, Northflank | CR-11 | 200 com worker parado; sem health check | sim | processo pendurado não reinicia | ao vivo | alvo FIXED | **FIXED** `8be71d3` — `/api/saude` 503 com `workersAtrasados`; o health check do Northflank apontando para ela = EXTERNAL_PENDING EP-06 |
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
| INFO-13 | Grants padrão do `anon` nas 12 tabelas | CR-09 | alvo FIXED (defesa em profundidade) | **EXTERNAL_PENDING** EP-02 — migration 0020 escrita e testada; a aplicação em produção pede a aprovação da ferramenta, que não veio nesta sessão |
| INFO-14 | Tela Pix de irmã cancelada segue "aguardando" | CR-03 | a triar (UX) | **RISK_ACCEPTED** — UX; o pagamento em si é recusado pela Asaas depois de a irmã ser cancelada; RES-11 |

### 2.3 Achados novos do Jules

| ID | Sev. Jules | Classe | Alegação | Triagem (antes do código) | Status final |
|---|---|---|---|---|---|
| JULES-001 | HIGH | CR-10 | `buscarCobrancaPorReferenciaExterna`, `buscarCobrancaPorCheckoutId`, `buscarIntencao`, `buscarAssinaturaPorId` sem `contratante_id` permitem A → B | a provar ou refutar: toda busca por id único precisa ser classificada pela ORIGEM do id (webhook autenticado, linha do nosso banco, capacidade não enumerável, ou entrada do contratante) | **FALSE_POSITIVE** — as 142 consultas classificadas pela origem do id: nenhuma leva de A para B; a única frágil (irmãs) coberta por teste |
| JULES-002 | MEDIUM | CR-11 | `trust proxy 1` estrito demais; contorna rate limit | medir a cadeia real em produção antes de mexer | **FALSE_POSITIVE** se a sonda de §11 gravar o IP de saída real (160.79.106.132), não o forjado |
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

Cada classe foi corrigida **na raiz**, com busca transversal pelo resto do código antes de fechar, e uma suíte de classe que varre o `src/` inteiro em vez de confiar em memória.

| Classe | Correção na raiz | Suíte de classe | Commit |
|---|---|---|---|
| CR-01 identificador não canônico | `exigirParametrosCanonicos` em todo roteador + `segmentoAsaas` em todo caminho de saída; front com `encodeURIComponent` | `identificador-canonico-em-toda-fronteira` (2180), `filtro-or-so-interpola-o-que-o-servidor-fez` | `a5d552e`, `baa3a88` |
| CR-02 efeito financeiro sem identidade durável | estorno como operação durável (tabela `estornos`, 0018); acerto de troca procurado pela referência `troca:<id>`; uma troca em voo (0019) | `estorno-repetido-nao-devolve-duas-vezes` (108), `acerto-de-troca-nunca-fica-orfao` | `69b5228`, `5475d69`, `baa3a88` |
| CR-03 instrumento entregue sem reconferir | reaproveitar só se ainda é o do pedido, pelo preço da tela; linha representativa determinística | `instrumento-obsoleto-nunca-volta` (46) | `d651f62` |
| CR-04 saída sem revalidação no envio | `redirect: 'error'`/manual em toda saída; destino revalidado no envio | `saida-nunca-segue-redirecionamento`, `nenhuma-chamada-de-saida-sem-teto` | `c8f4e20` |
| CR-05 estado do corpo do evento / ordem | o provedor decide: `GET /v3/payments/{id}` antes de mover dinheiro; transição fora de ordem lança e é reaplicada; reconciliador dirigido | `webhook-confere-na-asaas` (85) | `af6f597`, `baa3a88` |
| CR-06 efeito assíncrono sem dono | promessa com dono em todo `src/`; **todo handler do Express com dono** (`rotaSegura.js`) | `nenhuma-promessa-sem-dono`, `rota-que-lanca-nao-derruba-o-processo` | `5475d69`, `baa3a88` |
| CR-07 escrita fora da CAS | toda transição por `aplicarTransicao`/CAS; escrita incondicional removida; delete condicional | `escrita-de-estado-e-condicional` (28) | `8be71d3`, `baa3a88` |
| CR-08 ciclo de vida da assinatura | uma assinatura viva por plano; vínculo no 1º evento; ciclo identificado pela assinatura | `uma-assinatura-viva-por-plano`, `assinatura-nasce-inteira` | `5475d69`, `baa3a88` |
| CR-09 fronteira administrativa | JWT do Access na origem (RS256, aud, iss, exp) + Pages Function; segredo nunca em log/resposta; grants públicos revogados (0020) | `admin-so-pelo-access` (73), `segredo-nao-sai-do-admin`, `banco-sem-privilegio-publico` | `8be71d3`, `baa3a88` |
| CR-10 multi-tenant | refutado por classificação das 142 consultas | teste da irmã (única frágil) | — |
| CR-11 borda | `/api/saude` 503 com worker parado; orçamento nas passadas; teto de resposta do webhook | `rotas-http`, autotestes de `passadas.js`, `webhookController` | `8be71d3`, `baa3a88` |
| CR-12 dado pessoal em log | corpo cru fora do log; erro da Asaas redigido | `erro-da-asaas-nao-vaza` (16) | `8be71d3` |
| CR-13 dependências e CI | versões corrigidas; CI só leitura, ferramentas fixadas por hash, Dependabot com cooldown | `ci-so-le-e-fixa-o-que-roda` (19) | `8be71d3`, `8c96576` |
| CR-14 tipo na fronteira | validadores só aceitam texto ou número finito | autoteste de `validadores.js` | `8be71d3` |
| CR-15 dependência sem teto | cliente Supabase com 20 s | `nenhuma-chamada-de-saida-sem-teto` | `8be71d3` |

## 4. Achados do Claude

34 SEC + 14 INFO da baseline. Status de cada um na §2.1 e §2.2, com o commit e a prova. Contado da própria tabela: SEC — **32 FIXED**, **2 EXTERNAL_PENDING** (SEC-018, SEC-030); INFO — **6 FIXED**, **1 EXTERNAL_PENDING** (INFO-13, a aplicação da 0020), **6 RISK_ACCEPTED**, **1 DUPLICATE**. Nenhum CRITICAL existia; os HIGH (SEC-001, SEC-002 e, pela régua do Jules, SEC-006 e SEC-007) estão FIXED.

## 5. Achados do Jules

4 numerados (§2.3) e 7 alegações fora da numeração (§2.4). **JULES-001 (HIGH) é FALSE_POSITIVE** — não por palavra: as 142 consultas foram classificadas pela origem do id, e nenhuma leva de um contratante a outro. JULES-002 depende da sonda de produção (§11). JULES-003 é arquitetura (RISK_ACCEPTED, com a defesa em profundidade do INFO-13). JULES-004 FIXED. Das alegações: 2 FIXED (JX-01, JX-05), 2 FALSE_POSITIVE (JX-02, JX-03), 3 DUPLICATE.

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

## 7. Correções

Doze commits na branch `claude/nifty-meitner-4ffp9s` sobre `43635c4`, PR #50. Os de código:

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

Migrations: **0018** (estornos) e **0019** (uma troca em voo) aplicadas em produção; **0020** (grants públicos) escrita e testada, aplicação pendente (EP-02).

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
| **Total** | **164** | **164** | **10**, todas fechadas |

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

_(em andamento)_

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

_(em andamento)_

## 14. Riscos residuais

_(em andamento)_

## 15. Cobertura do fechamento

_(em andamento)_
