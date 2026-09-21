-- 0012 — índice de intencoes_troca_plano por charge_id
--
-- O webhook confirma o acerto pelo MESMO mecanismo que já existe
-- (`buscarCobranca(chargeId)` em `cobrancaService.js`) e depois precisa
-- achar a INTENÇÃO correspondente para avançar a máquina de estados —
-- ver `docs/specs/2026-09-20-troca-de-plano-redireciona-pagador.md`,
-- "O webhook". `charge_id` só é preenchido quando a cobrança do acerto
-- já foi disparada (`PROCESSING_PAYMENT` em diante); a maioria das
-- linhas nasce e morre em `PENDING_APPROVAL`/`EXPIRED` sem nunca cobrar
-- — daí o índice parcial.

create index if not exists idx_intencoes_troca_charge_id
  on intencoes_troca_plano(charge_id)
  where charge_id is not null;
