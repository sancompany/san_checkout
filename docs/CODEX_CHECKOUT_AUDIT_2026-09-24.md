# CODEX — SAN CHECKOUT AUDIT

> Relatório da auditoria independente do Codex, entregue pelo dono em
> 24/09/2026 por chat e gravado aqui verbatim para acompanhar a
> consolidação (`docs/CHECKOUT_FINAL_CONSOLIDATION_2026-09-24.md`).
> Nada abaixo foi editado; o veredito de cada achado
> (CONFIRMED / PARTIAL / ALREADY_FIXED / FALSE_POSITIVE) está no
> relatório de consolidação, não aqui.

**Data da auditoria:** 2026-09-24 (UTC)
**Escopo:** leitura independente do commit `f7b1cb9bf64383cb9a1f698ec0e5deac80fe2022`; nenhuma cobrança, alteração de banco, deploy ou mudança funcional.
**Método:** código executável → migrations → configuração versionada → contratos → testes → documentação. Documentos anteriores foram usados somente como índice.
**Limitação material:** o ambiente desta execução bloqueou com `CONNECT tunnel failed, response 403` todas as consultas externas a GitHub, API/Pages, Cloudflare e health check. Não foi possível reconfirmar banco remoto, variáveis efetivas, configuração do webhook no painel Asaas, SHA Northflank nem o repositório executável do Mostraí. Afirmações externas abaixo são, portanto, **não verificadas nesta rodada**, ainda que documentos do projeto relatem verificações anteriores.

## 1. Resumo executivo

O SAN Checkout é uma aplicação Node/Express e frontend estático que atua como orquestrador de checkout. O consumidor não envia preço na criação: o backend autentica o contratante cadastrado e faz *pull* de `/pedido/{id}` ou `/plano/{id}`; então calcula taxa de pedido avulso e cria cobrança/sessão na Asaas. Cartão é coletado exclusivamente pela página hospedada da Asaas. Pix e boleto usam cobrança direta. Supabase guarda contratantes, cobranças, assinaturas, auditoria e intenções de troca.

O limite PCI está bem desenhado: não foi encontrado campo, request ou persistência de PAN/CVV no código próprio. Valor e condição comercial vêm do servidor consumidor, não do navegador. Há reserva atômica para Pix/boleto, leases para estorno e mutações de assinatura, restrições de banco e assinatura HMAC nas notificações ao consumidor.

O gate financeiro, porém, está **bloqueado** por quatro falhas objetivas:

1. uma exceção ao processar webhook é convertida em HTTP 200, impedindo retry da Asaas e permitindo que pagamento confirmado nunca chegue ao consumidor;
2. a entrega Checkout → consumidor é apenas memória (`setTimeout().unref()`), sem outbox persistente ou reconciliação automática; reinício perde a confirmação e o entitlement pode nunca atualizar, mesmo sem depender do navegador;
3. os eventos de assinatura enviados ao consumidor não carregam `chargeId`, status financeiro, valor ou ciclo (salvo `plano_trocado`), impedindo deduplicação/reconciliação de renovação, refund e chargeback;
4. a instalação publicada estava documentada como conectada ao sandbox Asaas e não foi possível reconfirmar ambiente/deployed SHA nesta auditoria. Ela não deve ser considerada pronta para dinheiro real sem prova externa do isolamento e da configuração.

**Veredito global Mostraí:** **PARCIALMENTE COMPATÍVEL.** Essencial/Pro/Prime são IDs opacos e podem funcionar; os quatro ciclos possuem equivalentes Asaas válidos. Entretanto, o contrato não preserva explicitamente `accountId`, nome canônico do plano, preço-base, promoção e referência comercial; e o canal financeiro de assinatura não fornece identidade/status suficientes para o Mostraí decidir entitlement de forma determinística.

**Contagem:** 4 CRITICAL, 8 HIGH, 10 MEDIUM, 7 LOW; 8 incompatibilidades/parcialidades Mostraí; 7 legados relevantes.

## 2. Arquitetura confirmada

| Camada | Implementação real | Estado |
|---|---|---|
| Site/checkout | `public/index.html`, `public/js/app.js`, módulos Pix/boleto/cartão/assinatura | ACTIVE |
| Status público | `public/status.html`, `public/js/status.js` | ACTIVE |
| Troca de plano | `public/troca.html`, `public/js/troca.js` | ACTIVE |
| Admin | `public/admin.html`, `public/js/admin.js` | ACTIVE, sem painel de lojista |
| API | Express em `src/server.js`; rotas em `src/routes/` | ACTIVE |
| Banco | Supabase/Postgres; migrations `0001`–`0014` | schema local coerente; aplicação remota não reconfirmada |
| PSP | Asaas `/v3`; sandbox/produção selecionados em `src/config/asaas.js` | implementação ACTIVE; ambiente real não reconfirmado |
| Webhook PSP | `POST /api/webhooks/asaas` + token estático | ACTIVE com riscos de durabilidade |
| Callback consumidor | POST assinado HMAC para `contratantes.webhook_url` | ACTIVE, best-effort em memória |
| Auth contratante | `X-Checkout-Key` comparada ao cadastro | ACTIVE em operações privadas |
| Auth admin | usuário/senha scrypt → token HMAC de 8 h em header | ACTIVE; logout é descarte local |
| Infra | Northflank (backend), Cloudflare Pages (estático), Supabase | descrita; indisponível para verificação externa nesta rodada |
| Logs | console redigido + tabelas `webhook_eventos`, `webhook_rejeicoes`, `erros` | PARTIAL |

Fluxo confirmado de pedido: navegador abre `/?c={contratante}&pedido={id}` → frontend consulta `GET /api/checkout/pedido/...` → Checkout busca o pedido no consumidor com `X-Checkout-Key` → frontend envia somente pagador/método → backend repete o *pull*, calcula valor e chama Asaas → webhook Asaas atualiza Supabase → callback HMAC tenta avisar o consumidor. O redirect da pop-up aponta apenas para uma página de fechamento; não é a autoridade financeira.

