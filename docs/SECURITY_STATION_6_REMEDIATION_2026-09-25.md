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
| SEC-001 | Claude + Jules (EXPANDIDO) | HIGH | HIGH | `pedidoService.resolverPedido`/`resolverPlano` | CR-01 | id cru interpolado em URL de saída; Express decodifica `%2F`/`%3F` e `URL` normaliza `..` | sim, anônimo | proxy autenticado de GET na API do contratante | reprodução local (baseline §7) | alvo FIXED | — |
| SEC-002 | Claude + Jules | HIGH | HIGH | `refundController.estornar` | CR-02 | estorno sem identidade durável; repetição sequencial indistinguível de 2º parcial | sim, contratante | devolução em dobro | código + `API.md` §5.4 manda repetir | alvo FIXED | — |
| SEC-003 | Claude + Jules | MEDIUM | MEDIUM | `pedidoService` + `cobrancas.pedido_id` | CR-01 | mesma chave lógica com duas grafias | sim, link adulterado | pagamento duplicado sem detecção | normalização local | alvo FIXED (mesma raiz da SEC-001) | — |
| SEC-004 | Claude + Jules | MEDIUM | MEDIUM | `checkoutController.gerarPix`/`gerarBoleto` | CR-03 | reaproveita instrumento antes da guarda de pedido pago e da cotação | sim, API direta | irmã obsoleta entregue; preço ≠ exibido | código (linhas 267/272/380) | alvo FIXED | — |
| SEC-005 | Claude | MEDIUM | MEDIUM | `cobrancaService.buscarCobrancaPorPedido` | CR-03 | "a cobrança do pedido" = a mais recente | sim | status/estorno errados | código | alvo FIXED | — |
| SEC-006 | Claude + Jules | MEDIUM | **HIGH** (Jules) | `outboxService.entregar` | CR-04 | `fetch` segue redirect; destino não revalidado no envio | sim, contratante hostil | POST assinado com CPF para rede interna; entrega contada | reprodução local | alvo FIXED | — |
| SEC-007 | Claude + Jules | MEDIUM | **HIGH** (Jules) | `webhookController` | CR-05 | transição autoritativa aceita do corpo do evento | com o token vazado | confirmação forjada; estado congelado por carimbo futuro | código | alvo FIXED (reconsulta no provedor) | — |
| SEC-008 | Claude + Jules | MEDIUM | MEDIUM | `webhookController` | CR-05 | "estado anterior ainda não chegou" tratado como descartável | sim, falha transitória | divergência silenciosa | código | alvo FIXED | — |
| SEC-009 | Claude + Jules | MEDIUM | MEDIUM | `trocaExecucaoService`/`trocaSweeperService` | CR-02 | `PROCESSING_PAYMENT` gravado antes de cobrar; sweeper ignora sem `charge_id` | sim, crash/deploy | cobrado sem trocar o plano | código + comentário falso | alvo FIXED | — |
| SEC-010 | Claude | MEDIUM | MEDIUM | `trocaExecucaoService`/`trocaPlanoController` | CR-02 | arrendamento liberado em falha ambígua; sem unicidade de intenção aberta | provável | acerto cobrado duas vezes | código | alvo FIXED | — |
| SEC-011 | Claude | MEDIUM | MEDIUM | `webhookController` (assinatura) | CR-08 | assinatura só vinculada no 1º `confirmado`; ciclo de assinatura desconhecida descartado | depende da Asaas | recorrência sem registro | código | a triar: parte FIXED (não descartar calado), parte EXTERNAL_PENDING (comportamento da Asaas) | — |
| SEC-012 | Claude | MEDIUM | MEDIUM | `asaasCheckoutController.criarCheckoutAssinatura` | CR-08 | unicidade só para `pendente` | sim | duas assinaturas no mesmo cartão | código | alvo FIXED | — |
| SEC-013 | Claude + Jules (como "SEC-012/SEC-016") | MEDIUM | MEDIUM | `assinaturaController:133`, `trocaPlanoController:364`, `trocaExecucaoService:177` | CR-06 | promessa sem dono + `unhandledRejection → exit(1)` | sim, falha de banco | processo derrubado; aviso perdido | código + comentário falso em `server.js` | alvo FIXED | — |
| SEC-014 | Claude | MEDIUM | MEDIUM | `assinaturaService.upsertAssinatura` e vínculos | CR-06 | erro engolido; "primeira confirmação" decidida por estado já gravado | provável | assinatura órfã, 404 enquanto cobra | código | alvo FIXED | — |
| SEC-015 | Claude | MEDIUM | MEDIUM | `/api/admin/*` | CR-09 | Access só no HTML; API alcançável pelo hostname e pela origem; sem 2FA nem trilha | sim | admin depende só de senha | medição ao vivo (baseline) | a triar: medir de novo; alvo FIXED ou exceção com compensação | — |
| SEC-016 | Claude | MEDIUM | MEDIUM | `adminController.criarSubconta`/`atualizarLinkAtivacaoSubconta` | CR-09 | segredo logado; `select('*')` devolvido | condicional (subconta bloqueada na conta PF) | segredo no log/UI | código | alvo FIXED | — |
| SEC-017 | Claude + Jules (EXPANDIDO) | LOW | LOW | `asaasService.consultarStatus` via `/pix|boleto/status/:chargeId` | CR-01 | id público cru no caminho da Asaas | sim, anônimo | oráculo de status; cota | ao vivo (baseline) | alvo FIXED | — |
| SEC-018 | Claude | MEDIUM | MEDIUM | cartão parcelado | CR-05 | semântica da Asaas desconhecida | não medido | estorno/chargeback parcial | — | provável EXTERNAL_PENDING (exige medição com dinheiro ou sandbox parcelado) | — |
| SEC-019 | Claude | MEDIUM | MEDIUM | `transicoesFinanceiras` (chargeback) | CR-05 | `chargeback → confirmado` por qualquer confirmação mais nova | não medido | acesso restaurado durante disputa | código | alvo FIXED (sair de chargeback só por evento de disputa) | — |
| SEC-020 | Claude | MEDIUM | MEDIUM (latente) | Pix Automático | CR-05 | `ACTIVATED → confirmado` sem dinheiro; sem CAS | não (desligado) | — | `CONSTRAINTS.md` §2.4 | a triar: FIXED se barato, senão RISK_ACCEPTED com trava | — |
| SEC-021 | Claude | LOW | LOW | `alvoDeRede.js` | CR-04 | lista de faixas incompleta | sim, cadastro | SSRF residual | reprodução local | alvo FIXED | — |
| SEC-022 | Claude | LOW | LOW | `atualizarStatusCobranca`, `registrarEstorno` | CR-07 | escrita sem CAS | provável | regressão de estado | código | alvo FIXED | — |
| SEC-023 | Claude | LOW | LOW | `outboxService`/`webhookInboxService` | CR-07 | CAS de reivindicação ignora o recuo; passadas sobrepostas | provável | tentativas queimadas | código | alvo FIXED | — |
| SEC-024 | Claude | LOW | LOW | `webhookInboxService.reenfileirar` | CR-07 | não zera tentativas | sim (admin) | reprocesso esgota na 1ª falha | código | alvo FIXED | — |
| SEC-025 | Claude | LOW | LOW | `cobrancaService.liberarReservaCobranca` | CR-07 | DELETE sem condição de estado | janela estreita | reserva vinculada apagada | código | alvo FIXED | — |
| SEC-026 | Claude + Jules (EXPANDIDO) | LOW | LOW | `public/js/modules/*Handler.js`, `status.js` | CR-01 | segmento sem `encodeURIComponent` | sim, link | pedido de outro contratante na tela | código | alvo FIXED | — |
| SEC-027 | Claude | LOW | LOW | `validadores.js` | CR-14 | `String()` em qualquer tipo | sim | dado malformado gravado | código | alvo FIXED | — |
| SEC-028 | Claude | LOW | LOW | `chamarAsaas`, `asaasCheckoutController`, `server.js` | CR-12 | CPF e corpo cru no stdout | sim | PII em log | código | alvo FIXED | — |
| SEC-029 | Claude | LOW | LOW | `assinaturaController` pausar/retomar | CR-07 | arrendamento não devolvido no sucesso | sim | 409 por 5 min | código | alvo FIXED | — |
| SEC-030 | Claude | LOW | LOW | `clientes_asaas`, `subcontas`, `intencoes_troca_plano` | CR-12 | hash sem sal; sem retenção | — | pseudonimização fraca | código | a triar: hash FIXED se não quebrar busca; prazos = decisão jurídica (EXTERNAL_PENDING) | — |
| SEC-031 | Claude | LOW | LOW | `/api/saude`, Northflank | CR-11 | 200 com worker parado; sem health check | sim | processo pendurado não reinicia | ao vivo | alvo FIXED | — |
| SEC-032 | Claude | LOW | LOW | `atualizarLinkAtivacaoSubconta` | CR-09 | sem validação de esquema | só admin | `javascript:` (barrado pela CSP) | código | alvo FIXED | — |
| SEC-033 | Claude + Jules | LOW | LOW | `qs` 6.15.3 | CR-13 | dependência com aviso moderado | sim (parser) | DoS / limite de array | `npm audit` | alvo FIXED (atualização segura, sem `--force`) | — |
| SEC-034 | Claude | LOW | LOW | CI | CR-13 | sem `permissions:`; gitleaks sem checksum; sem Dependabot | — | supply chain | `.github/workflows/` | alvo FIXED no que é código; branch protection = EXTERNAL_PENDING (não legível daqui) | — |

