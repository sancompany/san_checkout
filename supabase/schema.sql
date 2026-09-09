-- San Checkout v2 — schema novo, do zero.
-- MVP desta leva: só Pix está de pé. Cartão/Boleto/Assinatura (pop-up
-- Asaas Checkout) e nota fiscal no Drive entram na próxima — as
-- colunas relacionadas a isso já existem aqui, pra não precisar migrar
-- de novo depois, mas ficam sem uso por enquanto.

create extension if not exists "pgcrypto";

-- Contratantes (projetos que usam o checkout) — todo campo abaixo é
-- SEMPRE inserido manualmente no Supabase, nunca por endpoint público.
create table if not exists contratantes (
  id text primary key,                    -- slug, ex: 'trimundi9'
  nome text not null,
  api_base_url text not null,             -- pra onde o checkout liga (GET /pedido/{id})
  api_key text not null,                  -- chave que o checkout manda (X-Checkout-Key) e que
                                           -- também autentica o próprio contratante no /estornar
  webhook_url text,                       -- pra onde a confirmação de pagamento é enviada
  wallet_id text,                         -- Asaas walletId, se for usar split
  drive_folder_id text,                   -- reservado pra próxima leva (nota fiscal no Drive)
  criado_em timestamptz not null default now()
);

-- Cobranças — registro completo de cada pagamento avulso.
--
-- Duas origens possíveis:
--   1. Pix (nosso, direto): charge_id já existe na criação.
--   2. Cartão/Boleto (pop-up Asaas Checkout): só existe
--      asaas_checkout_id na criação — charge_id só chega depois,
--      quando o webhook CHECKOUT_PAID confirma o pagamento de
--      verdade dentro da pop-up. Por isso charge_id é opcional aqui,
--      diferente da versão anterior deste schema (era chave primária
--      obrigatória, o que quebrava esse segundo fluxo).
create table if not exists cobrancas (
  id uuid primary key default gen_random_uuid(),
  charge_id text unique,                  -- id da cobrança na Asaas — nulo até confirmar (fluxo pop-up)
  asaas_checkout_id text unique,          -- id da sessão Asaas Checkout — só existe no fluxo pop-up
  contratante_id text references contratantes(id) on delete set null,
  pedido_id text,                         -- nulo quando for cobrança de assinatura (usa plano_id)
  plano_id text,                          -- nulo quando for pedido avulso
  documento text,                         -- CPF (pessoa física) ou CNPJ (pessoa jurídica) do pagador
  email text,                             -- coletado em todos os métodos (front sempre pede) —
                                           -- usado só pro e-mail de confirmação (seção 9).
  asaas_subscription_id text,             -- id da assinatura na Asaas — só em cobranças
                                           -- 'assinatura' (1ª cobrança E cada ciclo seguinte),
                                           -- é o que liga um ciclo novo de volta à assinatura
                                           -- (o ciclo novo chega no webhook SEM asaas_checkout_id).
  telefone text,                          -- coletado em todos os métodos (front sempre pede)
  endereco text,                          -- os 8 campos abaixo: só preenchidos em Cartão/
  endereco_numero text,                   -- Assinatura (Pix/Boleto não pedem, Asaas não exige) —
  endereco_complemento text,              -- exigidos pela Asaas como antifraude no Asaas
  bairro text,                            -- Checkout ("O campo address deve ser informado").
  cep text,
  cidade text,
  uf text,
  cidade_ibge integer,                    -- código IBGE numérico (via ViaCEP) — é o que a Asaas
                                           -- espera no campo `city`, não o nome da cidade.
  itens jsonb,
  valor_cheio numeric(10,2),
  desconto numeric(10,2) default 0,
  cupom text,
  valor_com_desconto numeric(10,2),
  frete numeric(10,2) default 0,
  taxa_do_projeto numeric(10,2) default 0,
  taxa_asaas numeric(10,2) default 0,
  taxa_propria numeric(10,2) default 0,
  taxa_isenta boolean default false,
  valor_cobrado numeric(10,2),
  metodo_pagamento text,                  -- 'pix' | 'cartao_credito' | 'boleto' | 'assinatura'
  parcelas integer default 1,
  nota_fiscal_id text,                    -- reservado pra próxima leva
  nota_fiscal_drive_file_id text,         -- reservado pra próxima leva
  nota_fiscal_status text default 'pendente', -- pendente | autorizada | cancelamento_em_processamento |
                                           -- cancelamento_solicitado | cancelada | cancelamento_negado
  status text not null default 'pendente', -- pendente | confirmado | estornado | estorno_solicitado |
                                           -- estorno_negado | vencido | cancelado | expirado
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
-- `create table if not exists` acima é no-op numa tabela já existente —
-- por isso as colunas novas (email, asaas_subscription_id) entram aqui
-- via alter table, ANTES dos índices que dependem delas. Roda liso
-- tanto em banco novo quanto em produção já criada.
alter table cobrancas
  add column if not exists email text,
  add column if not exists asaas_subscription_id text;

create index if not exists idx_cobrancas_contratante on cobrancas(contratante_id);
create index if not exists idx_cobrancas_pedido on cobrancas(contratante_id, pedido_id);
create index if not exists idx_cobrancas_checkout on cobrancas(asaas_checkout_id);
create index if not exists idx_cobrancas_subscription on cobrancas(asaas_subscription_id);

-- Assinaturas — uma linha por assinatura ATIVA na Asaas (id = o
-- `subscription` que a Asaas devolve), usada só pra localizar a
-- assinatura na hora de cancelar (POST /cancelar-assinatura). O
-- histórico de cada cobrança/ciclo mensal fica em `cobrancas`
-- (metodo_pagamento='assinatura'), não aqui.
create table if not exists assinaturas (
  id text primary key,                    -- id da assinatura na Asaas (ex.: 'sub_xxx')
  contratante_id text references contratantes(id) on delete set null,
  plano_id text,                          -- pra notificar o contratante com o planoId certo
  documento text not null,                -- CPF ou CNPJ do assinante
  valor numeric(10,2) not null,
  ciclo text not null,
  status text not null default 'ativa',   -- ativa | cancelada
  proxima_cobranca timestamptz,
  criado_em timestamptz not null default now()
);
alter table assinaturas
  add column if not exists plano_id text;

create index if not exists idx_assinaturas_contratante_plano_documento on assinaturas(contratante_id, plano_id, documento);

-- ---------------------------------------------------------------------
-- MIGRAÇÃO (rodar manualmente no SQL Editor do Supabase se a tabela
-- `cobrancas` já existe em produção/sandbox — `create table if not
-- exists` acima NÃO adiciona colunas numa tabela já criada):
--
-- alter table cobrancas
--   add column if not exists telefone text,
--   add column if not exists endereco text,
--   add column if not exists endereco_numero text,
--   add column if not exists endereco_complemento text,
--   add column if not exists bairro text,
--   add column if not exists cep text,
--   add column if not exists cidade text,
--   add column if not exists uf text,
--   add column if not exists cidade_ibge integer;
--
-- MIGRAÇÃO v2 (CPF/CNPJ) — rodar manualmente se as tabelas `cobrancas`
-- e `assinaturas` já existem em produção/sandbox (a coluna era `cpf`,
-- só aceitava CPF; agora `documento` aceita CPF ou CNPJ):
--
-- alter table cobrancas rename column cpf to documento;
-- alter table assinaturas rename column cpf to documento;
-- alter index idx_assinaturas_contratante_plano_cpf rename to idx_assinaturas_contratante_plano_documento;
-- ---------------------------------------------------------------------

-- RLS — o backend só usa a SUPABASE_SERVICE_KEY (service_role), que
-- ignora RLS de qualquer jeito; isso aqui é só pra fechar a porta caso
-- algum dia uma SUPABASE_ANON_KEY vaze ou seja usada por engano —
-- sem nenhuma policy criada, fica tudo negado por padrão pras roles
-- anon/authenticated. Custo zero, não muda nada pro backend atual.
alter table contratantes enable row level security;
alter table cobrancas enable row level security;
alter table assinaturas enable row level security;