Fluxo de assinatura: `/?c=...&plano=...` → `GET /plano/...` → *pull* do plano → `POST /assinatura/...` → sessão `RECURRENT` hospedada → `CHECKOUT_PAID`/`PAYMENT_CONFIRMED` → linha `assinaturas` → callback simplificado `tipo=assinatura`.

## 3. Código vs deploy

- Branch local: `work`.
- HEAD auditado: `f7b1cb9bf64383cb9a1f698ec0e5deac80fe2022` (`docs: reconferir o ensaio de restauração e avisar o MostrAí do novo 409 (#41)`).
- Este checkout não contém remote nem remote-tracking refs: `.git/config` só possui `[core]`; `origin/main` é inexistente localmente.
- Documentação aponta `sancompany/san_checkout`, branch de produção `main`, mas a API do GitHub não pôde ser consultada (403 do proxy).
- **origin/main:** NÃO VERIFICÁVEL nesta cópia.
- **deployed SHA Northflank:** NÃO VERIFICÁVEL nesta rodada.
- **SHA Cloudflare Pages:** NÃO VERIFICÁVEL nesta rodada.
- Working tree estava limpa antes desta documentação.

Conclusão: não há evidência suficiente para afirmar `código auditado = código deployado`. Isto é achado H-07, não uma afirmação de divergência: falta a prova exigida.

## 4. Ambientes

O código falha para sandbox por padrão: somente `ASAAS_AMBIENTE=producao` seleciona `https://api.asaas.com`; qualquer outro valor usa `https://api-sandbox.asaas.com`. Esse default é seguro contra cobrança real acidental, mas mascara typo de configuração. Cada cobrança grava `ambiente` e `e_teste` (migration 0009), permitindo excluir sandbox de métricas.

Não há staging versionado. O mesmo backend/DB descrito como produção operacional usa o PSP sandbox segundo `.ia/PROJECT_STATE.md`; isso não foi reconfirmado. Variáveis esperadas: `ASAAS_API_KEY`, `ASAAS_AMBIENTE`, `ASAAS_WEBHOOK_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ORIGEM_FRONTEND`, taxas e credenciais do admin. Nenhum valor foi impresso.

## 5. Asaas

- Base sandbox: `https://api-sandbox.asaas.com`; produção: `https://api.asaas.com`.
- Autenticação: header `access_token`; timeout global de 20 s.
- Customer: `buscarOuCriarCliente`; risco de corrida de criação permanece (H-05).
- Payment: Pix/boleto e acerto de troca por `/v3/payments`; pop-up/cartão/recorrência por `/v3/checkouts`.
- QR Pix obtido em segunda chamada após criar payment. O erro é marcado como "payment já criado" para não liberar reserva indevidamente.
- Refund diferencia resposta imediata e assíncrona; lease local reduz refund duplicado.
- Split existe quando `wallet_id` existe, mas está documentado como não exercido; sem wallet, 100% vai à conta-mãe.
- Não há header de idempotência enviado à Asaas. A proteção é local e não resolve timeout ambíguo já processado no PSP.
- Erros 4xx são expostos pela descrição do PSP ao comprador e logados de forma parcialmente redigida.
- `PAYMENT_PARTIALLY_REFUNDED` é colapsado em `estornado`, perdendo a natureza/quantia parcial (H-04).
- MED Pix não foi encontrado. Não declarar suporte.

## 6. Pix

**Criação:** *pull* do pedido, validação de valor/pagador, reserva local única por `(contratante,pedido,método)` e criação na Asaas.
**Customer:** busca/criação na Asaas.
**QR/copia-e-cola:** retornados ao frontend e exibidos; não persistidos como segredo.
**Expiração:** vencimento/polling existem; `PAYMENT_OVERDUE` vira `vencido`.
**Confirmação:** webhook, não browser.
**Cancelamento:** não há cancelamento Pix explícito; expiração é o fluxo.
**Refund:** rota privada do contratante.
**MED:** ausente.
**Timeout/retry:** timeout global; timeout ambíguo mantém reserva, mas não há reconciliador automático.
**Idempotência:** forte contra duplo clique dentro do banco; incompleta através da fronteira PSP.

Cenários adversariais: cinco cliques convergem para uma reserva/cobrança pendente; falha após criação e antes de completar o registro pode deixar payment Asaas órfão localmente (H-06); webhook repetido no mesmo status é ignorado; evento fora de ordem pode regredir o status porque a transição não compara precedência (C-03).

## 7. Cartão

O frontend nunca renderiza input de cartão. Ele envia nome, contato, documento, endereço e parcelas para criar uma sessão Asaas Checkout, abre `checkoutUrl` e consulta status local a cada 3 s. `billingTypes=['CREDIT_CARD']`; parcelas são limitadas a 12 e também pelo piso R$ 5/parcela.

O backend recalcula o preço via novo *pull*, não confia no DOM. O botão é desabilitado durante criação, mas sessões de pop-up não têm a mesma reserva única por pedido/método antes da chamada externa: o índice só atua quando a linha local é inserida **depois** de `/v3/checkouts`. Duas requisições simultâneas podem criar duas sessões Asaas e apenas uma ser registrada (C-04).

Recusa e análise de risco são mapeadas. Não há captura/tokenização própria, retry de cartão ou armazenamento de token. Chargeback é mapeado para status local, mas o evento de assinatura correspondente é insuficiente para reconciliação.

## 8. PAN/CVV / PCI boundary

**Resultado:** não foi encontrado PAN, CVV, CVC, validade ou token de cartão em formulários próprios, payloads próprios, banco, logs, analytics, `localStorage` ou `sessionStorage`. Cartão é preenchido no domínio hospedado da Asaas. O projeto deliberadamente cria nova assinatura para renovação em vez de receber cartão no backend.

Dados que chegam ao backend: nome, e-mail, CPF/CNPJ, telefone, endereço, CEP, cidade/UF/IBGE e parcelas. São dados pessoais/antifraude, mas não PAN/CVV.

## 9. Webhooks

Endpoint: `POST /api/webhooks/asaas`. Autenticação: igualdade em tempo constante do header `asaas-access-token` com `ASAAS_WEBHOOK_TOKEN`; sem segredo configurado responde 503. Não há assinatura do corpo, allowlist de IP ou timestamp/replay da Asaas; replay é contido apenas pela comparação do status corrente.

