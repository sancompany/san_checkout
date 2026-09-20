# Backlog

Fonte completa e detalhada: `docs/pendencias.md` (o que bloqueia a
esteira e o que está aberto sem bloquear, com evidência de cada item) e
`docs/proximas-versoes.md` (o que foi cortado para depois, com o
"por quê" preservado). Este documento **resume por categoria** — ao
resolver ou descobrir algo, atualize os dois lugares: o detalhe lá, o
resumo aqui.

## NOW

- [ ] **Preencher `.ia/HANDOFF.md`** ao final desta tarefa (infraestrutura
  multi-agente) — critério de conclusão: próximo agente consegue
  retomar sem reconstituir contexto pelo chat.

## NEXT

- [ ] **Troca da Asaas de sandbox para produção real** — objetivo:
  cobrança real passa a acontecer. Estado: exceção registrada com
  gatilho, aguardando o dono e o MostrAí baterem ponto de equilíbrio.
  Arquivos: `RUNBOOK.md` §6.2 (procedimento completo). Serviço:
  Northflank (3 variáveis) + Asaas (webhook de produção). Dependência:
  decisão do dono. Critério de conclusão: as 5 conferências da §6.2
  passo 5 batem, `ASAAS_AMBIENTE=producao` confirmado.
- [ ] **Tratamento em código dos eventos `SUBSCRIPTION_*`** — objetivo:
  assinatura cancelada/alterada direto no painel da Asaas chega por
  webhook, não só por conciliação pull. Estado: grupo marcado no painel
  (18/09), zero payload real recebido ainda. Arquivo:
  `src/controllers/webhookController.js`. Dependência: primeiro payload
  real (que só existe depois da troca para produção, acima). Critério
  de conclusão: `classificarEvento` trata cada evento do grupo contra
  payload medido, nunca imaginado.
- [ ] **Rotação de `ASAAS_WEBHOOK_TOKEN` sem janela de risco** — objetivo:
  trocar o token sem 503 temporário. Estado: declarado, não construído
  (aceitar dois tokens durante a virada resolveria). Arquivo: receptor
  do webhook (`webhookController.js`/validação de token). Dependência:
  nenhuma técnica — decisão de fazer antes ou durante a troca de
  produção. Critério de conclusão: teste de sabotagem trocando um token
  por vez sem gerar rejeição.

## LATER

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
- [ ] Itens de `docs/proximas-versoes.md` não puxados para cá
  individualmente — cobrem principalmente eventos de webhook adicionais
  (funil de checkout, aprovação por antifraude, split) e canal de alerta
  via "Fairy" (produto externo ao ecossistema, fora do escopo deste
  repositório).

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
