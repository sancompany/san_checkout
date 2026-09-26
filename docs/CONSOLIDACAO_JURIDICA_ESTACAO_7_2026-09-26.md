# Consolidação jurídica da Estação 7 — 26/09/2026

**Não é parecer jurídico.** É a conferência dos documentos legais
contra o sistema real, com as fontes usadas, para a revisão externa ser
curta. Os pontos que dependem de advogado, contador ou do regulador
estão marcados como tal, e não foram concluídos aqui.

## 1. O que mudou

| Documento | Antes | Depois | Cópia exata do anterior |
|---|---|---|---|
| Termos de Uso | v2 (17/09/2026) | **v3 (26/09/2026)** | `docs/legal-arquivado/termos-v2-pf-transicao-2026-09.html` |
| Política de Privacidade | v3 (17/09/2026) | **v4 (26/09/2026)** | `docs/legal-arquivado/privacidade-v3-pf-transicao-2026-09.html` |
| Inventário de dados | 11/09/2026 | **26/09/2026**, conferido campo a campo | versão anterior no git |

As versões arquivadas antigas (`termos-v1-cnpj`, `privacidade-v1-cnpj`,
`privacidade-v2-render`) **não foram tocadas**. O `README.md` da pasta
ganhou as linhas novas e a nota de que o CNPJ da v1 não representa a
operação vigente.

Também foram corrigidos, por dependerem do mesmo fato: `API.md` §2.0 e
§8, `CONSTRAINTS.md` (retenção, "sem split" e Lei 10), `RUNBOOK.md`
§1.1, §8.1 e §9, `docs/funcional.md` §8, `.ia/DECISIONS.md` ADR-006,
`docs/legal-arquivado/README.md` e a referência `termos.html §13 → §14`
em `public/status.html`, que é comentário HTML.

## 2. Divergências achadas entre documento e sistema

Cada uma foi conferida no código, no banco de produção (só leitura) ou
nos cabeçalhos servidos em produção.