Eventos reconhecidos: confirmação/recebimento, refund total/parcial/em progresso/negado, vencido, análise, recusa, chargeback e reversão de baixa; `CHECKOUT_*`; autorização Pix Automático; conta/chave. `SUBSCRIPTION_*` não é tratado diretamente.

Falha crítica: `processarWebhook` é envolvido em `try/catch`, mas o receptor responde 200 inclusive quando processamento falha. A auditoria registra `erro`, porém a Asaas entende sucesso e não reenvia. Falha transitória do Supabase no instante de `PAYMENT_CONFIRMED` pode deixar pagamento confirmado apenas no PSP.

Replays iguais normalmente param na guarda `cobranca.status === novoStatus`. Não existe ID único do evento Asaas com constraint; eventos diferentes que mapeiam ao mesmo status também são colapsados. Não há máquina de precedência: um evento atrasado pode sobrescrever `estornado`/`chargeback` com `confirmado` ou `pendente`.

## 10. Idempotência

| Operação | Proteção | Veredito |
|---|---|---|
| Pix/boleto create | índice parcial + reserva antes da Asaas | boa localmente; sem chave PSP/reconciliação |
| Cartão/assinatura create | unique local inserido após Asaas | insuficiente contra concorrência externa |
| Customer | busca seguida de create | corrida possível |
| Webhook | status igual + unique charge | parcial; sem event ID/ordem |
| Refund | lease + status confirmado | boa localmente; timeout ambíguo exige operação manual |
| Callback consumidor | consumidor deve deduplicar `chargeId+status` | pedido avulso razoável; assinatura insuficiente |
| Troca | intenção, lease, CAS e sweeper | forte, embora callbacks permaneçam frágeis |
| Transação interna | operações distribuídas não são transação atômica | parcial |

## 11. Status mapping

| Asaas/evento | SAN status/evento | Mostraí esperado | Avaliação |
|---|---|---|---|
| PAYMENT_CONFIRMED / RECEIVED | `confirmado` | PAID/CONFIRMED | correto para pedido |
| PAYMENT_AWAITING_RISK_ANALYSIS | `em_analise` | PENDING | correto |
| PAYMENT_REPROVED_BY_RISK_ANALYSIS / CAPTURE_REFUSED | `recusado` | FAILED/REFUSED | correto |
| PAYMENT_OVERDUE | `vencido` | FAILED/PENDING vencido | ambíguo semanticamente |
| PAYMENT_REFUND_IN_PROGRESS | `estorno_solicitado` | PENDING REFUND | correto |
| PAYMENT_REFUND_DENIED | `estorno_negado` | PAID/refund failed | correto |
| PAYMENT_REFUNDED | `estornado` | REFUNDED | correto |
| PAYMENT_PARTIALLY_REFUNDED | `estornado` | PARTIALLY_REFUNDED | **incorreto/perda de detalhe** |
| CHARGEBACK_REQUESTED / AWAITING_REVERSAL | `chargeback` | CHARGEBACK | correto, sem fase/resultado |
| CASH_UNDONE | `pendente` | PENDING | pode regredir estado terminal |
| CHECKOUT_PAID | `confirmado` | PAID | correto, vínculo depende de PAYMENT_CONFIRMED |
| CHECKOUT_CANCELED | `cancelado` | CANCELLED | correto localmente |
| CHECKOUT_EXPIRED | `expirado` | FAILED/EXPIRED | correto localmente, não notifica pedido |
| assinatura `criada` | evento sem status financeiro/charge | entitlement ativável? | insuficiente |
| assinatura `cobranca_confirmada` | evento sem charge/value/cycle | renovação | insuficiente |
| assinatura `cobranca_falhou` | evento sem charge/reason/status | falha | parcial |
| assinatura `estornada`/`chargeback` | evento simplificado | revogação/reconciliação | insuficiente |

## 12. Valores monetários

Banco usa `numeric(10,2)`/`numeric(12,2)`. JavaScript usa `Number` (IEEE-754) e arredonda para centavos em helpers. Há varreduras de combinações no `taxaService`, mas não existe tipo inteiro-centavos end-to-end. O risco residual é discrepância de arredondamento em taxa/acerto e soma de componentes (M-05).

O preço de pedido é `Number(valorComDesconto)+Number(frete)`; assinatura cobra `Number(plano.valor)`. Para assinatura não há taxa SAN. A tela usa os valores retornados pelo backend e a criação faz novo *pull*. Isso impede adulteração de preço pelo navegador, mas cria TOCTOU: a tela pode mostrar X, o consumidor mudar o pedido/plano, e o segundo *pull* cobrar Y sem exigir reconfirmação (C-02). Troca de plano é a exceção positiva: congela snapshot e revalida.

## 13. Banco

Tabelas reais nas migrations: `contratantes`, `cobrancas`, `assinaturas`, `subcontas`, `webhook_eventos`, `webhook_rejeicoes`, `erros`, `intencoes_troca_plano`. Não existem tabelas separadas de users, merchants, orders, customers, refunds ou sessions.

Pontos sólidos: FKs de contratante, IDs PSP únicos, índices de busca, índice parcial contra pendência duplicada, RLS default-deny, checks de status/método/ciclo, snapshot e CAS da troca.

Riscos: `contratante_id` usa `ON DELETE SET NULL`, reduzindo rastreabilidade se houver delete; `pedido_id` não possui unicidade histórica; grande parte dos campos de cobrança é nullable; não há constraint de valor positivo/coerência de parcelas; nenhuma FK para plano/pedido (externos); não há outbox; API keys de contratante e subconta são persistidas em texto acessível à service role/admin (H-08); schema remoto/migrations aplicadas não foram reconfirmados.

## 14. Auth

Não há conta de comprador ou lojista. Rotas de criação são públicas por design e usam IDs imprevisíveis; o consumidor é autenticado somente nas ações privadas por sua API key.

