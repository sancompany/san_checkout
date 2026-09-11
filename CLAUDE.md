# San Checkout — SAN & CO. Pay Engine

Projeto da San & Co. Segue as leis de construção do plugin `san-co`.

Motor de pagamento whitelabel, modelo *pull*: o checkout não guarda
catálogo — pergunta os dados de cada pedido à API do próprio contratante
e cobra o valor que recebeu nessa resposta.

## Antes de propor ou escrever qualquer coisa, leia

- `CONSTRAINTS.md` — o que este projeto deliberadamente NÃO faz, e os limites assumidos
- `docs/specs/2026-09-11-san-checkout.md` — por que existe, para quem, e o veredito dos contrapontos
- `docs/erros/` — o que já deu errado aqui; não repita
- `README.md` — como rodar e como executar os testes
- `API.md` — o contrato com quem integra (mantido na raiz de propósito: é o documento mais lido do repositório)
- `docs/inventario-de-dados.md` — que dado de pessoa este projeto coleta

## Classificação

Porte: plataforma multi-inquilino (contratantes, painel administrativo,
5 métodos de pagamento, recorrência, webhooks de saída) ·
Dado: **alto** — nome, e-mail, CPF/CNPJ, telefone e endereço completo de
compradores terceiros, mais histórico financeiro; cartão nunca toca o
servidor (delegado à Asaas) ·
Vida útil: **longa e declarada** — infraestrutura compartilhada do
ecossistema, com exigência explícita de não precisar de atualização
constante
→ rigor **topo da escala**. As quatro obrigações da Lei 0 valem aqui, e
nenhuma lei abaixo é dispensável por proporcionalidade.

## Conformidade é obrigatória

Violação encontrada segue o ciclo das leis: corrigir o aditivo na hora,
propor o estrutural, registrar a decisão no documento certo, reverificar.
Não existe estado final fora de conformidade — ou corrige, ou vira
exceção registrada no `CONSTRAINTS.md`.

## Pendências de conformidade abertas

- **Lei 0 · `revisar` nunca rodou.** Tudo que está em produção subiu sem
  passar pela skill `revisar`. Pendente de execução, em ciclos.
- **Lei 0 · CI ainda não existe no repositório.** `npm test` já roda as
  três suítes com um comando e reprova de verdade (sai com código 1
  quando uma asserção falha), mas `.github/workflows/ci.yml` **ainda
  precisa ser criado pelo dono do projeto** — `.github/` é uma pasta
  protegida e não pode ser escrita por ferramenta remota. Enquanto isso
  não acontecer, teste não roda sozinho e a Lei 0 segue violada.
- **Lei 0 · cobertura dos testes é rasa.** As três suítes cobrem
  assinatura de webhook, conversão de taxa e regra de id imprevisível.
  Não há teste de rota, de webhook de entrada, nem de fluxo de pagamento.
- **Lei 1 · correções estruturais propostas, aguardando decisão do dono.**
  Mover `mock/` para `tests/`; mover `lacunas-san-checkout-10-09-2026.md`,
  `plano-execucao.md`, `relatorio-seguranca-09-09-2026.md` e `TESTES.md`
  para `docs/`; tirar `Claude outputs/` do versionamento.
- **Lei 6 · `supabase/schema.sql` é arquivo único editado a cada versão**,
  em vez de migrations numeradas e imutáveis. Estrutural, aguardando
  decisão.
- **Lei 10 · retenção de dado pessoal não definida.** Ver a última coluna
  de `docs/inventario-de-dados.md`.