| # | O que o documento dizia | O que o sistema faz | Onde se confere | Tratamento |
|---|---|---|---|---|
| D1 | Termos §8: o split divide a cobrança e evita que a SAN & CO. retenha dinheiro de terceiro | **não há split**: 100% cai na conta PF do operador, e o repasse é manual | `CONSTRAINTS.md` §3; `contratantes.wallet_id` nulo em todas as linhas | Termos v3 §9 reescrita, com a ressalva regulatória mantida. **REGULATORY_VALIDATION_REQUIRED** (§4) |
| D2 | "em transição para pessoa jurídica" | não há transição em curso (decisão do dono) | — | retirado dos vigentes; texto neutro no lugar |
| D3 | nenhum documento citava o **Google Fonts** | as 6 páginas carregam `fonts.googleapis.com`, que recebe o IP de todo visitante | `grep fonts.googleapis public/*.html`; CSP em `public/_headers` | Política v4 §15.11, §17, §18 |
| D4 | nenhum documento citava o **ViaCEP** | o navegador consulta `viacep.com.br` com o CEP no cartão e na assinatura por cartão | `public/js/utils/cep.js`; `connect-src` da CSP | Política v4 §15.12, §17, §18 |
| D5 | inventário: `clientes_asaas` guarda hash "irreversível" | SHA-256 **sem sal** de CPF, que se reverte por enumeração | `asaasService.js`, `createHash('sha256').update(documento)` | inventário §5.2 corrigido: dado pseudonimizado |
| D6 | inventário: `clientes_asaas` "entra no expurgo por titular" | não entra em rotina nenhuma | `expurgoService.js` só lê `cobrancas` e `assinaturas` | **LEGAL_REQUIRES_TECH_CHANGE**, inventário §6.3 |
| D7 | Política v3 §9: "prevenção à fraude" e "proteção do crédito" como bases genéricas | a base de prevenção à fraude do art. 11, II, g, só vale para dado **sensível**, que o checkout não trata; e não há proteção do crédito | LGPD arts. 7º e 11 | Política v4 §9: bases por finalidade; fraude em legítimo interesse |
| D8 | Política v3 §15.7: cookies "de sessão e de controle de acesso administrativo" | as páginas do Pagador não gravam cookie (medido); só o Access grava, no `/admin`; a sessão do painel fica em `sessionStorage` | `curl -D -` nas páginas de produção | Política v4 §15.7 |
| D9 | Termos §11.2 e Política §7: o checkout considera "dados de dispositivo" e faz análise antifraude | o checkout só limita frequência por IP, em memória, e registra IP de tentativa inválida no webhook; a análise de risco é da Asaas | `limitadores.js`, `webhook_rejeicoes` | Termos v3 §12.2; Política v4 §7.2 e §7.3 |
| D10 | Termos §10.2: o webhook leva "CPF/CNPJ associado à transação" | o do pedido avulso **não** leva documento; só o de assinatura | `API.md` §4.3.3 e §4.3.4 | Termos v3 §11.2; Política v4 §12.2 |
| D11 | Termos §15.1: a NFS-e "é emitida" | nenhum código emite nota; as colunas `nota_fiscal_*` são resto da baseline, recurso removido em 08/09 | `grep nota_fiscal src/` só acha a lista branca do expurgo | Termos v3 §16 sem afirmar emissão. **ACCOUNTING_VALIDATION_REQUIRED** |
| D12 | Política §20.3: registro de acesso "eventualmente sujeito" ao art. 15 do Marco Civil | o art. 15 é para pessoa jurídica; o sistema não grava IP de Pagador | Lei 12.965/2014, art. 15 | Política v4 §20.3 |
| D13 | RUNBOOK §8.1: o prazo em dobro "não se aplica" porque pequeno porte seria só ME/EPP/startup | a Res. CD/ANPD 2/2022, art. 2º, I, inclui **pessoas naturais** | fonte oficial | corrigido, mantendo o alvo de 3 dias úteis |
| D14 | RUNBOOK §8.1: "ANPD e titulares, o mesmo conteúdo" | são duas listas diferentes (art. 6º §2º e art. 9º), e falta a declaração do art. 9º §4º | Res. 15/2024 | corrigido |
| D15 | Política v3 §5.4: não há "mecanismo de cobrança futura baseado em cartão previamente armazenado" | o código tem `cobrarNoCartaoSalvo()` com o token da Asaas, **inalcançável** desde a RN-35.4 (409 antes de qualquer efeito) | `trocaPlanoController.js`, guarda `troca_de_valor_nao_suportada` | Política v4 §5.4 descreve o estado atual ("nesta versão") |
| D16 | Termos: sem nada sobre assinatura | assinatura com ciclo, pausa, retomada, troca de cartão, troca de plano recusada no cartão | `API.md` §5.5, §5.6, §7 | Termos v3 §7 nova |

## 3. Matriz de consistência

`MATCH` quer dizer que os documentos e o código dizem a mesma coisa, e
foi conferido. `PENDING_EXTERNAL_VALIDATION` quer dizer que o texto
descreve o sistema real, mas a conclusão jurídica, contábil ou
regulatória depende de alguém de fora.