Admin: senha scrypt, sessão HMAC de 8 h no header `X-Admin-Token`, rate limit 5/min no login e 60/min nas demais rotas. Não há cookie, logo CSRF clássico não se aplica. Token fica no navegador (a implementação deve ser considerada bearer); logout/revogação individual não existe. Cloudflare Access é alegado como segundo perímetro, mas não foi reconfirmado.

Recuperação de senha inexiste. Sessão não usa HttpOnly/Secure/SameSite porque não usa cookie. Isso evita CSRF mas aumenta impacto de XSS no admin (token legível por JS).

## 15. Authorization / IDOR

A service role ignora RLS; toda separação multi-tenant depende de filtros no código. A chave privada resolve um `contratante` e refund/troca cruzam o `contratante.id` com o recurso. O atalho de `resolverPlano` rejeita objeto de contratante divergente. Isso é positivo.

Superfícies públicas expõem pedido/plano a quem possui IDs da URL. A guarda só recusa IDs puramente numéricos com menos de 8 dígitos; timestamp numérico ou IDs alfabeticamente previsíveis continuam enumeráveis. O Checkout também repassa `pagador` pré-preenchido, logo um ID vazado expõe PII (M-06). A imprevisibilidade é obrigação externa, não capacidade verificável do servidor.

## 16. API

Rotas ACTIVE:

- GET `/api/checkout/pedido/:contratanteId/:pedidoId`
- GET `/api/checkout/plano/:contratanteId/:planoId`
- POST `/api/checkout/pix|boleto|cartao/:contratanteId/:pedidoId`
- GET status Pix/boleto/checkout e status público
- POST assinatura cartão/Pix Automático
- POST cancelar/pausar/retomar/consultar/trocar plano
- POST troca contexto/aprovar
- POST estornar
- admin CRUD/observabilidade/subcontas
- POST `/api/webhooks/asaas`
- GET `/api/saude`

Validação cobre documentos, email, telefone, CEP, tamanhos, valor >0/teto, parcelas, ciclos, URL de retorno e SSRF/redirect. SQL injection não foi encontrada: Supabase client parametriza filtros. `textContent` predomina no frontend. CORS aceita uma única origem configurada. O middleware HTTPS confia em `trust proxy=1`; configuração real do proxy não foi validada.

## 17. Checkout frontend

Estados de loading, erro, retry, expiração e método alternativo existem. Pix/boleto possuem link permanente de status. Cartão/assinatura usam popup e polling; fechar aba não é necessário para a confirmação backend.

Não há armazenamento de senha/PAN/CVV. Pagador e endereço permanecem no DOM durante a sessão. ViaCEP recebe CEP (terceiro adicional). CTAs respeitam métodos habilitados. A tela não possui representação canônica de promoção/ciclo comercial Mostraí; renderiza descrição/valores genéricos recebidos.

Achados: TOCTOU de preço entre render e criação; concorrência de duas abas/sessões popup; status público identificado por `contratanteId/pedidoId`; mensagens ainda dizem "vendedor", vocabulário aposentado do Mostraí (L-02).

## 18. Site público

Este repositório não possui site institucional separado: `/` é a própria tela de checkout. `404.html`, Termos, Privacidade, status, troca e admin existem. Headers estáticos versionados incluem política de segurança; teste ao vivo, links, console/network e responsividade não puderam ser executados porque o proxy negou o domínio. Classificação: checkout ACTIVE; legal ACTIVE por código; status ACTIVE; troca ACTIVE; admin ACTIVE; site público institucional NOT PRESENT.

## 19. Painel

Não há painel de lojista. O consumidor integra por API/webhook. Portanto transações, pagamentos, filtros, chaves, webhooks e logs por lojista não têm UI: **NOT IMPLEMENTED**, não "broken". A única consulta do consumidor é por pedido/assinatura e operações autenticadas. Se produto espera painel de merchant, isso é gap de escopo (M-09).

## 20. Admin

Admin gerencia contratantes, chaves, configuração, subcontas, métricas, auditoria de webhook e erros. Não foi encontrada UI de refund/transação detalhada ou reconciliação de callback falho. API keys são selecionadas na listagem admin e exibidas/gerenciadas; risco alto se Access/XSS falhar. Ações de arquivar/rotacionar possuem backend/UI; não foi validada confirmação visual em browser. Subconta/split é legado atualmente inativo.

## 21. Integração Mostraí

### Mostraí → Checkout (contrato real)

O Mostraí não faz um POST contendo o negócio completo. Ele fornece:

1. URL pública de checkout com `c` + `pedido` **ou** `plano` e `returnUrl` opcional;
2. endpoint autenticado `GET {api_base_url}/pedido/{pedidoId}` ou `/plano/{planoId}`;
3. resposta de pedido/plano; o Checkout confia nessa resposta server-to-server;
4. `webhook_url` para receber eventos assinados.

Pedido esperado inclui, entre outros, `descricao`, `itens`, `valorCheio`, `desconto`, `cupom`, `valorComDesconto`, `frete`, `taxaDoProjeto`, `isentarTaxa`, `status`, `expiraEm`, `pagador` e recursos visuais. Plano espera `nome`, `valor`, `ciclo`. Não há campo formal `accountId`, `promotion`, `promotionId`, preço contratado imutável ou metadata arbitrária.

| Campo conceitual solicitado | Campo real | Classificação |
|---|---|---|
| accountId | `contratanteId` identifica integração, não conta Mostraí | AMBIGUOUS/MISSING |
| plan | `planoId` opaco | PARTIAL |
| cycle | `plano.ciclo` em enum Asaas inglês | CORRECT com adaptação |
| base price | `valorCheio` em pedido; só `valor` em plano | PARTIAL |
| normal discount | `desconto`/`valorComDesconto` só pedido | PARTIAL |
| promotion | `cupom` só pedido; sem regra/id/validade | MISSING para assinatura |
| contracted price | `valorComDesconto` ou `plano.valor`, relidos na cobrança | AMBIGUOUS; não congelado |
| externalReference | `pedidoId`/`planoId`; externalReference PSP é reserva local | PARTIAL |
| metadata | sem campo genérico persistido/repassado | MISSING |
| return URL | query validada por allowlist | CORRECT |
| callback | `contratantes.webhook_url` cadastrado | CORRECT |

