# Estado do projeto — verificável

Este documento registra o estado no momento da última atualização
**e como reconfirmar cada afirmação**. Nunca confie num número aqui sem
rodar o comando ao lado quando a informação for crítica para a sua
tarefa — estado de infra envelhece rápido, o comando não.

**Última atualização**: 26/09/2026, no encerramento da V1. Os fatos
abaixo foram conferidos entre 25 e 26/09/2026, salvo quando outra data
aparece.

## Estado: SAN CHECKOUT V1 = ENCERRADO (26/09/2026)

É a infraestrutura interna de checkout e pagamento dos **projetos
próprios** do operador, e não uma plataforma para lojistas externos
(`CONSTRAINTS.md` §1.12). As estações 1 a 7 estão fechadas, sem trabalho
em andamento. A V2 só abre por decisão formal do dono. O resumo está em
`HANDOFF.md`.

## Versão e branch

- Branch de trabalho no momento desta auditoria: `claude/nifty-meitner-4ffp9s`.
- Branch principal / produção: `main`.
- Reconfirmar: `git branch --show-current` e `git log origin/main -1 --oneline`.

## Ambiente de produção

- **Único ambiente real** — não há staging separado. Todo merge na
  `main` publica.
- Backend: Northflank, projeto `san-checkout`, serviço `san-checkout`.
  Reconfirmar SHA servido: ver comando em `OPERATIONS.md`, "Verificar
  deploy efetivo".
- Front: Cloudflare Pages, domínio `checkout.sancocore.com.br`.
- API: `api.sancocore.com.br` (DNS-only, sem proxy Cloudflare).
- Banco: Supabase `San_Checkout` (`zacuaroarelaqnzjjlcz`, `sa-east-1`),
  `ACTIVE_HEALTHY` na verificação desta auditoria.
- Saúde: `curl -sS https://api.sancocore.com.br/api/saude`, que deve
  responder `200` com `workersAtrasados: []`.
- Health check do Northflank: readiness TCP na porta 3001, sem liveness
  (`RUNBOOK.md` §6.3).

## Ambiente de staging

**Não existe.** Reconfirmar: nenhuma referência a segundo serviço
Northflank, segundo domínio de app ou segunda branch de deploy
encontrada nesta auditoria.

## Pagamento — produção real

Desde 25/09/2026, com `ASAAS_AMBIENTE=producao`, conferido dentro do
contêiner. A homologação real de 26/09/2026 passou por Pix, cartão
avulso, boleto e assinatura, e a exceção do sandbox fechou
(`CONSTRAINTS.md` §3, "Estação 5"). O webhook de produção está em
`/api/webhooks/asaas`, no plural.

## Componentes — o que está implementado