| Assunto | Termos v3 | Política v4 | Inventário | Código / produção | Status |
|---|---|---|---|---|---|
| Identificação | §1.1, §1.1.1 | quadro de contatos | §4.1 | rodapés com CPF, trava em `tests/rodape-nao-cita-identidade-antiga.js` | MATCH |
| Asaas | §4, §7.3–7.5 | §11 | §5 | `asaasService.js`, `notificationDisabled: true` | MATCH |
| Pix | §5 | §6 | §1.1 | `criarCobrancaPix` | MATCH |
| Cartão | §6, §7.4 | §5 | §1.1 | cartão só na pop-up da Asaas; token nunca gravado | MATCH |
| Boleto | §14.3 | §11.2 | §1.1 | `billingType: 'BOLETO'`; estorno negado tratado (`estorno_negado`) | MATCH |
| Assinatura | §7 | §4.1, §12.2, §20.4 c | §1.2 | `API.md` §7; ciclos em `CICLOS_VALIDOS` | MATCH |
| Troca de plano | §7.9 | §4.1 | §1.3 | 409 para cartão (RN-35.4); aprovação em `/troca` para outro meio (RN-35.2) | MATCH |
| Promoção / preço | §7.10, §8.3 | — | — | `desconto` só no avulso; assinatura cobra o `valor` do plano (`API.md` §7.6) | MATCH |
| Estorno | §14 | — | §5.3 | `POST /estornar`, integral ou parcial, pela chave do Lojista | MATCH |
| Chargeback | §15 | §9.1 c | — | fora do código; registros fornecidos a pedido | MATCH |
| Split / fluxo financeiro | §9 | — | §1.4 | sem `wallet_id`; tudo na conta do operador | PENDING_EXTERNAL_VALIDATION (regulatório) |
| Webhook | §11 | §12 | §5 | payloads do `API.md` §4.3.3 e §4.3.4 | MATCH |
| Dados | — | §4, §13 | §1 | colunas de produção conferidas em 26/09 | MATCH |
| Retenção | — | §20 | §6.0 | `expurgoService`, `expurgarOutbox`, `expurgarInbox`, `expurgarAuditoria`, `expurgarErros`, `expurgarCotacoes` | PENDING_EXTERNAL_VALIDATION (contagem fiscal; `clientes_asaas` e intenções sem rotina) |
| Cloudflare | — | §15.4–15.9, §17, §18 | §5 | Pages, DNS, Access, Web Analytics; cookies só no `/admin` | MATCH |
| Northflank | — | §15.1–15.3, §17 | §5 | `nf-southamerica-east`, conferido pela CLI | MATCH |
| Supabase | — | §13, §17 | §5 | `sa-east-1`; RLS nas 13 tabelas; 0020 aplicada | MATCH |
| Google (Workspace e Fonts) | — | §15.11, §16, §17, §18 | §5 | MX `smtp.google.com`; nenhum envio de e-mail no código; fontes em todas as páginas | MATCH |
| NFS-e | §16 | §14 | §5.4 | nenhuma emissão no código | PENDING_EXTERNAL_VALIDATION (contábil) |
| LGPD (bases e direitos) | — | §9, §23, §24, §25 | §1 | canal `juridico@`; expurgo a pedido | MATCH |
| Incidentes | — | §22 | §6.0 | `RUNBOOK` §8.1 reescrito a partir da fonte | MATCH |
| Aceite | §1.3 | — | §8 | caixa no checkout, **sem gravação**; nenhum documento afirma aceite gravado | MATCH |

## 4. O que não foi concluído, e por quê

**LEGAL_BLOCKER: nenhum para publicar os documentos.** Eles descrevem o
sistema como ele é, e ficam mais verdadeiros que os atuais. O que segue
é o que um especialista precisa responder.

**REGULATORY_VALIDATION_REQUIRED — fluxo sem split.** Todo o dinheiro
passa pela conta PF do operador, e o repasse ao Lojista é manual. Pode
caracterizar atividade de pagamento regulada (Lei 12.865/2013 e normas
do Banco Central), e as condições da conta Asaas podem restringir o
recebimento por conta de terceiro. Os Termos não concluem nada sobre
isso (§9.3). Enquanto o único Lojista for projeto do próprio dono, o
dinheiro não é de terceiro. **Isso passa a ser bloqueio antes de
receber para um Lojista de outro titular**: é preciso parecer
regulatório ou o split ligado.

**ACCOUNTING_VALIDATION_REQUIRED — duas perguntas ao contador.**

1. A SAN & CO., como pessoa física em Matão/SP, precisa emitir documento
   fiscal pela taxa do checkout, e como (NFS-e municipal ou Nacional)?
   O tomador é o Lojista ou o Pagador, que é quem paga a taxa somada ao
   total? Os Termos (§16) e a Política (§14) ficaram sem afirmar emissão.
2. A guarda fiscal que conta do primeiro dia do exercício seguinte (CTN,
   art. 173, I) exige manter o documento do Pagador por mais que 5 anos
   da transação? Se sim, muda `dataDeCorte()` em `expurgoService.js`.