### Checkout → Mostraí

Pedido avulso recebe versão, `pedidoId`, `chargeId`, `status`, decomposição de preço/taxas, método e valor cobrado. É suficiente para compra, dedupe por `(chargeId,status)` e refund/chargeback total, exceto refund parcial.

Assinatura recebe apenas `versao`, `tipo`, `planoId`, `documento`, `evento`; em troca inclui plano anterior, valor, ciclo e acerto. O callback comum não inclui `subscriptionId`, `chargeId`, conta, ciclo, valor ou status financeiro. É insuficiente para reconciliar múltiplos ciclos, refunds e chargebacks sem ambiguidade.

### Independência do navegador

Arquiteturalmente **sim**: webhook Asaas atualiza Checkout e tenta chamar Mostraí mesmo se aba fechar. Operacionalmente **não garantido**: callback é memória volátil e erro interno recebe 200 para a Asaas. A independência do browser existe, mas a durabilidade server-to-server não.

### Benefícios por créditos

Não foi encontrado fluxo de cobrança zero nem conceitos de crédito administrativo Mostraí. Valores zero são recusados. A palavra "crédito" existente em `proporcionalService` significa crédito proporcional de período pago numa troca, não benefício administrativo. Portanto créditos internos do Mostraí não passam pelo Checkout no código auditado.

## 22. Compatibilidade com Essencial/Pro/Prime

| Produto | Veredito | Evidência técnica |
|---|---|---|
| Essencial | PARCIALMENTE COMPATÍVEL | `planoId` é opaco e aceita o produto; não há enum antigo bloqueando, mas identidade/preço/promoção não ficam num contrato rico |
| Pro | PARCIALMENTE COMPATÍVEL | mesma razão |
| Prime | PARCIALMENTE COMPATÍVEL | mesma razão |

Não há referências executáveis a INICIAL/BÁSICO. Logo o Checkout não rejeita nem exige nomes novos/antigos; essa neutralidade permite integração, mas também não impede o Mostraí de cobrar produto aposentado se seu endpoint o devolver.

## 23. Compatibilidade com ciclos

| Ciclo Mostraí | Ciclo real | Veredito |
|---|---|---|
| Mensal | `MONTHLY` | COMPATÍVEL |
| Trimestral | `QUARTERLY` | COMPATÍVEL |
| Semestral | `SEMIANNUALLY` | COMPATÍVEL |
| Anual | `YEARLY` | COMPATÍVEL |

Aliases `1_MONTH`, `3_MONTHS`, `6_MONTHS`, `12_MONTHS` não foram encontrados no executável. Se o Mostraí atual envia os nomes portugueses ou aliases antigos sem adaptador, recebe 400; o contrato publicado exige os valores Asaas. Além dos quatro, o Checkout aceita WEEKLY, BIWEEKLY e BIMONTHLY, que não são ciclos comerciais Mostraí.

Vereditos adicionais:

| Capacidade | Veredito |
|---|---|
| Promoções | INCOMPATÍVEL para assinatura; PARCIAL em pedido (`cupom/desconto`, sem snapshot/id/validade) |
| Webhooks | INCOMPATÍVEL para entitlement confiável de assinatura; PARCIAL para pedido |
| Troca de plano | PARCIALMENTE COMPATÍVEL; snapshot/consentimento fortes, callback final não durável |
| Renovação | INCOMPATÍVEL para reconciliação Mostraí por ausência de charge/subscription/value/cycle no evento |
| Refund | PARCIALMENTE COMPATÍVEL em pedido; INCOMPATÍVEL em assinatura e refund parcial |
| Chargeback | PARCIALMENTE COMPATÍVEL em pedido; INCOMPATÍVEL em assinatura |

Total de itens declarados INCOMPATÍVEIS/PARCIAIS no veredito: **8 capacidades transversais** (produtos agrupados como uma limitação contratual, promoções, webhook, troca, renovação, refund, chargeback e metadados/account).

## 24. Legado Mostraí ainda presente

1. "vendedor" em mensagens do checkout, embora o papel tenha sido aposentado.
2. subcontas/split/repasse manual, não usados no modelo atual e fora da função de simples camada PSP.
3. campos de nota fiscal/Drive reservados e sem fluxo ativo.
4. sete ciclos Asaas expostos, três fora do catálogo Mostraí.
5. assinatura Pix Automático implementada mas desabilitada na conta documentada.
6. comentários/defaults que ainda descrevem "MVP só Pix" ou boleto via popup apesar do código posterior.
7. compatibilidade genérica permite IDs de planos aposentados; nenhuma allowlist Essencial/Pro/Prime (o correto seria o Mostraí ser autoridade, mas o legado pode passar sem sinalização).

Não foram encontradas regras executáveis de R$50, comodato comercial, plano cortesia, INICIAL/BÁSICO ou role seller/anunciante.

## 25. Segurança

Pontos fortes: Helmet, CSP estática, HTTPS em produção, `no-store`, CORS restrito, body limit, rate limits, HMAC de callback, comparação constante, scrypt forte, SSRF/redirect guards, RLS default deny, redaction e Hosted Checkout.

Riscos: webhook usa bearer estático sem assinatura/timestamp; status transition sem monotonicidade; admin bearer acessível a JS; service key concentra autoridade; rate-limit é memória por instância e `trust proxy=1` precisa corresponder à topologia; endpoint público depende de IDs secretos; callback URL cadastrada passa guarda na criação/admin, mas configurações reais não foram auditadas.

Busca de secrets versionados encontrou somente nomes/placeholders e exemplos; nenhum valor obviamente válido foi identificado. Validade/rotação não pôde ser consultada.

## 26. Privacidade

Coleta: nome, email, CPF/CNPJ, telefone, endereço completo/CEP/cidade/UF/IBGE, itens, referências e dados financeiros não-cartão. Terceiros: Asaas, Supabase, Northflank, Cloudflare e ViaCEP. Logs Asaas removem email e sequências numéricas, mas `erro.corpoAsaas` é anexado ao objeto de erro e alguns controllers imprimem o objeto em caminhos genéricos; redaction por regex não cobre nomes/endereços curtos (M-08).

