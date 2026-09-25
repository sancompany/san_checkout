# Executive Summary

**SHA Auditado:** 43635c46875ea5655402bbec37a5f2fd0317ff54
**Baseline Utilizada:** commit 5ff3e93 (docs/SECURITY_STATION_6_BASELINE_2026-09-25.md)

**Severidade dos Findings Atuais:**
- Critical: 0
- High: 3 (1 from baseline expanded to High, 2 from baseline confirmed)
- Medium: 17
- Low: 15
- Info: 14

**Novos Findings (Jules):**
- High: 1
- Medium: 3
- Low/Info: 2

*Nenhuma correção de código foi realizada nesta etapa, a auditoria é apenas read-only sobre o repositório.*

# Findings Claude confirmados

| Finding Claude | Resultado Jules | Severidade Jules | Motivo |
|---|---|---|---|
| SEC-001 (Canonicalização) | EXPANDIDO | HIGH | Falta de canonicalização não afeta só o \`pedidoId\`. O erro permite Path Traversal (não estritamente SSRF pleno, já que o host é fixo em \`api_base_url\`), vazando dados cruzados entre URLs do contratante. |
| SEC-002 (Estorno parcial sem idempotência) | CONFIRMADO | HIGH | Concorrência ou retries falhos geram double refunds pela falta de chave de idempotência na Asaas API. |
| SEC-004 (Pix/Boleto pendente reaproveitado) | CONFIRMADO | MEDIUM | A checagem de "pedido pago" falha no fluxo direto se o ID pendente antigo já foi gerado e reaproveitado via \`reaproveitarCobrancaPendente\`. |
| SEC-006 (Outbox SSRF/Redirect) | CONFIRMADO | HIGH | O \`fetch\` segue redirects cegamente com método \`POST\` e headers originais de webhook (credenciais HMAC vazando no processo). |
| SEC-007 (Asaas Webhook spoofing) | CONFIRMADO | HIGH | Sem verificação de assinatura e apenas com um secret global \`asaas-access-token\`, o comprometimento do segredo permite fabricar estados financeiros falsos que o sistema não confere com a API do Asaas. |
| SEC-008 (Eventos fora de ordem) | CONFIRMADO | MEDIUM | Eventos omitidos deixam o sistema preso e impedem processamentos subsequentes corretos (ex: chargeback chegando antes). |
| SEC-009 (Troca de Plano Crash) | CONFIRMADO | MEDIUM | Crash fatal (OOM/SIGKILL) em \`PROCESSING_PAYMENT\` deixa intento órfão permanentemente. |
| SEC-012/SEC-016 (Fire-and-Forget Notification) | CONFIRMADO | MEDIUM | Múltiplas funções assíncronas chamam \`deps.notificar\` sem \`await\`. Exceções não tratadas levam a \`unhandledRejection\`, derrubando o processo inteiro de Node (pois existe \`process.exit(1)\`). |

# Findings Claude refutados
(Nenhum finding relevante refutado da baseline.)

# Findings Claude expandidos/reclassificados

| Finding Claude | Resultado Jules | Severidade Jules | Motivo |
|---|---|---|---|
| SEC-003 / SEC-017 / SEC-026 (Outras Canonicalizações) | EXPANDIDO | MEDIUM | Além do \`pedidoId\`, IDs como \`planoId\`, \`asaasCheckoutId\`, e chaves do cache estão vulneráveis à injeção de pipes \`|\` ou saltos de path \`../\`, quebrando delimitações do Redis/Supabase. |

# Novos findings Jules

1. **JULES-001** (HIGH): Isolamento Multi-Tenant nas queries de webhook/reserva (BOLA/Tenant Cross-Access). Rotinas como \`buscarCobrancaPorReferenciaExterna\` ou \`buscarCobrancaPorCheckoutId\` ignoram o \`contratante_id\` na pesquisa (utilizando \`eq('id', ...)\` ou \`eq('asaas_checkout_id', ...)\` direto). Um token ou chave comprometida de tenant A pode permitir vazamento/manipulação em tenant B, pois a proteção de API administrativa depende só do \`X-Admin-Token\`.
2. **JULES-002** (MEDIUM): Falha em \`trust proxy\` do Express. O \`app.set('trust proxy', 1)\` é muito estrito para infraestruturas com saltos múltiplos (como Cloudflare -> Northflank proxy). Isso permite contornar rate-limits em \`express-rate-limit\` ou injetar falhas.
3. **JULES-003** (MEDIUM): Supabase queries suscetíveis a falta de isolamento RLS, pois a chave usada é o \`service_role\`, que ignora RLS.
4. **JULES-004** (MEDIUM): Reconciliação ineficaz contra webhooks corrompidos. O \`reconciliacaoService.js\` não revalida estados atuais e só verifica faturas sem \`charge_id\`, permitindo falhas lógicas e de ordem passarem intocadas permanentemente.

# Integridade financeira

- A concorrência para \`POST /estornar\` falha em fornecer Idempotência real na ponta (Asaas), gerando duplo reembolso em falhas de timeout.
- Sibling payment charges podem ser geradas sem o \`bloqueioPorPagamentoLocal\` em algumas rotas que ignoram \`status=pendente\`.

# Tenant isolation
- Ausência de \`contratante_id\` em diversas queries como \`buscarIntencao\`, \`buscarAssinaturaPorId\`. (Revisar se as rotas expostas para o exterior que permitem input arbitrários confiam só no \`id\`).

# Webhooks
- Sem \`Signature validation\`. Usa só o secret \`asaas-access-token\`.

# SSRF / Outbox
- Outbox \`fetch\` é passivo a redirecionamento (301, 307). Em caso de um servidor contratante devolver \`Location: http://169.254.169.254\`, os headers são injetados.

# Admin/Auth
- Auth Admin usa HMAC simples, que protege contra brute forcing local e revalidação no DB, mas não possui CSRF e depende puramente do \`X-Admin-Token\`.

# Concorrência
- Lock/CAS está implementado na máquina de estados, mas o Asaas POST (\`/v3/payments\`) não leva chave de idempotência.

# Banco
- \`service_role\` usado globalmente ignora Row Level Security.
- \`process.exit(1)\` pode corromper operações transacionais em memória que não efetuam retry.

# Dependências
- `qs` \`6.15.3\` (moderado, array limit bypass).

# Test gaps
- Mocks da Asaas não modelam os timeouts (ambiguidade).
- Testes de \`processarWebhook\` rodam isoladamente sem considerar as chamadas assíncronas que crasheam o processo.

# Validações que exigiriam produção (REQUIRES_EXTERNAL_VALIDATION)

1. Verificar configurações de IP Headers da Northflank/Cloudflare para justificar o \`trust proxy 1\`.
2. Verificar o comportamento de `v3/refunds` na API Real Asaas se retries sem idempotência dobram o reembolso.
3. Verificar Northflank logs para saber a real vazão de \`unhandledRejections\`.

# Blockers para fechar Estação 6
- **SEC-001** (Path Traversal em Identificadores).
- **SEC-002** (Idempotência no estorno).
- **SEC-006** (Outbox Redirect).
- **SEC-007** (Webhook spoofing no Asaas).
- **JULES-001** (Tenant Cross-Access queries).