**PENDING_EXTERNAL_VALIDATION — advogado.**

1. Se as ressalvas de responsabilidade dos Termos (§3.4, §15.4, §21)
   bastam diante da responsabilidade solidária da cadeia de fornecimento
   no CDC (arts. 7º, parágrafo único, 25 e 51, III).
2. Se e-mail, telefone e endereço podem ter prazo menor que 5 anos
   (minimização). A mudança seria uma segunda faixa no
   `expurgoService.js`.
3. Se o autoenquadramento como agente de pequeno porte (Res. 2/2022) se
   sustenta, para o prazo em dobro. O `RUNBOOK` continua no prazo curto.

**LEGAL_REQUIRES_TECH_CHANGE = TRUE — três mudanças, nenhuma feita aqui**
(a tarefa proibia mudar o comportamento do Checkout):

| Mudança | Onde | Urgência |
|---|---|---|
| Expurgo de `intencoes_troca_plano`: 90 dias depois de vencer sem cobrança; 5 anos com cobrança; nunca em estado não terminal | nova função no ciclo de `rodarExpurgoDasFilas`, `server.js` | antes de a troca voltar a valer para algum meio; hoje a tabela tem 0 linhas |
| `clientes_asaas` no expurgo, no prazo e no pedido do titular; opcionalmente HMAC no lugar do SHA-256 puro | `expurgoService.js` | média: a tabela já tem linhas, e o pedido do titular hoje depende de apagar à mão |
| Rotina para `subcontas` | `expurgoService.js` | quando a tabela entrar em uso; hoje tem 0 linhas |

**Não feito, e que só o dono decide:** gravar o aceite (versão e hash
do texto) na cobrança. Hoje o sistema prova qual versão estava vigente
na data da transação, não que o Pagador marcou a caixa.

## 5. Fontes

Consultadas em 26/09/2026.

| Assunto | Fonte |
|---|---|
| Bases legais, art. 16, art. 18, art. 19, art. 20, art. 48 | Lei 13.709/2018 (LGPD), texto compilado no Planalto: `planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm` |
| Prazos e conteúdo da comunicação de incidente, registro por 5 anos | Resolução CD/ANPD nº 15/2024, na biblioteca digital do Ministério da Justiça: `bibliotecadigital.mj.gov.br/bitstream/1/12879/2/RES_ANPD_2024_15.html` |
| Pequeno porte, pessoa natural, alto risco, prazo em dobro, canal no lugar de encarregado | Resolução CD/ANPD nº 2/2022, portal da ANPD: `gov.br/anpd/pt-br/documentos-e-publicacoes/regulamentacoes-da-anpd/resolucao-cd-anpd-no-2-de-27-de-janeiro-de-2022` |
| Identificação por CPF ou CNPJ | Decreto 7.962/2013, art. 2º, Planalto |
| Registro de acesso só para pessoa jurídica | Lei 12.965/2014 (Marco Civil), art. 15, Planalto |
| Arrependimento, foro do consumidor, cláusulas nulas | Lei 8.078/1990 (CDC), arts. 49, 51 e 101, Planalto |
| MED: fraude e falha operacional | Banco Central, Guia de implementação do MED (`bcb.gov.br/content/estabilidadefinanceira/pix/Guia_MED.pdf`) e FAQ de participantes do Pix; Regulamento do Pix (Resolução BCB nº 1/2020) |
| Web Analytics sem cookie, sem *fingerprinting*, sem rastreamento entre sites | `cloudflare.com/web-analytics/` e `developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/` |
| Web Analytics: 7 dias integrais, depois agregado; *query string* não registrada | `developers.cloudflare.com/web-analytics/faq/` |
| Google Fonts sem cookie, sem perfil, sem publicidade; recebe IP, agente e página de origem | FAQ de privacidade do Google Fonts: `developers.google.com/fonts/faq/privacy` |
| Região do banco | API do Supabase (`get_project`): `sa-east-1` |
| Região da aplicação | CLI do Northflank (`get project`): `nf-southamerica-east` |
| Caixas postais | DNS MX de `sancocore.com.br`: `smtp.google.com` |