### 2.2 INFO da baseline

| ID | Assunto | Classe | Triagem | Status final |
|---|---|---|---|---|
| INFO-01 | Rate limit em memória, `trust proxy 1` sem prova | CR-11 | DUPLICATE de JULES-002 (medir) | — |
| INFO-02 | Pages com `Access-Control-Allow-Origin: *` no estático | CR-11 | a triar (conteúdo público) | — |
| INFO-03 | CSP do front com `style-src 'unsafe-inline'`, `img-src https:` | CR-11 | a triar | — |
| INFO-04 | Imagem do contratante como pixel de rastreio | CR-12 | a triar | — |
| INFO-05 | `compararSeguro` vaza tamanho | CR-09 | alvo FIXED (barato) | — |
| INFO-06 | IP do log de rejeição do webhook do 1º item de XFF | CR-11 | alvo FIXED junto com JULES-002 | — |
| INFO-07 | Token de renovação e `pedidoId` na query string | CR-12 | a triar | — |
| INFO-08 | Reprocesso de evento depois do expurgo de 90 dias da inbox | CR-05 | a triar | — |
| INFO-09 | Cliente Supabase sem teto de tempo | CR-15 | alvo FIXED | — |
| INFO-10 | URL da outbox congelada no enfileiramento | CR-04 | a triar junto com SEC-006 | — |
| INFO-11 | Mensagem de erro da Asaas repassada ao cliente | CR-12 | alvo FIXED | — |
| INFO-12 | Documento cita prefixo/sufixo de chave de sandbox | CR-09 | alvo FIXED | — |
| INFO-13 | Grants padrão do `anon` nas 12 tabelas | CR-09 | alvo FIXED (defesa em profundidade) | — |
| INFO-14 | Tela Pix de irmã cancelada segue "aguardando" | CR-03 | a triar (UX) | — |

