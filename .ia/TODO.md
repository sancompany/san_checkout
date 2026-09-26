# Backlog

Fonte completa e detalhada: `docs/pendencias.md` (o que bloqueia a
esteira e o que está aberto sem bloquear, com evidência de cada item) e
`docs/proximas-versoes.md` (o que foi cortado para depois, com o
"por quê" preservado). Este documento **resume por categoria** — ao
resolver ou descobrir algo, atualize os dois lugares: o detalhe lá, o
resumo aqui.

## SAN CHECKOUT V1 = ENCERRADO (26/09/2026)

**Não há nada em andamento, e nada neste arquivo autoriza trabalho sem
pedido do dono.** A V1 só reabre por bug real, nova necessidade de
negócio, alteração regulatória relevante, formalização ou início da V2
(`HANDOFF.md`).

## NOW

Nada.

- [x] Preencher `.ia/HANDOFF.md` — feito, e reescrito no encerramento da
  V1 (26/09/2026).
- [x] Troca da Asaas de sandbox para produção real — feita em
  25/09/2026, e homologada com pagamento real em 26/09/2026
  (`CONSTRAINTS.md` §3, "Estação 5").
- [x] Trocar de plano redireciona o pagador ao Checkout — no ar desde
  21/09/2026. Em assinatura de cartão, a troca de valor é recusada desde
  26/09/2026 (ADR-011).

## POST_V1_HARDENING

Melhorias técnicas conhecidas. Não bloqueiam e não reabrem a V1.

- [ ] **Expurgo de `intencoes_troca_plano`.** O prazo foi decidido em
  26/09/2026: 90 dias depois de vencer sem cobrança, 5 anos com
  cobrança. A tabela tem 0 linhas (`docs/inventario-de-dados.md` §1.3).
- [ ] **`clientes_asaas` no expurgo**, pelo prazo e a pedido do titular,
  com HMAC opcional (`docs/inventario-de-dados.md` §6.3).
- [ ] **Tratamento em código dos eventos `SUBSCRIPTION_*`.** Os primeiros
  payloads reais chegaram em 25–26/09. O tratamento espera o próximo
  ciclo pago real, para ser escrito contra payload medido e nunca
  imaginado. Arquivo: `src/controllers/webhookController.js`.
- [ ] **Rotação de `ASAAS_WEBHOOK_TOKEN` sem janela de risco.** Aceitar
  dois tokens durante a virada resolveria. Critério de conclusão: teste
  de sabotagem trocando um token por vez sem gerar rejeição.

## OWNER_DECISION / OWNER_MANUAL_TESTS / EXTERNAL_VALIDATIONS

Ver `HANDOFF.md`, "O que ficou". São do dono ou de profissionais de
fora.

## V2 — só com decisão formal do dono

Lojista de outro titular, split, subconta real, multiempresa e a
revisão regulatória que eles exigem (`CONSTRAINTS.md` §1.12). Abre na
Estação 1. Não se antecipa em patches sobre a V1.

## LATER — POST_V1 (não bloqueia; só com pedido do dono)

- [ ] **Medir a recusa síncrona de cartão contra o sandbox** — o
  classificador financeiro (`classificacaoFinanceiraService.js`) nunca
  deriva `DECLINED_FINAL` de status síncrono sozinho, por não haver
  medição ao vivo do que a Asaas devolve num cartão de teste recusado
  (a doc pública não lista um status `REFUSED`). O desenho já é
  conservador o bastante para não bloquear nisso; medir só relaxaria a
  regra se confirmado seguro.
- [ ] **Medir CLS de `/troca` com token real** — `npm run desempenho`
  só cobre o caminho sem token (esqueleto→erro) da tela de aprovação;
  o estado "resumo pendente" (o mais alto, com o botão Aprovar)
  exigiria um token de teste de verdade contra um backend de verdade.
- [ ] **Contador de rate limit por credencial (`X-Checkout-Key`)**, não só
  por IP — declarado em `CONSTRAINTS.md` §2.7 e `docs/proximas-versoes.md`,
  esperando evidência de tentativa real no log de rejeição antes de
  construir.
- [ ] **Ticket de atendimento com auto-resposta** para os canais
  `juridico@`/`suporte@` — hoje é caixa de entrada simples. Vale a pena
  quando o volume justificar (`docs/funcional.md` §8).