Retenção declarada: 5 anos; expurgo anonimiza cobrança e assinatura cancelada, com simulação padrão. Exportação do titular não foi encontrada. Exclusão existe por script/serviço, mas assinatura viva bloqueia anonimização. Processo de incidente é documental, não automatizado.

Termos/Privacidade afirmam boundary hospedado para cartão, coerente com o código. Não foi identificada contradição material PAN/CVV. A auditoria ao vivo de cookies/analytics não foi possível.

## 27. Infra

GitHub Actions contém CI e segurança. Dockerfile executa Node. Deploy é descrito como automático para Northflank/Cloudflare, sem IaC e sem staging. DNS/TLS/CSP/Access/variáveis efetivas não foram observáveis nesta rodada. `_headers` é a configuração versionada da borda estática; backend usa Helmet.

A ausência de remote no checkout fornecido prejudica rastreabilidade. O bloqueio de rede impede comparar SHA e configuração. Não há evidência de mistura sandbox→DB produção além da decisão explícita de operar backend publicado com Asaas sandbox; `ambiente/e_teste` mitigam métricas, não segregam banco.

## 28. Testes

A suíte é composta por autotestes de módulos e scripts Node, mais testes de contrato HTTP/mock e Playwright para acessibilidade/desempenho. Há boa cobertura de validadores, taxa, HMAC, SSRF, redirects, sessões, webhook e corridas corrigidas. Nesta máquina, 27/46 suítes passaram e 19 não chegaram à lógica testada porque o runtime disponível é Node 20.20.2; `package.json` exige Node >=22 e a versão instalada de Supabase requer WebSocket nativo. A falha foi classificada como limitação do ambiente, não regressão do código.

Limitações: dependências críticas são mocks; não existe CI com Postgres real, Asaas sandbox real ou consumidor Mostraí real; nenhuma suíte comprova migrations remotas; falta E2E do fluxo webhook→outbox→Mostraí porque outbox não existe; faltam eventos fora de ordem e concorrência de popup/customer; Playwright depende de navegador/servidor/rede. Não foram encontrados `.skip`/`TODO` significativos na suíte principal, mas números de "suítes" são scripts/autotestes, não casos isolados.

## 29. Código morto/duplicado

- `subcontas`/wallet/split: construído, atualmente não utilizável pela conta descrita.
- colunas `drive_folder_id`, `nota_fiscal_*`: reservadas, sem serviço ativo.
- Pix Automático: implementado, capability externa desligada.
- branch de fallback `payment.cycle`/`nextDueDate`: documentada como nunca observada.
- referências antigas em comentários do baseline/documentos.
- não há painel de lojista; admin não o substitui.
- não foi comprovado consumidor para todos os sete ciclos aceitos.

## 30. Contradições

1. Cabeçalho de `webhookController` afirma que "todo evento de mudança" é repassado, mas callback de assinatura reduz e omite IDs/valores; popup expirado nem sempre notifica.
2. Documentação operacional chama webhook funcional/confiável, mas handler responde 200 após erro e callback é volátil.
3. Banco chama `valor_com_desconto` preço efetivo, mas assinatura não representa desconto/promoção.
4. Front mostra preço de um primeiro *pull* e backend cobra preço de outro sem vincular versão.
5. Migração baseline comenta "MVP só Pix", enquanto servidor anuncia Pix/cartão/boleto/assinaturas.
6. "Produção" de infraestrutura está documentada usando PSP sandbox; não é mistura acidental, porém não é produção financeira.
7. `PAYMENT_PARTIALLY_REFUNDED` vira estorno integral no vocabulário local.
8. `origin/main` e deployed SHA são exigidos operacionalmente, mas esta cópia não contém remote e rede não permite prova.

## 31. CRITICAL

### C-01 — Webhook com erro recebe 200

`criarReceptorWebhook` captura qualquer falha de DB/regra, marca auditoria e sempre devolve 200. A Asaas não tem motivo para reenviar. Impacto: pagamento real confirmado sem estado local/callback/entitlement. Reproduzível injetando `atualizarStatusCobranca` que lança e observando 200.

### C-02 — preço mostrado e preço cobrado não são o mesmo snapshot

A tela resolve pedido/plano; cada POST de cobrança faz novo *pull*. Se promoção/preço muda entre os dois, o backend cobra o novo valor sem nova confirmação do pagador. Isso satisfaz exatamente "frontend mostra X, Asaas cobra Y". A troca de plano já resolve por snapshot, mas compra/assinatura não.

### C-03 — eventos fora de ordem podem regredir estado terminal

`processarEventoPayment` só ignora status idêntico; qualquer status diferente faz update direto. Um CONFIRMED atrasado após REFUNDED/CHARGEBACK ou `CASH_UNDONE` fora de ordem sobrescreve estado terminal e gera callback contraditório. Não há matriz de transições nem ordenação por timestamp/event ID.

### C-04 — dupla sessão de cartão/assinatura plausível

A sessão Asaas é criada antes de `registrarCobrancaPendentePopup`. O índice local só impede o segundo insert depois que ambas as chamadas externas podem ter criado sessões. Duas abas/double request podem gerar duas oportunidades reais de cobrança; uma fica órfã se o insert perde a corrida.

## 32. HIGH

- **H-01 INTEGRATION:** callback ao Mostraí é retry volátil em memória; reinício perde confirmação.
- **H-02 INTEGRATION:** evento de assinatura não tem `chargeId`, `subscriptionId`, valor, ciclo nem status; dedupe/reconciliação impossível.
- **H-03 PAYMENT:** refund/chargeback de acerto de troca atualiza cobrança e retorna sem notificar Mostraí; entitlement pode continuar no plano novo.
- **H-04 PAYMENT/DATA:** refund parcial é convertido em estorno total e não carrega quantia estornada.
- **H-05 PAYMENT:** `buscarOuCriarCliente` é read-then-create sem chave/unique controlável pelo Checkout; concorrência pode duplicar customer.
- **H-06 PAYMENT/DATA:** falha do DB após payment criado é apenas registrada; não existe reconciliador para completar linha órfã.
- **H-07 INFRA:** origem/main, schema remoto, deployed SHA e env efetivas não são verificáveis nesta auditoria; gate não pode assumir igualdade.
- **H-08 SECURITY:** chaves de contratante/subconta são armazenadas em claro e a listagem admin seleciona `api_key`; comprometimento do admin expõe todas.