### 2.3 Achados novos do Jules

| ID | Sev. Jules | Classe | Alegação | Triagem (antes do código) | Status final |
|---|---|---|---|---|---|
| JULES-001 | HIGH | CR-10 | `buscarCobrancaPorReferenciaExterna`, `buscarCobrancaPorCheckoutId`, `buscarIntencao`, `buscarAssinaturaPorId` sem `contratante_id` permitem A → B | a provar ou refutar: toda busca por id único precisa ser classificada pela ORIGEM do id (webhook autenticado, linha do nosso banco, capacidade não enumerável, ou entrada do contratante) | — |
| JULES-002 | MEDIUM | CR-11 | `trust proxy 1` estrito demais; contorna rate limit | medir a cadeia real em produção antes de mexer | — |
| JULES-003 | MEDIUM | CR-09 | `service_role` ignora RLS | arquitetura/defesa em profundidade, salvo exploração demonstrada | — |
| JULES-004 | MEDIUM | CR-05 | reconciliador só olha reservas sem `charge_id` | alvo FIXED com reconciliador **dirigido** (não polling global) | — |

### 2.4 Alegações adicionais do relatório do Jules (fora da numeração)

| ID nesta rodada | Alegação | Classe | Triagem (antes do código) | Status final |
|---|---|---|---|---|
| JX-01 | IDs como `planoId`, `asaasCheckoutId` e chaves "de cache" aceitam `|` e `../`, "quebrando delimitações do Redis/Supabase" | CR-01 | parte procede (mesma raiz da SEC-001, vale para todo id de fronteira); **não há Redis no projeto**; verificar se algum filtro PostgREST por texto (`.or()`) interpola entrada | — |
| JX-02 | `POST /v3/payments` sem chave de idempotência | CR-02 | a verificar: reserva antes de cobrar + `externalReference reserva-<id>` + reconciliador — é idempotência por nossa conta; a Asaas não documenta cabeçalho | — |
| JX-03 | Admin sem CSRF | CR-09 | provável FALSE_POSITIVE (token em header, nenhuma rota lê cookie) | — |
| JX-04 | `process.exit(1)` pode corromper operação em memória | CR-06 | DUPLICATE parcial de SEC-013; e janela de crash (CR-02) | — |
| JX-05 | Mocks da Asaas não modelam timeout; testes do webhook não consideram rejeição assíncrona | teste | a cobrir com os testes de classe desta rodada | — |
| JX-06 | Cobrança irmã gerada sem `bloqueioPorPagamentoLocal` em rotas que "ignoram `status=pendente`" | CR-03 | provável DUPLICATE de SEC-004; conferir também o cartão | — |
| JX-07 | Validações que exigiriam produção: cabeçalhos de IP (Northflank/Cloudflare), `v3/refunds` real sem idempotência, `unhandledRejection` nos logs | — | (1) medir; (2) sem estorno real — a correção torna a pergunta desnecessária; (3) ler logs | — |

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

_(em andamento)_

## 4. Achados do Claude

_(em andamento)_

## 5. Achados do Jules

_(em andamento)_

## 6. Achados novos desta rodada

_(em andamento)_

## 7. Correções

_(em andamento)_

## 8. Testes de regressão

_(em andamento)_

## 9. Resultados de sabotagem

_(em andamento)_

## 10. Validações externas

_(em andamento)_

## 11. Validação de produção

_(em andamento)_

## 12. Invariantes financeiras

_(em andamento)_

## 13. Ciclos de convergência

_(em andamento)_

## 14. Riscos residuais

_(em andamento)_

## 15. Cobertura do fechamento

_(em andamento)_