- [ ] **Quatro padrões de UI repetidos em `public/js/`** (polling+pop-up
  de pagamento, polling de cobrança, copiar-com-fallback, toast) —
  declarado por risco/escopo no ciclo de revisão de 18/09, não
  simplificado ainda. Arquivos: `public/js/modules/*Handler.js`.
- [ ] Demais itens de `docs/proximas-versoes.md` não puxados para cá
  individualmente — cobrem principalmente eventos de webhook adicionais
  (funil de checkout, aprovação por antifraude, split) e canal de alerta
  via "Fairy" (produto externo, fora do escopo deste repositório).

## PLUGIN / CONTROL PLANE

Detalhe completo do "porquê" de cada item em `.ia/CONTROL_PLANE.md`,
seção "Roadmap" — resumido aqui como itens de backlog:

- [ ] **Formalizar `.ia/HANDOFF.md` como parte do próprio plugin** —
  hoje é convenção deste repositório, não exigência do plugin `san-co`.
  Critério de conclusão: a skill `leis` recusa "fechar estação" sem
  handoff atualizado.
- [ ] **Separar estado estruturado de narrativa histórica** — hoje
  ambos vivem misturados em `CLAUDE.md` (raiz), o que já causou três
  contradições internas registradas (`docs/erros/`). Critério: um
  campo/arquivo de estado que não pode contradizer a si mesmo por
  construção.
- [ ] **Índice de skills consultável como dado** (não só prosa) —
  permite a um agente sem o plugin (Codex, Jules) saber que a
  metodologia existe e onde ler o equivalente em texto plano.
- [ ] **Task tracking compartilhado com critério de conclusão
  verificável**, ligando `TODO.md`/`docs/pendencias.md` a um formato
  que os três agentes leiam/escrevam sem conflito.
- [ ] **Verificação automática de conformidade** — CI ou script que
  confira, por exemplo, que todo commit no caminho do dinheiro tem
  teste associado, sem depender só de disciplina do agente.

Nenhum desses itens é para implementar como parte desta tarefa — são o
backlog explícito da tarefa futura "transformar este plugin no sistema
central de coordenação entre Claude Code, Codex e Jules".

## INFRASTRUCTURE

- [ ] **Cópia de backup periódica fora do provedor** — hoje só existe
  ensaio de restauração (RTO ~1s) contra o próprio Supabase; a "cópia"
  hoje é a Asaas ter o dado de cobrança também. Decisão do dono
  (17/09/2026): atualização futura. Critério de conclusão: definido
  quando o dono retomar.
- [ ] **Confirmar propósito do check "Supabase Preview" nas PRs** —
  aparece como `skipped`; não confirmado nesta auditoria se é
  integração ativa mal configurada ou vestígio. Achado nesta auditoria,
  não crítico. Ver `RISKS.md`.
- [ ] **Confirmar nome/configuração exata do projeto Cloudflare Pages**
  via API — feito só por inferência (CNAME + check de CI) nesta
  auditoria.

## SECURITY

- [ ] **Cloudflare: migrar de Global API Key para token escopado**,
  quando uma tarefa tocar essa configuração — registrado como melhoria
  em `CONSTRAINTS.md` §3 e `.ia/DECISIONS.md` (ADR-007). Não quebrar a
  integração existente só para isso fora de uma tarefa dedicada.
- [ ] **Teste da "pessoa número dois"** com o `RUNBOOK.md` (alguém sem
  contexto, com credencial, publicando e revertendo de verdade) — a
  metade sem credencial já rodou (agente sem contexto, 17/09); a metade
  com credencial depende de existir uma segunda pessoa. Virou
  atualização futura por decisão do dono (18/09).
- [ ] **Latência do painel administrativo** depende do plano gratuito
  do Supabase (50–270ms por ida ao banco) — decisão de custo pendente,
  não bug.

## TECHNICAL DEBT

- [ ] **Divergência de nomenclatura entre `list_migrations` do Supabase
  e os arquivos locais em `supabase/migrations/`** — achado nesta
  auditoria (20/09/2026), sem dano ativo (schema confirmado correto por
  coluna real). Ver `RISKS.md` e `runbooks/supabase.md`. Critério de
  conclusão: entender por que o histórico remoto não cita "0009" e tem
  duas entradas "0010" — provavelmente artefato de como a migration foi
  aplicada (CLI vs. painel vs. squash), não um problema de schema.
- [ ] `INTEGRACAO.md` (raiz) é só redirecionamento para `API.md` — mantido
  de propósito (comentários no código ainda citam "INTEGRACAO.md seção
  X"). Não remover sem atualizar essas citações primeiro.