## 33. MEDIUM

- **M-01:** token Asaas é bearer estático sem timestamp/assinatura de corpo; replay depende de status.
- **M-02:** rate limit em memória não é global entre réplicas e depende de IP/proxy corretos.
- **M-03:** não há constraint DB de valor positivo/parcelas coerentes.
- **M-04:** status `vencido`, `cancelado`, `expirado` não têm semântica Mostraí formal comum.
- **M-05:** dinheiro usa float JS, embora arredondado e persistido numeric.
- **M-06:** IDs públicos são tratados como segredo; regra de imprevisibilidade é fraca e pode expor pagador.
- **M-07:** não há UI/fila para callback falho nem botão seguro de replay.
- **M-08:** logs podem manter nome/endereço em erro não coberto por redaction regex.
- **M-09:** painel de lojista não existe, apesar da superfície esperada na auditoria.
- **M-10:** sete ciclos aceitos ampliam contrato além dos quatro Mostraí sem camada canônica.

## 34. LOW

- **L-01:** ausência de logout/revogação individual do admin.
- **L-02:** texto "vendedor" permanece na UX.
- **L-03:** comentários/defaults antigos contradizem recursos atuais.
- **L-04:** campos de nota fiscal/Drive mortos aumentam superfície do schema.
- **L-05:** MED não existe e a ausência não é exposta como capability formal.
- **L-06:** métricas não equivalem a MRR/entitlement e podem ser mal interpretadas.
- **L-07:** sem IaC, drift de Cloudflare/Northflank não é detectável pelo repo.

## 35. Test gaps

1. evento REFUNDED seguido de CONFIRMED e inverso;
2. dez webhooks concorrentes de statuses diferentes;
3. falha de Supabase no webhook deve provocar retry, não 200;
4. reinício entre callback e retry;
5. duas criações popup simultâneas;
6. customer duplicado em concorrência;
7. timeout Asaas após criação e reconciliação posterior;
8. contrato real Mostraí Essencial/Pro/Prime × quatro ciclos;
9. promoção expirando entre display/create;
10. refund parcial e chargeback de assinatura/troca;
11. migrations contra Postgres vazio e drift remoto;
12. E2E sandbox sem cobrança de produção;
13. Access/admin/TLS/CSP no domínio real;
14. secret scanning de histórico completo;
15. mobile/links/console no site publicado.

## 36. Bloqueadores para produção

**SIM.** Somente bloqueadores objetivos:

1. webhook interno pode falhar e responder 200, perdendo confirmação financeira;
2. callback financeiro ao Mostraí não é durável e não há reconciliação automática;
3. contrato de assinatura não permite dedupe/reconciliação de ciclo/refund/chargeback pelo Mostraí;
4. preço de compra não é congelado entre confirmação visual e criação da cobrança;
5. criação concorrente de pop-up pode gerar sessões duplicadas/órfãs;
6. ambiente efetivo, webhook selecionado, schema remoto e SHA implantado não foram comprovados, e o último estado documentado é Asaas sandbox.

## 37. O que está sólido

- PCI boundary: PAN/CVV fora do sistema.
- preço nunca vem do browser; servidor consumidor é autoridade comercial.
- validações de entrada, teto, piso e parcelas são extensas.
- SSRF/open redirect e callbacks HMAC têm desenho defensivo.
- Pix/boleto têm reserva local atômica; refund e troca usam CAS/lease.
- RLS default-deny e checks de vocabulário reduzem corrupção.
- logs de webhook evitam payload cru e possuem painel/auditoria.
- browser não é necessário para receber confirmação PSP.
- créditos administrativos/zero não entram no caminho financeiro.

## 38. Recomendações para a próxima rodada de correção

Ordem sugerida, sem implementar nesta auditoria:

1. tornar processamento PSP *at-least-once*: responder não-2xx em falha transitória e persistir event ID/body mínimo redigido antes do ack;
2. criar outbox persistente para Checkout→Mostraí, com chave de idempotência, estado/tentativas e replay administrativo;
3. definir máquina monotônica de transições com precedência e timestamps/event IDs;
4. reservar checkout antes de `/v3/checkouts` e reconciliar sessão criada em timeout/falha de DB;
5. versionar/congelar o quote aceito pelo pagador; rejeitar mudança e pedir reconfirmação;
6. publicar contrato de assinatura financeiro com `eventId`, `chargeId`, `subscriptionId`, account/reference, plano/ciclo, valor/status/refund amount;
7. representar promoção como snapshot fornecido pelo Mostraí, sem recalcular regra comercial;
8. separar refund parcial e eventos de troca/renovação;
9. reduzir exposição de API keys no admin, criptografar segredo em repouso ou adotar referência a secret manager;
10. executar matriz E2E Mostraí×Checkout em sandbox e somente depois provar SHA/env/webhook/schema em produção.

## Resumo estruturado dos achados

