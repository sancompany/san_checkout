# SECURITY POSTURE — SAN Checkout, Estação 6, baseline factual

**SHA auditado:** `43635c46875ea5655402bbec37a5f2fd0317ff54` (`main`, PR #48)
**SHA em produção:** `43635c46875ea5655402bbec37a5f2fd0317ff54` — backend (Northflank `deployedSHA`, deploy `COMPLETED`) **e** frontend (Cloudflare Pages, deploy de produção `success`). Sem divergência repositório × produção.
**Data:** 2026-09-25
**Natureza:** baseline do Claude, somente leitura. **Nenhuma correção de código foi feita.** Este documento é a entrada para a auditoria adversarial independente (Codex): ele não deve ser tratado como prova de segurança, e sim como o mapa do que foi olhado, como, e onde a prova termina.

| Severidade | Quantidade |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 17 |
| Low | 15 |
| Info | 14 |

## Bloqueadores para fechar a Estação 6

Só entram aqui problemas que, sozinhos, impedem o congelamento técnico — porque movem dinheiro errado, vazam dado de um contratante para anônimo, ou contornam a guarda financeira que a própria estação acabou de construir.

| ID | Por que bloqueia |
|---|---|
| **SEC-001** (HIGH) | Anônimo faz o Checkout executar GET autenticado (com a `X-Checkout-Key` do contratante) em caminho arbitrário da API do contratante e recebe o corpo de volta |
| **SEC-002** (HIGH) | Estorno parcial repetido pelo contratante — comportamento que o `API.md` §5.4 recomenda — devolve o dinheiro duas vezes |
| **SEC-003** (MEDIUM) | Uma variante não canônica do `pedidoId` contorna RN-04, RN-04.1 e RN-51 — as três guardas contra pagamento duplicado |
| **SEC-004** (MEDIUM) | `POST /pix` e `/boleto` reaproveitam a cobrança pendente **antes** da guarda de pedido pago e da cotação: entregam a irmã obsoleta e podem cobrar valor diferente do exibido |
| **SEC-006** (MEDIUM) | A outbox segue redirect sem revalidar: contratante hostil direciona POSTs assinados, com CPF no corpo, para a rede interna, e a entrega é contada como feita |

## Riscos relevantes (não bloqueiam sozinhos, mas precisam de dono)

SEC-005 (cobrança "do pedido" = a mais recente), SEC-007 (webhook confia no corpo; só o token estático protege), SEC-008 (evento fora de ordem descartado), SEC-009 (acerto de troca de plano órfão), SEC-010 (acerto de troca cobrado duas vezes), SEC-012 (segunda assinatura ativa do mesmo plano), SEC-013 (aviso sem `catch` derruba o processo), SEC-014 (vínculo de assinatura engole erro), SEC-015 (API admin fora do Cloudflare Access, sem 2FA nem trilha de auditoria), SEC-016 (chave de subconta no log e sem máscara).

## Controles fortes já comprovados

- **`CHECKOUT_PAID` nunca vira `confirmado`** — `webhookController.js` (`processarEventoCheckout`) só carimba `sessao_concluida_em`; `tests/sessao-concluida-nao-e-pagamento.js`.
- **Valor nunca vem do corpo da requisição** — cotação por id + contratante + tipo + referência, totais do servidor; `tests/valor-vem-do-servidor.js` (58 checagens).
- **Reserva antes de cobrar + índice único parcial** — duplo clique no mesmo método não cria segunda cobrança na Asaas; `tests/dez-cliques-uma-sessao.js`.
- **Inbox do webhook: persistir antes do 200**, 503 sem banco, deduplicação por id do evento, arrendamento de 5 min, 8 tentativas com recuo. Nenhum evento **armazenado** se perde depois do 200 (ver SEC-008 para o descarte **lógico**).
- **Outbox durável**, assinada (HMAC `sha256(timestamp.corpo)`), 10 s de teto, 8 tentativas; `tests/outbox-sobrevive-a-reinicio.js` (dois processos reais).
- **Máquina de estados com CAS** (`transicoesFinanceiras.js`, 100 checagens) para os eventos da Asaas.
- **Supabase: RLS ligado nas 12 tabelas, nenhuma policy, nenhuma função `SECURITY DEFINER`** — conferido **no catálogo de produção**, e com a chave anon pública as 11 tabelas testadas devolveram 0 linhas. O advisor do Supabase só acusa os 12 INFO `rls_enabled_no_policy` (o bloqueio intencional).
- **PAN/CVV nunca passam pelo backend** — cartão digitado na pop-up hospedada da Asaas; `creditCardToken` só em memória, nunca persistido nem logado.
- **Anti open redirect no `returnUrl`** — `retornoSeguro.js`, comparação por `URL.origin`, decisão no servidor; 47 + 30 checagens.
- **CORS da API em produção:** origem única fixa (`https://checkout.sancocore.com.br`), sem reflexão, sem `null`, sem `Allow-Credentials`, sem preview/localhost — conferido com 7 origens hostis.
- **Headers servidos em produção** nas duas pontas (HSTS, CSP, `nosniff`, `frame-ancestors 'self'`/`X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cache-Control: no-store` em `/api`).
- **Erro sem vazamento**: 404 e JSON malformado devolvem mensagem genérica; nenhum stack trace ao cliente.
- **Nenhum segredo no repositório nem nas 90 revisões do histórico**; CI roda gitleaks, semgrep e `npm audit --audit-level=high`; ações de terceiros fixadas por SHA.
- **Telefone +55** normalizado no front e no backend, nas 5 rotas que recebem telefone; DDD 55 (RS) preservado; internacional recusado.

## Parcialmente comprovados

Cancelamento de cobranças irmãs (RN-51: implementado e testado com Asaas simulada; **nunca exercido contra a API real**), isolamento multitenant (escopo por contratante nas consultas, mas `pedidoId` não canônico — SEC-001/003), rate limit (em memória, `trust proxy 1` sem prova do número de saltos), anti-SSRF (pull revalida redirect; outbox não — SEC-006; filtro de host com brechas — SEC-021), estorno (arrendamento cobre concorrência, não repetição — SEC-002), assinaturas (primeiro ciclo recusado e segunda assinatura — SEC-011/012).

## Não verificados

- `DELETE /v3/payments/{id}` e `POST /v3/checkouts/{id}/cancel` contra a Asaas real (estados aceitos, formato de resposta).
- Número de proxies à frente do Express em produção (valida `trust proxy 1` e a chave do rate limit).
- Configuração de branch protection e regras do GitHub (não acessível daqui).
- Políticas do Cloudflare Access além do comportamento observado (302 para o login do Access nas rotas de admin do front).
- Comportamento da Asaas em primeiro ciclo de assinatura recusado, parcelamento no checkout hospedado, e `PAYMENT_RECEIVED` depois de chargeback.
- Se o Web Analytics da Cloudflare coleta a query string (onde viajam `pedido` e o token de renovação).

## Dependências externas

Asaas (PSP, fonte da verdade do pagamento, envia webhook sem assinatura de corpo), Supabase (banco; o backend usa a chave `service_role`), Northflank (1 instância, sem health check configurado), Cloudflare (Pages + DNS + Access + Web Analytics), contratantes (API de pedido/plano e endpoint de webhook — controlados por terceiros).

## Pendências financeiras externas (não são vulnerabilidades)

**IMPLEMENTADO MAS NÃO HOMOLOGADO EM PRODUÇÃO:**
- Cancelamento real de cobrança irmã na Asaas (RN-51) — só leitura real validada (`consultarPagamento` dentro do contêiner, 25/09).
- Boleto real `ped_dez_boleto` aguardando compensação bancária.
- Assinatura real (`sub_39mjscz7vl2jwx7g`) aguardando o primeiro ciclo.
- Tratamento em código de `SUBSCRIPTION_*` (eventos marcados, entram como `ignorado`).
- Pix Automático (desligado nesta conta; ver SEC-020).

---

## 1. Snapshot (Fase 0)

| Item | Valor observado | Como |
|---|---|---|
| Branch de trabalho | `claude/nifty-meitner-4ffp9s`, alinhada com `main` | `git` |
| SHA `main` | `43635c4` | `git ls-remote` |
| SHA do working tree | `43635c4`, árvore limpa | `git rev-parse`, `git status` |
| Backend servido | `43635c4`, build `SUCCESS`, deploy `COMPLETED`, 1 instância, porta 3001 pública, `healthChecks: null` | `northflank get service` |
| Frontend servido | `43635c4` (Pages, produção, `success`) | API da Cloudflare |
| Migrations | 17 arquivos (`0001`…`0017`); 18 linhas em `supabase_migrations.schema_migrations` (a 0010 em duas), todas presentes | catálogo |
| Node | local `v22.22.2`; produção `v22.23.3`; `engines: >=22`; imagem `node:22-alpine`, `USER node` | local + contêiner |
| npm | local `10.9.7`; produção `10.9.9` | idem |
| Dependências de produção | `express ^4.19.2` (instalado 4.22.2), `helmet ^8`, `cors ^2.8.5`, `express-rate-limit ^7.4`, `@supabase/supabase-js ^2.45`, `dotenv ^16` | `package.json` |
| Ambiente Asaas | `ASAAS_AMBIENTE=producao` → `https://api.asaas.com` | contêiner |
| Segredos no contêiner | `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`, `CHECKOUT_ADMIN_USER`, `CHECKOUT_ADMIN_PASS_HASH`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`: **CONFIGURADO**. Não existe segredo de sessão separado (ver SEC-015) | contêiner (só presença) |
| `/api/saude` | 200 `ok`, Supabase respondendo, `alertasChaveAsaas: []` | produção |
| Workers | `inbox`, `outbox`, `trocaDePlano`, `canceladorDeIrmas` a cada 60 s; `reconciliador` a cada 5 min — todos com carimbo recente | `/api/saude` |
| Filas | inbox 0 pendentes / 0 esgotadas; outbox 0 pendentes / 0 abandonadas | `/api/saude` |
| Tabela `erros` | 3 linhas, todas do incidente do primeiro Pix (01:24–01:31 UTC de 25/09), nenhuma depois | banco |
| Cloudflare Access | **ligado** para `checkout.sancocore.com.br/admin` e `/admin.html` (302 para `*.cloudflareaccess.com`). **Não cobre** `api.sancocore.com.br/api/admin/*` nem a origem `*.code.run` | produção |
| CI | `testes` e `Segurança` verdes em `43635c4` | GitHub Actions |
| Suítes locais | `npm test`: 63 suítes, todas verdes | local |

---

## 2. Superfície de ataque

A API monta 41 rotas; não há `express.static`, rota de depuração, rota de sandbox nem rota legada ativa (o único "410" do projeto é o estado `EXPIRED` da troca de plano). O frontend estático é servido pela Cloudflare Pages, não pelo Express.

| Classe | Rotas | Autenticação | Limite |
|---|---|---|---|
| PUBLIC (comprador) | `GET /api/checkout/pedido/:c/:p`, `GET /plano/:c/:p`, `POST /pix/:c/:p`, `POST /boleto/:c/:p`, `POST /cartao/:c/:p`, `POST /assinatura/:c/:p`, `POST /assinatura-pix/:c/:p`, `GET /pix/status/:chargeId`, `GET /boleto/status/:chargeId`, `GET /asaas-checkout/status/:id`, `GET /status/:c/:p`, `POST /troca/contexto`, `POST /troca/aprovar`, `GET /api/saude` | nenhuma (a troca usa token UUID no corpo) | criação 10/min, consulta 60/min, saúde 30/min — por IP, em memória |
| AUTHENTICATED (contratante) | `GET /cobranca/:c/:p`, `POST /estornar`, `POST /cancelar-assinatura`, `/pausar-assinatura`, `/retomar-assinatura`, `/consultar-assinatura`, `/trocar-plano` | `X-Checkout-Key` | criação 10/min, consulta 60/min |
| ADMIN | 19 rotas em `/api/admin/*` (sessão, contratantes, subcontas, métricas, auditoria de webhook, erros, filas) | login próprio → token de sessão em `X-Admin-Token` | `/sessao` 5 por janela; resto 60/min |
| WEBHOOK | `POST /api/webhooks/asaas` | header `asaas-access-token`, comparado em tempo constante; fail-closed sem a variável | 300/min |
| WORKER | inbox, outbox, reconciliador, sweeper de troca, cancelador de irmãs, expurgos, taxas (`setInterval` em `server.js`) | interno | — |
| STATIC | `checkout.sancocore.com.br` (Pages); `/admin*` atrás do Access | Access só no admin | Cloudflare |

Efeitos financeiros e chamadas externas por rota estão na §6 (matriz financeira) e na §5 (fronteiras).

---

## 3. Matriz de controles

| Área | Controle | Estado | Evidência | Teste | Lacuna |
|---|---|---|---|---|---|
| Authentication | Login admin com scrypt, comparação em tempo constante, 503 sem variável | VERIFICADO | `utils/senhaAdmin.js`, `utils/sessaoAdmin.js`, `adminController.abrirSessao` | autotestes de `senhaAdmin`/`sessaoAdmin`, `tests/rotas-http-respondem-como-prometido.js` | sem 2FA; sem bloqueio de conta além do limite de taxa (SEC-015) |
| Authentication | Chave do contratante (`X-Checkout-Key`) | VERIFICADO | 401 sem chave e com chave falsa em produção | `rotas-http…` | chave em texto claro no banco (necessária para o HMAC) |
| Authorization | Rotas de contratante escopadas pelo dono da chave | VERIFICADO | 403 quando o `contratanteId` da URL não é o da chave (`consultarCobranca`) | `rotas-http…` | ids não canônicos (SEC-001/003) |
| Tenant isolation | Consultas por `contratante_id` + id | PARCIAL | `cobrancaService`, `cotacaoService.buscarCotacaoValida` | vários | `pedidoId`/`chargeId` crus em URL de saída (SEC-001, SEC-017) |
| Sessions | Token de admin assinado, com validade, em `sessionStorage` | PARCIAL | `sessaoAdmin.js` (chave derivada do hash da senha) | autoteste | sem revogação no servidor; quem vir o hash forja sessão |
| Admin | Guarda em todas as rotas `/api/admin` | VERIFICADO | `router.use` + suíte chamando todas sem token | `rotas-http…` | API fora do Access; sem trilha de auditoria (SEC-015) |
| Cloudflare Access | Página do admin | VERIFICADO | 302 para o Access em produção | observado ao vivo | não cobre a API admin nem a origem (SEC-015) |
| CORS | Origem única, sem credentials | VERIFICADO | produção, 7 origens hostis | — | — |
| CSRF | Nenhuma rota depende de cookie | NÃO APLICÁVEL | admin por header, contratante por header | — | — |
| XSS | Dado do contratante em `textContent`; admin com `escapar()`; CSP `script-src 'self'` | VERIFICADO | `pedidoHandler.js`, `app.js`, `admin.js`, `public/_headers` | — | `link_ativacao` sem esquema (SEC-032, mitigado pela CSP) |
| SQLi | Só query builder; `.or()` com valores do servidor; sem ORDER BY do usuário | VERIFICADO | `cobrancaService`, `outboxService`, `webhookInboxService`, `expurgoService`, `adminController` | — | — |
| SSRF | Pull revalida cada redirect, mesma origem, 1 MiB | VERIFICADO | `utils/puxarDoContratante.js` | `tests/pull-nao-segue-para-onde-quiser.js` | caminho montado com id cru (SEC-001); outbox segue redirect (SEC-006); filtro de host (SEC-021) |
| Open redirect | `returnUrl` decidido no servidor por origem | VERIFICADO | `utils/retornoSeguro.js` | `retorno-nao-vira-open-redirect.js` | — |
| Rate limiting | Limites por rota e IP | PARCIAL | `middlewares/limitadores.js`, `server.js` | `toda-rota-publica-tem-teto.js` | em memória; `trust proxy 1` sem prova; zera no reinício |
| DoS | `express.json` 100 kB; tetos por campo; corpo do pull 1 MiB | PARCIAL | `server.js`, `validadores.js` | — | outbox sequencial com 10 s × 50 (SEC-023); `qs` com aviso (SEC-033) |
| Secrets | Fora do repositório e do histórico; CI sem segredo | VERIFICADO | varredura das 90 revisões; gitleaks no CI | `segredo-nao-sai-do-admin.js` | chave de subconta no log e sem máscara (SEC-016) |
| Logging | Payload do webhook redigido por lista branca; `erros` com raspagem | PARCIAL | `auditoriaWebhookService.redigirPayload`, `erroService.rasparMensagem` | autotestes | CPF e corpo da Asaas crus no stdout (SEC-028) |
| Privacy | Expurgo por lista branca em 5 anos | PARCIAL | `expurgoService.js` (71) | autoteste | `subcontas`, `clientes_asaas`, `intencoes_troca_plano` sem retenção; hash de CPF sem sal (SEC-030) |
| Webhook inbound | Token, persistência antes do 200, deduplicação | VERIFICADO | `webhookController.js`, `webhookInboxService.js` | autotestes (263/38) | confiança no corpo (SEC-007); descarte fora de ordem (SEC-008) |
| Webhook outbound | Assinatura, teto, recuo, abandono | PARCIAL | `outboxService.js`, `assinaturaWebhook.js` | `outbox-sobrevive-a-reinicio.js` | redirect (SEC-006); CAS ignora recuo (SEC-023) |
| Inbox | Arrendamento, esgotamento com `erros` | VERIFICADO | `webhookInboxService.js` | autoteste | reenfileirar não zera tentativas (SEC-024) |
| Outbox | Chave de idempotência única | VERIFICADO | migration 0015 | autoteste | idem SEC-023 |
| Payments | Reserva antes de cobrar, `pagamentoJaCriado`, reconciliador | VERIFICADO | `checkoutController.cobrarComReserva`, `reconciliacaoService.js` | autotestes | reaproveitamento antes da guarda (SEC-004) |
| Quotes | Cotação imutável, 409 em divergência | VERIFICADO | `cotacaoService.js` (22) | autoteste | reaproveitamento ignora a cotação (SEC-004) |
| Idempotency | Mesma cobrança por (pedido, método); webhook por id de evento | PARCIAL | índices 0001/0015 | vários | estorno sem chave de idempotência (SEC-002) |
| Concurrency | CAS em transições, arrendamentos por tempo | PARCIAL | `aplicarTransicao`, `reivindicarEstorno`, `reivindicarTroca` | autotestes | escritas fora da máquina (SEC-022); arrendamento sem token de posse |
| Sibling charges | RN-51/RN-52 | PARCIAL | `irmasObsoletasService.js` (47) | `pagamento-de-um-pedido-invalida-as-irmas.js` (89, 12 sabotagens) | não homologado contra a Asaas real; irmã ainda entregue por SEC-004 |
| Refund | Arrendamento, conta em centavos, boleto só total | PARCIAL | `refundController.js` (16) | autoteste | repetição (SEC-002); linha errada (SEC-005); parcelado (SEC-018) |
| Partial refund | Acumulado de `payment.refunds` | PARCIAL | `webhookController.valorEstornadoDoPayment` | autoteste | SEC-002 |
| Chargeback | Mapeado e avisado | PARCIAL | `transicoesFinanceiras.js` | autoteste | `chargeback → confirmado` genérico (SEC-019) |
| Subscription | Vínculo só no primeiro `confirmado`, token HMAC de renovação | PARCIAL | `webhookController`, `tokenRenovacao.js` | autotestes | SEC-011, SEC-012, SEC-014 |
| Database | `CHECK` de vocabulário, índices únicos, gatilho `e_teste` | VERIFICADO | migrations 0001–0017 | ensaio de restauração | regras só em JS: transição, valor do webhook × `valor_cobrado` |
| Workers | CAS/arrendamento por worker | PARCIAL | `server.js` | vários | sem trava de "já rodando"; sem SIGTERM (SEC-009) |
| Supabase | RLS default-deny, sem policy, sem `SECURITY DEFINER` | VERIFICADO (produção) | catálogo + chave anon | — | grants padrão do anon existem (defesa em profundidade depende do RLS) |
| Northflank | 1 instância, porta pública, sem health check | PARCIAL | `northflank get service` | — | `/api/saude` responde 200 com worker parado (SEC-031) |
| CI | testes + gitleaks + semgrep + npm audit; ações fixadas por SHA | PARCIAL | `.github/workflows/` | — | `ci.yml` sem `permissions:`; sem Dependabot; deploy não depende do CI (SEC-034) |
| Dependencies | 3 avisos moderados | PARCIAL | `npm audit` | CI só barra `high` | SEC-033 |

---

## 4. Máquina de estados de `cobrancas.status`

Fonte: `src/services/transicoesFinanceiras.js` e `webhookController.processarEventoPayment`/`processarEventoCheckout`. Gravação por CAS (`where status = <de>`); evento com `dateCreated` mais antigo que o gravado não regride.

| Estado atual | Evento | Novo estado | Permitido | Idempotente | Reversível | Efeito financeiro |
|---|---|---|---|---|---|---|
| pendente | `PAYMENT_CONFIRMED` / `RECEIVED` | confirmado | sim | sim | por `CASH_UNDONE`/estorno | irmãs obsoletas ou duplicidade (RN-51/52); assinatura: vínculo e `criada` |
| pendente | `AWAITING_RISK_ANALYSIS` | em_analise | sim | sim | sim | aviso |
| pendente | reprovado / captura recusada | recusado | sim | sim | → confirmado | assinatura: `cobranca_falhou`, sem cancelar na Asaas (SEC-011) |
| pendente | `OVERDUE` | vencido | sim | sim | → confirmado | aviso |
| pendente | `CHECKOUT_CANCELED`/`EXPIRED` (sessão não concluída) | cancelado / expirado | sim | sim | cancelado: não; expirado: → confirmado | assinatura nova: `cancelada` |
| pendente | `CHECKOUT_PAID` | não muda | — | sim | — | só `sessao_concluida_em` |
| pendente/vencido/recusado | cancelador de irmãs, após ler a Asaas | cancelado_por_outro_pagamento | sim (CAS) | sim | → confirmado | DELETE/cancel na Asaas |
| confirmado | estornos / chargeback / `CASH_UNDONE` | estornado, estornado_parcialmente, estorno_solicitado, chargeback, pendente | sim | parcial por acumulado | ver abaixo | aviso |
| confirmado | qualquer evento de sessão ou de irmã | — | **não** | — | — | nunca se cancela o que foi pago |
| estorno_solicitado | concluído / parcial / negado / chargeback | idem | sim | sim | — | — |
| estorno_negado | confirmado / novo estorno / chargeback | idem | sim | — | — | volta a ser estornável |
| estornado_parcialmente | total / novo parcial / chargeback | idem | sim | por acumulado | — | — |
| chargeback | `CONFIRMED`/`RECEIVED` mais novo, ou estorno | confirmado / estornado | sim | — | — | SEC-019 |
| estornado, cancelado | qualquer | — | não (terminais) | — | — | — |
| cancelado_por_outro_pagamento | `CONFIRMED`/`RECEIVED` | confirmado | sim | — | — | vira duplicidade (RN-52) |

**Quem grava status fora da máquina (sem CAS):** `atualizarStatusCobranca` (chamado pela consulta pública de status), `registrarEstorno`, `atualizarStatusPorCheckoutId` (Pix Automático) — SEC-022 e SEC-020.

---

## 5. Fronteiras de confiança

| Origem | Destino | Autenticação | Validação | Dados | Risco |
|---|---|---|---|---|---|
| Browser | Checkout (API) | nenhuma nas rotas do comprador | tetos por campo, validadores, cotação do servidor | nome, e-mail, CPF/CNPJ, telefone, endereço | ids crus em URL de saída (SEC-001/003/017); falsificação limitada pelo limite de taxa em memória |
| Cloudflare | Checkout | nenhuma (API DNS-only, pública por desenho) | — | — | origem `*.code.run` também responde; Access não está no caminho da API |
| Admin (browser) | API admin | usuário + senha → token de sessão | guarda em todas as rotas | contratantes, chaves mascaradas, filas, erros | API fora do Access; sem 2FA nem trilha (SEC-015) |
| Checkout | Supabase | chave `service_role` (ignora RLS) | query builder | tudo | um vazamento da chave expõe todas as tabelas; o anon é barrado pelo RLS |
| Checkout | Asaas | `access_token` da conta-mãe | teto de 20 s | cliente, cobrança, estorno, assinatura | caminho com id cru (SEC-017) |
| Asaas | Checkout (webhook) | token estático no header | lista de eventos, máquina de estados | status, valor, datas | corpo não assinado: vazar o token permite forjar confirmação (SEC-007) |
| Checkout | Contratante (pull) | `X-Checkout-Key` | https, host público, redirect revalidado, 1 MiB | pedido, plano | caminho arbitrário na mesma origem (SEC-001) |
| Checkout | Contratante (webhook) | HMAC com a `api_key` | https no cadastro | pagamento, documento | redirect seguido (SEC-006) |
| Worker | Banco | `service_role` | CAS / arrendamento | filas | sobreposição de passadas (SEC-023) |

---

## 6. Matriz financeira

| Cenário | Proteção | Evidência | Teste | Produção | Estado |
|---|---|---|---|---|---|
| double click | reserva + índice único | `cobrancaService.reservarCobranca` | `dez-cliques-uma-sessao.js` | — | VERIFICADO |
| two tabs | mesmo índice por método; métodos diferentes coexistem e a irmã é cancelada | `irmasObsoletasService.js` | `pagamento-…-irmas.js` | — | PARCIAL (SEC-004) |
| duplicate webhook | inbox por id + chave da outbox | `webhookInboxService.js` | autotestes | — | VERIFICADO |
| out-of-order event | matriz + carimbo | `transicoesFinanceiras.js` | autoteste | — | PARCIAL (SEC-008) |
| quote tampering | cotação por id + contratante + referência | `cotacaoService.js` | `valor-vem-do-servidor.js` | — | VERIFICADO |
| price changed | 409 com cotação nova | `cotacaoService.js` | autoteste | — | PARCIAL (SEC-004) |
| Pix→card | RN-04.1 + RN-51 | `pedidoService.js`, `irmasObsoletasService.js` | `pagamento-…-irmas.js` | cancelamento real não exercido | PARCIAL (SEC-003/004) |
| card→Pix | pop-up concluída bloqueia; Pix pago cancela sessão | idem | idem | idem | PARCIAL |
| boleto→card | igual a Pix→card | idem | idem | não medido de quais status a Asaas exclui | NÃO FOI POSSÍVEL VERIFICAR (DELETE real) |
| card→boleto | igual a card→Pix | idem | idem | — | PARCIAL |
| already-paid order | RN-04.1 fail-closed (503 sem banco) | `pedidoService.bloqueioPorPagamentoLocal` | `pedido-pago-nao-cobra-de-novo.js` | 409 em `ped_isento`/`ped_dez_cartao` (25/09) | PARCIAL (SEC-003/004) |
| sibling cancellation | marca na liquidação e pelo estado, lê antes de excluir, teto | `irmasObsoletasService.js` | 89 checagens, 12 sabotagens | só leitura real | PARCIAL |
| simultaneous payments | duplicidade marcada nas duas linhas | idem | idem | — | VERIFICADO (detecção; estorno manual por desenho) |
| Asaas timeout | recusa limpa × ambígua; reserva mantida | `asaasService.foiRecusaLimpaDaAsaas` | autotestes | incidente real 25/09 tratado | PARCIAL (SEC-002/010) |
| DB timeout | inbox 503, RN-04.1 503 | `webhookController`, `pedidoService` | autotestes | — | PARCIAL (SEC-013/014) |
| consumer callback failure | outbox durável | `outboxService.js` | `outbox-sobrevive-a-reinicio.js` | aviso real entregue (Pix, cartão) | VERIFICADO |
| refund | arrendamento + CAS | `refundController.js` | autoteste | — | PARCIAL (SEC-002/005) |
| partial refund | centavos, restante | idem | autoteste | — | PARCIAL (SEC-002) |
| chargeback | mapeado | `transicoesFinanceiras.js` | autoteste | — | PARCIAL (SEC-019) |
| subscription creation | `CHECKOUT_PAID` não é dinheiro | `webhookController.js` | `sessao-concluida-nao-e-pagamento.js` | criada em produção | VERIFICADO (SEC-012 à parte) |
| subscription first cycle | vencimento em Brasília; `criada` só com dinheiro | `diaCivil.js` | `data-para-asaas-e-de-brasilia.js` | aguardando o 1º ciclo real | PARCIAL (SEC-011) |
| renewal | token HMAC; antiga só cancela depois da nova confirmar | `tokenRenovacao.js` | `renovacao-exige-token-nao-so-documento.js` | — | VERIFICADO |
| declined renewal | antiga intacta; nova órfã na Asaas | `webhookController.js` | — | — | NÃO IMPLEMENTADO (SEC-011) |
| plan change | intenção congelada, CAS, releitura | `trocaExecucaoService.js` | 4 autotestes | — | PARCIAL (SEC-009/010) |

---

## 7. Achados

Formato: severidade, status, componente, evidência, cenário, pré-condições, impacto, proteção existente, por que é insuficiente, recomendação, validação necessária. Os cenários descrevem o mecanismo; não são roteiros de exploração. **Nada aqui foi corrigido nesta fase.**

### SEC-001 · HIGH · CONFIRMADO — Caminho arbitrário no pull autenticado do contratante, com a resposta devolvida a anônimo

- **Componente / arquivo / função:** `src/services/pedidoService.js`, `resolverPedido` (linha 230) e `resolverPlano` (linha 341); resposta em `src/controllers/pedidoController.js` (campo `pedido`) e `planoController.js`.
- **Endpoint:** `GET /api/checkout/pedido/:c/:pedidoId` e `/plano/:c/:planoId` (públicos); indiretamente as rotas de criação.
- **Evidência:** a URL de saída é montada por interpolação, `${contratante.api_base_url}/pedido/${pedidoId}`. O Express 4.22.2 decodifica `%2F`/`%3F` nos parâmetros de rota, e `new URL()` normaliza segmentos `..` — reproduzido localmente: um id com segmentos de subida e `?` codificados sai de `/pedido/` para outro caminho da mesma origem. `exigirIdImprevisivel` (linha 88) só confere tamanho e se é só dígitos. `resolverPedido` não valida o formato do corpo devolvido pelo contratante: qualquer 2xx JSON volta ao chamador.
- **Cenário:** anônimo faz o Checkout executar um GET, com a `X-Checkout-Key` do contratante no header, em outro caminho da origem de `api_base_url`, e lê o JSON devolvido.
- **Pré-condições:** o contratante tem, na mesma origem, outros GETs que aceitam essa chave (ou que não exigem nada além de estar na rede dele).
- **Impacto:** leitura de dado do contratante por quem não tem credencial; o Checkout vira um proxy autenticado.
- **Proteção existente:** https + host público no cadastro; redirect revalidado e só na mesma origem; teto de 1 MiB.
- **Por que é insuficiente:** o caminho já sai errado na primeira requisição; a regra de mesma origem não restringe caminho.
- **Recomendação:** restringir `pedidoId`/`planoId` a um alfabeto seguro dentro de `exigirIdNoTeto` (vale para todos os chamadores), `encodeURIComponent` ao montar a URL, e devolver ao navegador só uma lista branca de campos do pedido/plano.
- **Validação necessária:** conferir, com o MostrAí e o contratante de teste, quais GETs a mesma chave alcança; teste de regressão com separadores codificados.

### SEC-002 · HIGH · CONFIRMADO — Estorno parcial repetido devolve o dinheiro duas vezes

- **Arquivo / função:** `src/controllers/refundController.js`, `estornar` e `planejarEstorno`; `src/services/cobrancaService.js`, `registrarEstorno` (libera `estornando_em`).
- **Endpoint:** `POST /api/checkout/estornar`.
- **Evidência:** não existe chave de idempotência na requisição; `planejarEstorno` só exige valor ≤ restante; ao terminar, `registrarEstorno` libera o arrendamento de propósito ("num parcial a linha continua estornável"). `API.md` §5.4 orienta: "numa falha de rede sua, tente de novo depois de alguns segundos".
- **Cenário:** cobrança de R$ 100; contratante pede R$ 30; a Asaas estorna e a resposta não chega ao contratante (timeout dele, até 20 s do nosso lado); ele repete; o restante é R$ 70 e o arrendamento está livre → segundo estorno real de R$ 30.
- **Pré-condições:** o contratante repete a chamada, como o contrato manda.
- **Impacto:** perda financeira do contratante, até o valor cobrado.
- **Proteção existente:** arrendamento serializa chamadas **simultâneas**; a Asaas recusa estorno total duplicado.
- **Por que é insuficiente:** uma repetição sequencial é indistinguível de um segundo parcial legítimo.
- **Recomendação:** exigir chave de idempotência por pedido de estorno (única por cobrança) e devolver o resultado gravado quando ela se repetir; corrigir `API.md` §5.4.
- **Validação necessária:** teste com duas chamadas sequenciais de mesmo valor.

### SEC-003 · MEDIUM · CONFIRMADO — `pedidoId` não canônico contorna RN-04, RN-04.1 e RN-51

- **Arquivo:** `pedidoService.js` (mesma montagem de URL da SEC-001); `cobrancas.pedido_id` gravado cru.
- **Evidência:** normalização local mostra que uma variante com segmento `.` vira exatamente `/pedido/<id>` no contratante, enquanto o nosso banco grava a variante como outra chave.
- **Cenário:** um link com a variante abre e cobra o MESMO pedido real; como as guardas procuram por `pedido_id` exato, nenhuma vê o pagamento já feito sob o id canônico, e as irmãs de um não são irmãs do outro. O aviso ao contratante sai com um `pedidoId` que não é o dele.
- **Pré-condições:** link adulterado (por engano ou de propósito); para o RN-04.1 fazer diferença, o contratante também precisa ter perdido o "pago" (caso real de 25/09).
- **Impacto:** pagamento duplicado sem detecção de duplicidade.
- **Recomendação:** a mesma da SEC-001 (alfabeto restrito na raiz fecha as duas).

### SEC-004 · MEDIUM · CONFIRMADO — Reaproveitamento de Pix/boleto roda antes da guarda de pedido pago e da cotação

- **Arquivo / função:** `src/controllers/checkoutController.js`, `gerarPix` (linha 267 antes de `cotarParaCobrar` na 272) e `gerarBoleto` (linha 380); `cobrancaService.buscarCobrancaPendenteDoPedido` filtra só `status = 'pendente'`.
- **Endpoint:** `POST /api/checkout/pix|boleto/:c/:p`.
- **Cenário:**
  - (i) pedido pago no cartão, Pix/boleto marcado obsoleto mas ainda não excluído (recuo do cancelador, ou esgotado) → a rota devolve de novo a cobrança irmã pagável;
  - (ii) o valor do pedido mudou (cupom) → a tela mostra o valor novo da cotação e a rota devolve o QR/boleto antigo, com o valor antigo;
  - (iii) pedido cancelado/expirado no contratante → o QR antigo continua sendo entregue.
- **Pré-condições:** chamada direta à rota (a tela passa antes por `GET /pedido`, que bloqueia) ou tela aberta antes da mudança.
- **Impacto:** pagamento duplicado (vira RN-52, estorno manual) ou preço cobrado diferente do exibido.
- **Proteção existente:** detecção de duplicidade; o comprador vê o valor no app do banco.
- **Recomendação:** passar pela guarda de pedido (RN-04.1) antes de reaproveitar; ignorar linhas com `obsoleta_desde`; comparar o valor da cobrança reaproveitada com a cotação.

### SEC-005 · MEDIUM · CONFIRMADO — "A cobrança do pedido" é a linha mais recente, não a que pagou

- **Arquivo:** `cobrancaService.buscarCobrancaPorPedido` (ordena por `criado_em`, exclui só `cancelado_por_outro_pagamento`), usada por `statusPublico`, `consultarCobranca` e `/estornar`.
- **Cenário:** Pix gerado; depois uma pop-up de cartão aberta e abandonada (`cancelado`/`expirado`); depois o Pix antigo é pago → status e conciliação dizem `cancelado` para um pedido pago, e `/estornar` responde 409 (a linha escolhida não é estornável). Variante: boleto irmão cujo DELETE falhou é a linha mais recente `pendente` e a tela de status oferece as credenciais dele.
- **Impacto:** conciliação errada, estorno de dinheiro real bloqueado pela API.
- **Recomendação:** priorizar linhas em `STATUS_QUE_LIQUIDAM`; `/estornar` escolher entre as estornáveis ou aceitar `chargeId`.

### SEC-006 · MEDIUM · CONFIRMADO — A outbox segue redirect sem revalidar o destino

- **Arquivo / função:** `src/services/outboxService.js`, `entregar` (linha 152): `fetch` padrão, sem `redirect: 'manual'`, sem revalidar `linha.url` no envio.
- **Evidência:** reproduzido localmente: um endpoint "público" que responde 307 para um endereço interno em http leva o POST, com assinatura e corpo, até lá, e a entrega volta `ok`.
- **Cenário:** contratante hostil ou comprometido faz o próprio endpoint redirecionar os avisos para a rede interna do contêiner, ou rebaixa para http.
- **Pré-condições:** um contratante cadastrado que controla o próprio endpoint (normal no modelo).
- **Impacto:** requisições cegas de dentro da Northflank para destinos internos; payload com documento do pagador em claro; aviso contabilizado como entregue sem ter sido.
- **Proteção existente:** `alvoDeRedeSeguro` no cadastro (estático).
- **Recomendação:** `redirect: 'manual'` tratando 3xx como falha; revalidar o alvo a cada envio; cancelar o corpo da resposta.

### SEC-007 · MEDIUM · CONFIRMADO (desenho) — Webhook confia no corpo; só o token estático separa um evento real de um forjado

- **Arquivo:** `webhookController.js`, `processarEventoPayment` (status do nome do evento), `registrarNovoCicloAssinatura` (valor do ciclo do corpo), `ocorridoEmDoEvento` (carimbo do corpo).
- **Cenário:** com o token vazado, um evento novo com um `payment.id` real confirma cobrança sem pagamento; um carimbo muito no futuro faz a máquina ignorar eventos legítimos posteriores (estorno, chargeback).
- **Pré-condições:** vazamento de `ASAAS_WEBHOOK_TOKEN` (painel, log, env). A Asaas não assina o corpo (limitação registrada, M-01).
- **Impacto:** mercadoria liberada sem pagamento; estado financeiro congelado.
- **Recomendação:** reconsultar `GET /v3/payments/{id}` antes de aplicar confirmação/estorno/chargeback e antes de criar ciclo; conferir valor com `valor_cobrado`; recusar carimbo no futuro.

### SEC-008 · MEDIUM · PRECISA TESTE — Evento posterior descartado enquanto o anterior está em retentativa

- **Arquivo:** `webhookController.js` (transição não permitida → `return` → linha marcada `processado`).
- **Cenário:** `PAYMENT_CONFIRMED` falha por erro transitório e entra em recuo; como respondemos 200, a Asaas manda em seguida o `PAYMENT_REFUNDED`; ele encontra a linha ainda `pendente`, a transição `pendente → estornado` não é permitida, e o evento é descartado como processado; a retentativa aplica `confirmado` e avisa o contratante. Estado final: pago, com o dinheiro devolvido.
- **Impacto:** divergência financeira silenciosa.
- **Recomendação:** adiar evento cuja referência tem linha anterior pendente na inbox, ou tratar "falta o estado anterior" como erro retentável.
- **Validação necessária:** teste com falha injetada no primeiro evento.

### SEC-009 · MEDIUM · CONFIRMADO (lógico) — Acerto de troca de plano órfão: cobrado, plano não muda, ninguém é avisado

- **Arquivo:** `trocaExecucaoService.js` (reivindica → `PROCESSING_PAYMENT` na linha 274, cobra na 363, grava `charge_id` na 374); `trocaSweeperService.js` (`if (!intencao.charge_id) continue;` — o comentário ao lado, "só entra em PROCESSING_PAYMENT depois de cobrar", é **falso**); `webhookController.js` descarta o `PAYMENT_CONFIRMED` que não acha intenção nem cobrança. Não há tratador de `SIGTERM` e a `main` publica sozinha.
- **Cenário:** o processo morre entre a cobrança e `registrarChargeId` (um deploy basta) → intenção presa para sempre, webhook do acerto descartado.
- **Impacto:** assinante cobrado sem receber o plano novo; tela "processando" indefinidamente.
- **Recomendação:** casar `externalReference` `troca:<id>` no webhook; no sweeper, escalar `PROCESSING_PAYMENT` sem `charge_id` depois de N minutos; encerrar com calma no `SIGTERM`.

### SEC-010 · MEDIUM · PROVÁVEL — Acerto de troca de plano cobrado duas vezes depois de falha ambígua

- **Arquivo:** `trocaExecucaoService.js` (falha ambígua em `cobrarNoCartaoSalvo` libera `trocando_em`); `trocaPlanoController.js` cria nova intenção sem checar outra aberta (sem índice único na 0011).
- **Cenário:** a cobrança estoura o tempo depois de a Asaas cobrar; o arrendamento é devolvido; o contratante repete a troca; o assinante aprova de novo → segundo acerto. O `PAYMENT_CONFIRMED` do primeiro é descartado (sem `charge_id` conhecido).
- **Recomendação:** não liberar `trocando_em` em falha ambígua; uma intenção não terminal por assinatura (índice parcial).

### SEC-011 · MEDIUM · PRECISA TESTE (sobe a HIGH se a Asaas se comportar como suposto) — Primeiro ciclo recusado deixa a assinatura viva e invisível

- **Arquivo:** `webhookController.js` (vínculo só em `confirmado`; recusa só avisa `cobranca_falhou`; ciclo sem cobrança-modelo é descartado); ninguém cancela na Asaas; `SUBSCRIPTION_*` ignorado.
- **Cenário:** primeiro ciclo recusado → a reserva é liberada, o pagador assina de novo; se a Asaas cobrar o ciclo seguinte da assinatura antiga, o `PAYMENT_CONFIRMED` é descartado sem aviso. O mesmo vale para a assinatura nova de uma renovação cujo primeiro ciclo é recusado.
- **Pré-condição a medir:** a Asaas mantém a assinatura ativa e gera o próximo ciclo depois de recusar o primeiro.
- **Impacto:** cobrança recorrente sem registro nem aviso; possível cobrança dupla.
- **Recomendação:** gravar `asaas_subscription_id` já no primeiro evento; em recusa/vencimento do primeiro ciclo, cancelar na Asaas ou alertar; não descartar calado pagamento de assinatura desconhecida.

### SEC-012 · MEDIUM · CONFIRMADO — Nada impede uma segunda assinatura ativa do mesmo plano e documento

- **Arquivo:** `asaasCheckoutController.criarCheckoutAssinatura` (a assinatura ativa só é consultada com token de renovação válido); o índice da 0015 só vale para `status = 'pendente'`.
- **Cenário:** o assinante abre de novo o link do plano e paga → duas assinaturas cobrando o mesmo cartão; `/cancelar-assinatura` cancela só a mais recente.
- **Recomendação:** sem token de renovação, recusar quando já existe assinatura ativa/pausada para (contratante, plano, documento).

### SEC-013 · MEDIUM · CONFIRMADO — Aviso de assinatura sem `catch` derruba o processo e se perde

- **Arquivo:** `assinaturaController.js:133` (`notificarAssinaturaCancelada`), `trocaPlanoController.js:364` e `trocaExecucaoService.js:177` (`notificarPlanoTrocado`) — chamadas assíncronas sem `await` nem `.catch`. `enfileirarNotificacao` lança em erro do banco; `server.js:400` trata `unhandledRejection` com `process.exit(1)`. O comentário em `server.js:349-353` ("Todos têm `catch` hoje") é falso.
- **Cenário:** o INSERT na outbox falha logo depois de a Asaas cancelar a assinatura ou de o acerto ser cobrado.
- **Impacto:** aviso ao contratante nunca gravado; reinício do serviço derruba requisições em andamento.
- **Recomendação:** `.catch(registrarErro)` ou `await` com `try`.

### SEC-014 · MEDIUM · PROVÁVEL — Vínculo da primeira confirmação de assinatura engole erro e fica pela metade

- **Arquivo:** `assinaturaService.upsertAssinatura`, `cobrancaService.atualizarSubscriptionIdDaCobranca`, `vincularChargeIdAoCheckout` — só `console.error`; a linha da inbox é marcada `processado`.
- **Cenário:** falha transitória do banco (ou `valor` nulo numa reserva órfã, violando `NOT NULL`) → cobrança `confirmado`, `criada` enviado, e nenhuma linha em `assinaturas`; na retentativa, a condição de "primeira confirmação" já é falsa.
- **Impacto:** cancelar/pausar/consultar respondem 404 enquanto a Asaas cobra; ciclos seguintes ignorados.
- **Recomendação:** relançar os erros; decidir "primeira confirmação" pela ausência da linha em `assinaturas`.

### SEC-015 · MEDIUM · CONFIRMADO (produção) — API administrativa fora do Cloudflare Access, sem 2FA nem trilha de auditoria

- **Evidência ao vivo:** `checkout.sancocore.com.br/admin*` → 302 para o Access; `api.sancocore.com.br/api/admin/*` e a origem `pay--san-checkout--…code.run/api/admin/*` → 401 do login próprio, sem passar pelo Access.
- **Código:** `adminRoutes.js` + `verificarAdminKey`; limite de 5 tentativas por janela em `/api/admin/sessao`; token assinado com chave derivada de `CHECKOUT_ADMIN_PASS_HASH` (não há segredo de sessão separado; não há revogação no servidor); nenhuma tabela de auditoria de ações do admin.
- **Impacto:** a camada que a skill `seguranca-san` exige ("Access além do login, nunca substituindo") protege só o HTML; a API que ele chama depende de uma senha, sem segundo fator (exigido para área administrativa que move dinheiro). Ações como rotacionar chave de contratante, reenfileirar/reenviar filas e editar `api_base_url`/`webhook_url` não deixam rastro de quem fez.
- **Recomendação:** colocar `/api/admin` atrás do Access (política por caminho, com token de serviço se preciso) ou exigir o JWT do Access na origem; 2FA; trilha de auditoria; segredo de sessão próprio com revogação. Relacionado: a API é DNS-only por decisão registrada (`docs/erros/2026-09-14-origem-direta-alcancavel-por-fora.md`).

### SEC-016 · MEDIUM · CONFIRMADO (caminho condicional) — Chave Asaas da subconta vai para o log e sai sem máscara

- **Arquivo:** `adminController.criarSubconta` (`console.error(..., criada)` com `apiKey` completa, quando o INSERT local falha depois de a Asaas criar a subconta); `atualizarLinkAtivacaoSubconta` (`select('*')` devolve a linha inteira, com `api_key`, ao admin). `tests/segredo-nao-sai-do-admin.js` não pega o `select('*')`.
- **Impacto:** segredo que movimenta dinheiro da subconta no log do Northflank; exposição a sessão ou XSS de admin.
- **Recomendação:** logar só ids; lista explícita de colunas e máscara.
- **Nota:** subconta está bloqueada nesta conta (PF); o caminho existe no código.

### SEC-017 · LOW · CONFIRMADO — `chargeId` público interpolado no caminho da Asaas com a chave da conta-mãe

- **Arquivo:** `asaasService.consultarStatus`, chamado por `statusPix`/`statusBoleto` (`GET /api/checkout/pix|boleto/status/:chargeId`, sem autenticação).
- **Evidência:** mesma decodificação da SEC-001; ao vivo, um `chargeId` real de outro pedido devolve o status, e um inexistente devolve o texto de erro da Asaas.
- **Impacto:** oráculo de existência/status de objetos da conta alcançáveis por GET; consumo da cota da Asaas. Volta só `status` ou a mensagem de erro.
- **Recomendação:** validar o formato do id, exigir que ele exista em `cobrancas`, codificar segmentos de caminho em `chamarAsaas`.

### SEC-018 · MEDIUM · PRECISA TESTE — Cartão parcelado: só uma parcela é conhecida

- **Arquivo:** `asaasCheckoutController` (`INSTALLMENT`), `webhookController` (outro `PAYMENT_*` da sessão tratado como "ciclo"), `refundController`/`estornarCobranca` (estorna só o `charge_id`).
- **Cenário:** compra em 3x; um estorno "total" grava `estornado` com o total enquanto a Asaas pode ter estornado uma parcela; chargeback de outra parcela nunca chega.
- **A medir:** quantas cobranças a Asaas cria por parcela no checkout hospedado; semântica do estorno numa parcela.

### SEC-019 · MEDIUM · PRECISA TESTE — `chargeback → confirmado` aceito com qualquer confirmação mais nova

- **Arquivo:** `transicoesFinanceiras.js` (linha de `chargeback`).
- **Cenário:** no cartão, `PAYMENT_RECEIVED` chega na liquidação (≈ D+30); um chargeback aberto antes volta a `confirmado` e o contratante é avisado de novo, restaurando o acesso durante a disputa.
- **Recomendação:** sair de `chargeback` só por evento específico de disputa vencida.

### SEC-020 · MEDIUM · NÃO EXPLORÁVEL hoje — Pix Automático grava `confirmado` sem dinheiro e escreve sem CAS

- **Arquivo:** `webhookController.processarAutorizacaoPixAutomatico` (`ACTIVATED` → `confirmado`; encerramento → `cancelado` por cima de qualquer estado); criação sem reserva prévia.
- **Por que não é explorável hoje:** o método está fora do default de `metodos_habilitados` e desligado nesta conta (`CONSTRAINTS.md` §2.4).
- **Recomendação:** corrigir antes de habilitar para qualquer contratante.

### SEC-021 · LOW · CONFIRMADO (local) — Brechas do filtro anti-SSRF de host

- **Arquivo:** `src/utils/alvoDeRede.js`.
- **Evidência:** aceita IPv4 mapeado/compatível em IPv6, prefixo NAT64, `localhost.`/`.local.` com ponto final, faixas reservadas (`198.18/15`, multicast, broadcast), credenciais e porta na URL; não resolve DNS (nomes que apontam para interno passam — decisão registrada).
- **Mitigação:** exige https com certificado válido; o pull só aceita redirect na mesma origem. Vira relevante se a SEC-006 for corrigida só com revalidação.

### SEC-022 · LOW · PROVÁVEL — Escritas de status fora da máquina de estados

- **Arquivo:** `cobrancaConsultaController.statusAtualizado` → `atualizarStatusCobranca` (sem `where status`), alcançável pela rota pública de status; `registrarEstorno`.
- **Cenário:** a consulta à Asaas demora; nesse intervalo chega um estorno ou o cancelador grava `cancelado_por_outro_pagamento`; a resposta atrasada regrava `confirmado` por cima. `registrarEstorno` sobrescreve um `chargeback` que chegue no meio.
- **Recomendação:** usar `aplicarTransicao` (CAS) nos dois caminhos.

### SEC-023 · LOW · PROVÁVEL — Reivindicação da inbox/outbox ignora o recuo e os workers se sobrepõem

- **Arquivo:** `outboxService.reivindicarEnvio` e `webhookInboxService.reivindicarProcessamento` (CAS sem `proxima_tentativa_em`); `server.js` sem trava de "já rodando".
- **Cenário:** um contratante pendurado (10 s × 50 por passada) faz passadas se empilharem; uma lista antiga reenvia na hora uma linha que acabou de entrar em recuo → as 8 tentativas se queimam em minutos e a linha vai para `abandonada`; os outros contratantes esperam.
- **Recomendação:** incluir o recuo no CAS; trava por worker; concorrência limitada por contratante.

### SEC-024 · LOW · CONFIRMADO — Linha esgotada da inbox só volta pelo nosso admin, e com uma tentativa só

- **Arquivo:** `webhookInboxService` (reentrega da Asaas vira `duplicado`; `reenfileirar` não zera `tentativas`).
- **Impacto:** o reenvio pelo painel da Asaas — reflexo natural do operador — não faz nada; o reenfileiramento esgota na primeira falha.

### SEC-025 · LOW · PRECISA TESTE — Reconciliador apaga reserva sem condição

- **Arquivo:** `cobrancaService.liberarReservaCobranca` (DELETE por `id`, sem condição de estado), chamado pelo reconciliador.
- **Cenário:** um evento vincula a sessão/cobrança à reserva entre a listagem e o DELETE; ou a busca por `externalReference` volta vazia para um Pix que existe → a reserva some e o evento do pagamento não acha linha.
- **Recomendação:** DELETE condicional (`pendente`, sem `charge_id`, sem `asaas_checkout_id`), ou marcar em vez de apagar.

### SEC-026 · LOW · CONFIRMADO — Segmentos de caminho sem codificação no frontend

- **Arquivo:** `public/js/modules/*Handler.js`, `status.js` montam `/api/checkout/.../${c}/${pedido}` sem `encodeURIComponent`.
- **Cenário:** um link com `pedido` contendo subida de diretório faz a tela carregar e cobrar o pedido de **outro** contratante enquanto a barra mostra o contratante do link. Nome e logo exibidos são os do outro contratante (atenua).
- **Recomendação:** codificar todo segmento; a SEC-001 corrigida na raiz também fecha isto.

### SEC-027 · LOW · CONFIRMADO — Validadores sem checagem de tipo

- **Arquivo:** `validadores.js` (`nomeValido`, `emailValido`, `camposDeEnderecoDentroDoTeto`) aplicam `String()` a qualquer valor.
- **Efeito:** objeto/array passa; um e-mail em array pode ser gravado como texto de array. Integridade de dado, não controle de acesso.

### SEC-028 · LOW · CONFIRMADO — Dado pessoal no stdout

- **Arquivo:** `asaasService.chamarAsaas` loga o caminho (que carrega o CPF na busca de cliente) quando a Asaas falha; `asaasCheckoutController` loga `corpoAsaas` cru; `server.js` loga o objeto de erro inteiro (inclui o corpo em JSON malformado).
- **Recomendação:** redigir o caminho, logar só o resumo da Asaas e só a mensagem do erro.

### SEC-029 · LOW · CONFIRMADO — Pausar/retomar com sucesso não devolvem o arrendamento

- **Arquivo:** `assinaturaController` (`liberarTroca` só no `catch`).
- **Efeito:** `/cancelar-assinatura` e `/trocar-plano` respondem 409 por até 5 min depois de uma pausa ou retomada.

### SEC-030 · LOW · CONFIRMADO — Hash de CPF sem sal e tabelas sem retenção

- **Arquivo:** `asaasService` (`sha256(documento)` em `clientes_asaas`; espaço de CPF enumerável → pseudonimização, não anonimização).
- **Retenção ausente:** `clientes_asaas`, `subcontas` (nome, e-mail, documento, endereço, nascimento, chave), `intencoes_troca_plano`, inbox em `falhou`.
- **Classificação:** PROBLEMA TÉCNICO (hash); DECISÃO DE PRODUTO + QUESTÃO JURÍDICA (prazos).

### SEC-031 · LOW · CONFIRMADO — Saúde não reflete worker parado; Northflank sem health check

- **Evidência:** `/api/saude` devolve 200 com o carimbo dos workers só no corpo; `healthChecks: null` no serviço; a rota expõe contagens de fila e alertas da chave sem autenticação.
- **Impacto:** monitor por código HTTP não percebe worker morto; a plataforma não reinicia um processo pendurado.

### SEC-032 · LOW · CONFIRMADO (mitigado) — `link_ativacao` de subconta sem validação de esquema

- **Arquivo:** `adminController.atualizarLinkAtivacaoSubconta` grava sem checar; `admin.js` põe no `href` (com `escapar()`).
- **Mitigação:** CSP `script-src 'self'` bloqueia `javascript:`; só o admin escreve.

### SEC-033 · LOW · CONFIRMADO — Três avisos moderados de dependência (caminho alcançável)

- `qs` 6.15.3 (via `express` 4.22.2 / `body-parser` 1.20.6): GHSA-x5fp-wj9c-mxmx (limite de array contornado) e GHSA-4mjr-xmp4-gh2g (DoS). O `qs` é o parser das query strings do Express, então o caminho é alcançável; correção disponível. O CI só barra `high`, por isso passa.

### SEC-034 · LOW · CONFIRMADO — Supply chain / CI

- `ci.yml` sem bloco `permissions:` (herda o default do repositório); gitleaks baixado sem conferir checksum; sem Dependabot/Renovate; sem CODEOWNERS; branch protection **NÃO FOI POSSÍVEL VERIFICAR**. O deploy da Northflank é disparado pelo push na `main`, não pelo resultado do CI: o CI verde é porta **de processo** (mesclar só com verde), não técnica. Nenhuma dependência com script de instalação.

### INFO

- **INFO-01** Rate limit em memória, por IP, com `trust proxy 1`; zera no reinício; uma instância. Número de saltos de proxy não verificado.
- **INFO-02** Pages serve o HTML estático com `Access-Control-Allow-Origin: *` (conteúdo público).
- **INFO-03** CSP do front com `style-src 'unsafe-inline'` e `img-src https:` amplo; sem Trusted Types; HSTS sem `preload`.
- **INFO-04** Imagens de logo/banner vindas do contratante podem servir de pixel de rastreio (IP do comprador).
- **INFO-05** `compararSeguro` retorna antes quando os tamanhos diferem (vaza o tamanho do token).
- **INFO-06** IP registrado nas rejeições do webhook vem do primeiro item de `X-Forwarded-For` (falsificável; só log).
- **INFO-07** Token de renovação e `pedidoId` viajam na query string (histórico do navegador; coleta do Web Analytics não verificada).
- **INFO-08** Depois do expurgo de 90 dias da inbox, o mesmo id de evento seria reprocessado (a máquina de estados limita o dano).
- **INFO-09** Cliente Supabase sem teto de tempo próprio.
- **INFO-10** A URL da outbox é congelada no enfileiramento; a chave é lida no envio.
- **INFO-11** Mensagem de erro da Asaas repassada ao cliente em algumas rotas (ex.: `404 — (corpo vazio)` no status público).
- **INFO-12** `docs/CHECKOUT_CONSOLIDATION_STATE.md` cita prefixo e 4 últimos caracteres de uma chave de **sandbox** (DÚVIDA; desnecessário).
- **INFO-13** Grants padrão do papel `anon` existem nas 12 tabelas; o bloqueio depende só do RLS sem policy (defesa em profundidade).
- **INFO-14** Tela Pix aberta de uma irmã cancelada continua mostrando "aguardando" (limitação 2 do PR #48): sem risco financeiro — o QR deixa de funcionar no banco —, é UX e sincronização de estado.

---

## 8. Testes existentes

- **63 suítes** em `tests/executar.js`, todas verdes local e no CI (`npm run check`, que inclui análise de sintaxe de `public/js/`).
- **Tipos:**
  - **UNIT/autoteste**, a maioria: bloco no fim de cada módulo, com dependências injetadas.
  - **INTEGRATION com código real**: `tests/pagamento-de-um-pedido-invalida-as-irmas.js`, `pedido-pago-nao-cobra-de-novo.js` e `outbox-sobrevive-a-reinicio.js` (banco falso em arquivo, `tests/banco-falso/`, processos filhos); `rotas-http-respondem-como-prometido.js` (Express montado de verdade).
  - **CONTRACT/fonte**: `toda-rota-publica-tem-teto.js`, `o-que-os-documentos-afirmam.js` e algumas checagens por regex sobre o código-fonte. Provam presença, não comportamento.
- **Rede:** sempre simulada nas suítes. Nenhuma suíte toca a Asaas nem o Supabase reais.
- **Fora do CI:** `npm run acessibilidade` e `npm run desempenho` (precisam de Chromium), o ensaio de restauração e a limpeza de sandbox.
- **Sabotagem documentada:** RN-51 (12), troca de plano (9), `divergenciaDeValor` (8), pedido pago (2), incidente de 25/09 (6), entre outras. O mecanismo é temporário e manual; não há mutação automatizada no CI.
- **Lacunas de teste que esta baseline achou:**
  - nenhuma suíte usa `pedidoId`/`chargeId` com separador codificado (SEC-001/003/017);
  - nenhuma repete um estorno parcial (SEC-002);
  - nenhuma cobre redirect na outbox (SEC-006);
  - nenhuma injeta falha no primeiro de dois eventos em sequência (SEC-008);
  - nenhuma mata o processo entre cobrar e gravar o `charge_id` da troca (SEC-009);
  - nenhuma encadeia o reaproveitamento de Pix com um pedido pago (SEC-004).

---

## 9. OWASP (taxonomia, não conformidade)

| Categoria | Achados |
|---|---|
| API1 BOLA / A01 Broken Access Control | SEC-001, SEC-003, SEC-017, SEC-026 |
| API2 Broken Authentication / A07 | SEC-015 |
| API3 Property Level Authorization | SEC-016, SEC-001 (corpo refletido) |
| API4 Unrestricted Resource Consumption | SEC-023, SEC-033, INFO-01 |
| API6 Unrestricted Access to Sensitive Business Flows | SEC-002, SEC-004, SEC-010, SEC-012 |
| API7 SSRF / A10 | SEC-006, SEC-021, SEC-001 |
| API8 Security Misconfiguration / A05 | SEC-031, SEC-034, INFO-03 |
| API10 Unsafe Consumption of APIs | SEC-007, SEC-008, SEC-011, SEC-018, SEC-019 |
| A04 Insecure Design | SEC-005, SEC-009, SEC-014, SEC-020 |
| A06 Vulnerable Components | SEC-033 |
| A09 Logging and Monitoring Failures | SEC-013, SEC-016, SEC-028, SEC-015 (sem trilha) |

---

## 10. Método e limites desta baseline

- **Código:** seis frentes de leitura em paralelo:
  - superfície/autenticação/tenant;
  - integridade financeira;
  - webhooks/outbox/SSRF/workers;
  - entrada/XSS/CORS/CSP;
  - banco/segredos/logs/PII;
  - dependências/CI/testes.
  - Todo achado HIGH e os MEDIUM de maior peso foram **reconferidos no código** antes de entrar aqui. SEC-001/003 foram reproduzidos localmente com o Express e o `URL` reais. SEC-002, SEC-004, SEC-006, SEC-009 e SEC-013 foram conferidos na linha citada.
- **Produção:** só leitura e requisições não destrutivas:
  - snapshot da Northflank e do contêiner (presença de segredo, nunca valor);
  - catálogo do Supabase e o advisor de segurança;
  - leitura com a chave anon;
  - headers servidos, CORS por preflight, Access;
  - GETs sem credencial ou com credencial falsa;
  - um POST com JSON malformado barrado no parser.
  - Nenhuma cobrança, estorno, cancelamento ou escrita em banco. Nenhum brute force nem fuzz.
- **O que não foi feito e o Codex deve tentar:**
  - explorar as premissas marcadas PRECISA TESTE (SEC-008, 011, 018, 019, 025) contra um ambiente sandbox;
  - procurar caminhos de dinheiro que esta baseline não mapeou;
  - verificar as configurações que daqui não se leem (branch protection, políticas do Access, saltos de proxy).
