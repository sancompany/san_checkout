# Spec — San Checkout (SAN & CO. Pay Engine)

> **Registro retroativo.** O projeto foi construído antes de as leis do
> plugin `san-co` existirem. Este documento reconstrói as Fases 0-3 a
> partir das decisões efetivamente tomadas e documentadas ao longo da
> construção. Escrito uma vez; não se atualiza a cada mudança — mudança
> de rumo vira ADR em `docs/`, e veto vira linha em `CONSTRAINTS.md`.

Data do registro: 11/09/2026.

## Problema

Cada projeto do ecossistema San & Co. (Trimundi9, Vitrina ADS, e os que
vierem) precisa receber pagamento. Construir cobrança dentro de cada um
significa repetir integração com gateway, tratamento de webhook, cálculo
de taxa, conciliação e conformidade de PCI — e errar em lugares
diferentes a cada vez.

## Usuário

Dois, com necessidades opostas:

- **O comprador**, que quer pagar rápido e sem atrito, e que muitas vezes
  não tem cartão de crédito.
- **O projeto contratante**, que quer receber o dinheiro e ser avisado,
  sem virar especialista em meio de pagamento.

Não há um terceiro: o checkout **não é vendido a clientes externos**. Uso
interno do ecossistema.

## Classificação

Multi-inquilino · dado de terceiro (alto) · dinheiro · vida longa
declarada → **topo da escala de rigor**.

## Decisão de arquitetura central: modelo *pull*

O checkout não guarda catálogo. Recebe apenas referências opacas na URL
(`?c=` e `?pedido=`), liga de volta para a API do contratante
(`GET /pedido/{id}`, autenticado por `X-Checkout-Key`) e cobra o valor
que recebeu **nessa resposta**, nunca um valor vindo do navegador.

## Contrapontos considerados

**"Por que não usar um checkout pronto (Stripe/Mercado Pago/Asaas puro)?"**
Porque o requisito não é só cobrar: é cobrar em nome de vários projetos
com split, com taxa própria somada por cima, com identidade visual única
e sem que nenhum deles precise gerenciar meio de pagamento. O Asaas
resolve o meio de pagamento — e é usado como tal, por baixo. O que foi
construído é a camada que falta acima dele.

**"Por que o parceiro precisa escrever código?"**
É o custo consciente do modelo pull. Em troca, nenhum dado de produto ou
preço vive fora do dono dele, e adulterar a URL não muda o que é cobrado.
A contrapartida assumida é que a documentação vira parte do produto — daí
`API.md` ser tratado como entregável de primeira classe.

**"Por que não guardar o cartão para facilitar a recompra?"**
Vetado. Ver `CONSTRAINTS.md` §1.1 e §1.2 — entraria no escopo PCI-DSS.

**"Por que não um tema por contratante?"**
Tema único e universal. Customização por contratante multiplicaria a
superfície visual a testar sem ganho para o comprador, que não conhece a
marca do checkout de qualquer forma.

## Veredito

Construir. Decisão confirmada na prática: o modelo pull sobreviveu à
entrada da Vitrina ADS (planos B2B recorrentes) sem mudança de
arquitetura — as mudanças que ela forçou foram conjuntos enumerados pela
metade, não a arquitetura. Essa causa raiz virou regra permanente:
**onde a Asaas define um conjunto fechado, o checkout conhece o conjunto
inteiro.**

## Classificação de fronteira — Estação 2 (registrado em 11/09/2026)

**Estrutura**, não projeto — a skill `classificar` já lista San Checkout
entre as peças de estrutura da San & Co., e os quatro testes concordam:

- **Desligamento**: se saísse do ar, todo projeto que cobra (Trimundi9,
  Vitrina ADS, e os que vierem) para junto → mais de um, estrutura.
- **Público**: quem integra é sempre outro sistema (`GET /pedido/{id}`
  autenticado por `X-Checkout-Key`). O comprador que paga na tela do
  checkout não é usuário final *do Checkout* — é usuário final do
  produto do contratante, só passando pela camada de pagamento →
  estrutura.
- **Entrega**: não pode ser vendido isolado a um cliente, porque outros
  projetos do ecossistema dependem dele para cobrar → estrutura.
- **Pedido de mudança**: quem pede alteração de contrato ou conjunto
  suportado é qualquer projeto contratante, não um só → estrutura.

**Capacidades que consome da estrutura San & Co.**: domínio/DNS
(`checkout.sancocore.com.br`, Cloudflare), conta GitHub (repositório),
conta Render (hospedagem do backend), conta Cloudflare Pages
(hospedagem do frontend estático).

**Banco**: próprio e isolado (Supabase dedicado a este projeto — ver
`config/supabase.js`), nunca compartilhado com outro projeto ou peça de
estrutura, por política de dado da skill `classificar`.

**Não consome**: e-mail (Google Workspace) nem Google Drive — os módulos
que existiam para isso (`emailService.js`, `driveService.js`,
`config/googleDrive.js`) já não existem no projeto (ver
`docs/erros/2026-09-11-auditoria-contra-copia-velha.md`). Cada
contratante emite o próprio aviso e nota fiscal (`CONSTRAINTS.md` §1.9).