| ID | SEVERIDADE | CATEGORIA | COMPONENTE | ACHADO | EVIDÊNCIA | IMPACTO | REPRODUZÍVEL? | CORREÇÃO SUGERIDA |
|---|---|---|---|---|---|---|---|---|
| C-01 | CRITICAL | PAYMENT/INTEGRATION | webhook inbound | erro vira 200 | `webhookController.js`, `criarReceptorWebhook`, catch + resposta 200 | confirmação perdida | Sim, dependência que lança | ack somente após persistir/processar; retry |
| C-02 | CRITICAL | PAYMENT/FRONTEND | preço | dois pulls sem quote | `pedidoController`, creators de checkout | cobra Y após mostrar X | Sim, alterar resposta entre chamadas | quote versionado/congelado |
| C-03 | CRITICAL | PAYMENT/DATA | status | update sem precedência | `processarEventoPayment` | entitlement reativado após refund | Sim, eventos reordenados | máquina monotônica/CAS |
| C-04 | CRITICAL | PAYMENT | popup | Asaas antes do insert único | `criarCheckoutCartao/Assinatura` | dupla cobrança/sessão órfã | Sim, chamadas concorrentes | reserva antes da chamada |
| H-01 | HIGH | INTEGRATION | callback | retry em memória | `ATRASOS_RETRY_MS`, `setTimeout().unref()` | Mostraí nunca recebe | Sim, restart | outbox persistente |
| H-02 | HIGH | INTEGRATION | assinatura | payload sem IDs financeiros | `notificarConformeMetodo` | sem dedupe/reconciliação | Sim | ampliar evento versionado |
| H-03 | HIGH | PAYMENT | troca | refund do acerto não notifica | guarda `METODO_ACERTO_TROCA` | plano pago/refund divergente | Sim | evento de reversão da troca |
| H-04 | HIGH | PAYMENT/DATA | refund | parcial vira total | arrays/map de webhook | revogação incorreta | Sim | status/amount parcial |
| H-05 | HIGH | PAYMENT | customer | read-then-create | `buscarOuCriarCliente` | duplicidade PSP | Conceitualmente | idempotência/serialização |
| H-06 | HIGH | PAYMENT/DATA | Pix/boleto | DB pode falhar após PSP | `completarCobranca` engole erro | órfão e callback perdido | Sim | fila/reconciliador |
| H-07 | HIGH | INFRA | deploy | SHA/env/schema não comprovados | sem remote + proxy 403 | código auditado pode diferir | Não nesta rede | prova automatizada de deploy |
| H-08 | HIGH | SECURITY | secrets | API keys em claro/listagem | baseline + admin select | comprometimento em cascata | Sim com admin | vault/envelope + mascaramento |
| M-01 | MEDIUM | SECURITY | webhook | bearer sem assinatura/replay ID | middleware do token | replay/segredo único | Sim | assinatura/event ID |
| M-02 | MEDIUM | SECURITY/INFRA | rate limit | memória/local IP | `express-rate-limit` default | bypass multi-réplica | Depende infra | store distribuída |
| M-03 | MEDIUM | DATA | banco | valores sem checks | migrations | corrupção por bug/service role | Sim SQL | constraints |
| M-04 | MEDIUM | INTEGRATION | status | semântica incompleta | mapa/status callback | Mostraí decide errado | Sim | contrato canônico |
| M-05 | MEDIUM | PAYMENT | cálculo | float JS | `Number` + arredondar | centavo divergente | Casos limite | integer cents/decimal |
| M-06 | MEDIUM | SECURITY/PRIVACY | pedido público | ID como segredo | `exigirIdImprevisivel` | IDOR/PII | Sim com ID previsível | token opaco assinado |
| M-07 | MEDIUM | UX/INTEGRATION | admin | sem replay callback | rotas/admin | recuperação manual difícil | Sim | fila/UI replay |
| M-08 | MEDIUM | PRIVACY | logs | redaction incompleta | `resumirRespostaAsaas` | PII em log | Sim com texto não numérico | redactor estruturado |
| M-09 | MEDIUM | FRONTEND | painel lojista | inexistente | `public/`/routes | operação sem self-service | Sim | decidir escopo/implementar |
| M-10 | MEDIUM | LEGACY/INTEGRATION | ciclos | aceita 3 extras | `CICLOS_VALIDOS` | contrato amplo/ambíguo | Sim | adapter/allowlist por consumidor |
| L-01 | LOW | SECURITY | admin | sem revogação individual | `sessaoAdmin.js` | token roubado vale 8 h | Sim | session store/revocation |
| L-02 | LOW | LEGACY/UX | textos | "vendedor" | validadores/frontend | vocabulário aposentado | Sim | revisar copy |
| L-03 | LOW | LEGACY | docs internos | comentários antigos | baseline/cabeçalhos | manutenção confusa | Sim | atualizar documentação |
| L-04 | LOW | LEGACY/DATA | schema | NF/Drive mortos | migration 0001 | superfície extra | Sim | planejar depreciação |
| L-05 | LOW | PAYMENT | Pix | MED ausente | nenhuma implementação | expectativa indevida | Sim | capability/documentar |
| L-06 | LOW | DATA | métricas | não é MRR | `metricaService` | leitura gerencial errada | Sim | rotular claramente |
| L-07 | LOW | INFRA | deploy | sem IaC | repo | drift | Sim | IaC/export de config |

## Gate de produção

**Há algum bloqueador objetivo para produção financeira hoje? SIM.**

Bloqueadores: C-01, C-02, C-03, C-04, H-01/H-02 combinados e ausência de prova atual de SHA/env/schema/webhook. Não são bloqueadores "por perfeccionismo": todos podem causar cobrança duplicada/incorreta ou pagamento correto sem entitlement/revogação correspondente.

## Encerramento

- Arquivo criado: `docs/CODEX_CHECKOUT_AUDIT_2026-09-24.md`.
- HEAD: `f7b1cb9bf64383cb9a1f698ec0e5deac80fe2022` antes do commit desta auditoria.
- origin/main: não disponível nesta cópia; consulta externa bloqueada por proxy 403.
- deployed SHA: não verificável nesta rodada.
- Testes executados: `npm test` (27/46 passaram; 19 falharam porque o ambiente fornece Node 20.20.2 e o projeto exige Node >=22/WebSocket nativo), `node scripts/checar.mjs` (100 arquivos, zero erro de sintaxe), `git diff --check` e busca estática de padrões de segredo (sem ocorrência). `npm run check` não foi repetido porque seu segundo estágio é o mesmo `npm test` já diagnosticado.
- Achados: **4 CRITICAL, 8 HIGH, 10 MEDIUM, 7 LOW**.
- Incompatibilidades/parcialidades Mostraí: **8 capacidades transversais**.
- Legados relevantes: **7**.
- Bloqueadores de produção: **6 grupos objetivos** listados em §36.