| Componente | Estado | Evidência |
|---|---|---|
| Pagamento avulso (Pix, boleto, cartão até 12x) | ✅ funcional, testado ao vivo | `docs/erros/2026-09-18-descricao-do-contratante-sem-teto-quebrava-cartao-por-inteiro.md` (bug achado e corrigido testando ao vivo) |
| Assinatura por cartão | ✅ funcional, homologada com pagamento real em produção (26/09/2026) | `CLAUDE.md` raiz, 26/09/2026 |
| Assinatura por Pix Automático | ⚠️ implementada, mas **desligada nesta conta Asaas** | `CONSTRAINTS.md` §2.4 |
| Cancelar/pausar/retomar assinatura | ✅ funcional | `docs/funcional.md`, RN-20/21 |
| Trocar de plano (upgrade/downgrade) | ⚠️ recusada com `409 troca_de_valor_nao_suportada` em assinatura de cartão, que é limitação deliberada da V1. A infraestrutura de aprovação em `/troca` vale para outros meios | ADR-011, RN-35.4, `API.md` §5.6 |
| Conciliação (pedido e assinatura) | ✅ funcional, reconcilia `status`/`ciclo`/`proximaCobranca`/`valor` | `API.md` §5.2/§5.3 |
| Webhook da Asaas (recepção) | ✅ funcional, assinatura HMAC verificada | `webhookController.js` |
| Tratamento dos eventos `SUBSCRIPTION_*` | ❌ não implementado em código, e é POST_V1_HARDENING | marcação no painel feita (18/09); primeiros payloads reais em 25–26/09; o tratamento espera o próximo ciclo pago |
| Estorno | ✅ funcional, integral e parcial, só pelo contratante, com idempotência | `API.md` §5.4 |
| Painel admin | ✅ funcional, atrás de Cloudflare Access + login próprio | `adminController.js`, `CONSTRAINTS.md` §2.6 |
| Métrica de sucesso (cobranças confirmadas) | ✅ funcional, filtra uso interno (`ambiente`/`e_teste`) | migration 0009, RN-33 |
| Captura de exceção (Lei 8) | ✅ funcional, inclusive rejeição de Promise não tratada | migration 0007, `erroService.js` |
| Backup/restauração | ⚠️ ensaiada com sucesso (RTO ~1s), sem cópia periódica fora do provedor | `CONSTRAINTS.md` §3 |
| Acessibilidade WCAG 2.2 AA | ✅ verificada, 0 violações na última rodada | `npm run acessibilidade` |
| Documentos legais (Termos/Privacidade) | ✅ publicados: Termos v3 e Política v4 (26/09/2026), pessoa física, conferidos contra o sistema real | `public/termos.html`, `public/privacidade.html`, `docs/legal-arquivado/` |

## O que está quebrado hoje

Nada conhecido como quebrado em produção no encerramento da V1. As
limitações são deliberadas e estão registradas em `CONSTRAINTS.md`. Um agente que encontrar algo quebrado deve registrar em
`docs/erros/` e atualizar esta tabela na mesma tarefa.

## Migrations

20 arquivos locais (`supabase/migrations/0001` a `0020`), todos
aplicados no schema real; a `0020` foi aplicada e validada em 26/09/2026 — **confirmado pelas colunas existentes**
via `mcp__Supabase__list_tables`, não só pelo nome do arquivo (ver
`RISKS.md` para uma divergência de nomenclatura encontrada entre o
histórico de migrations do Supabase e os nomes de arquivo locais —
inofensiva, mas registrada). Reconfirmar:
```bash
ls supabase/migrations/
```
```
mcp__Supabase__list_migrations(project_id="zacuaroarelaqnzjjlcz")
mcp__Supabase__list_tables(project_id="zacuaroarelaqnzjjlcz", schemas=["public"], verbose=true)
```

## Testes

82 suítes (`tests/executar.js`), todas passando na última execução
(`npm run check`, 26/09/2026). O número exato é conferido por
`tests/o-que-os-documentos-afirmam.js` — não copie um número fixo para
outro documento sem rodar o teste, ele já pegou divergência três vezes
na mesma semana (17-18/09/2026).

## Pipeline do plugin `san-co` — estado

**As sete estações estão fechadas, e a V1 foi encerrada em 26/09/2026.**
A Estação 7 fechou com a varredura final dispensada pelo dono, que está
registrada como exceção em `CONSTRAINTS.md` §3. Não há estação aberta. O
projeto está em estado de coleta, e a V2 só abre na Estação 1, por
decisão formal do dono.

O que resta não reabre a V1: está classificado em `docs/pendencias.md`
e resumido em `HANDOFF.md`. O detalhe dia a dia está em `CLAUDE.md`
(raiz). Este documento resume o **estado**, e o `CLAUDE.md` guarda a
**narrativa**.

## Como reverificar tudo de uma vez

```bash
git status --short && git log -3 --oneline
npm run check
curl -sS https://api.sancocore.com.br/api/saude
northflank get service --project san-checkout --service san-checkout -o json | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['deployment']['internal']['deployedSHA'])"
```
