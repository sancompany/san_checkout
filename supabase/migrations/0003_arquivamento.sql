-- =====================================================================
-- 0003 — ARQUIVAMENTO DE CONTRATANTE E DE SUBCONTA.
--
-- Rodar UMA vez no SQL Editor do Supabase, depois do 0002. Não editar
-- este arquivo depois de aplicado — correção é 0004 (Lei 6, regra em
-- CONSTRAINTS.md §2.1).
--
-- POR QUE ARQUIVAR E NÃO APAGAR
-- `cobrancas.contratante_id` é `on delete set null`: apagar um
-- contratante deixaria o histórico financeiro dele órfão — as cobranças
-- continuam na tabela, sem dono, e nenhuma conciliação futura consegue
-- dizer de quem eram. O veto está no CONSTRAINTS.md §1.10 desde o
-- começo do projeto, junto do caminho que esta migration implementa:
-- contratante arquivado some da lista, PARA DE RESOLVER PEDIDO, e o
-- histórico permanece inteiro.
--
-- Subconta é diferente e a coluna faz menos: ela é uma conta na Asaas,
-- que continua existindo lá. Arquivar aqui só tira da lista do painel.
-- É de propósito — não existe apagar subconta pela API da Asaas sem
-- entrar na conta dela, e o operador não precisa disso para parar de
-- ver o que não usa mais.
-- =====================================================================

alter table contratantes
  add column if not exists arquivado_em timestamptz;

alter table subcontas
  add column if not exists arquivado_em timestamptz;

-- Índices PARCIAIS: a consulta que importa é sempre "os que não estão
-- arquivados" — a lista do painel e, mais importante, a resolução de
-- pedido no caminho do dinheiro. Índice parcial cobre exatamente essa
-- consulta e não cresce com o que foi arquivado.
create index if not exists idx_contratantes_ativos
  on contratantes(id) where arquivado_em is null;

create index if not exists idx_subcontas_ativas
  on subcontas(criado_em desc) where arquivado_em is null;

-- Nenhum dado existente é alterado: `arquivado_em` nasce nulo, e nulo
-- significa ativo. Rodar esta migration não arquiva nada nem muda o
-- comportamento de nenhum contratante que já esteja em uso.
