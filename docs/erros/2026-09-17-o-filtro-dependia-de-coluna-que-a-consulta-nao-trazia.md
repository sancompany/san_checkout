# Escrevi o filtro da métrica e a consulta não trazia as colunas dele

**Quando:** 17/09/2026, no ciclo de revisão da própria mudança que criou
as colunas `ambiente` e `e_teste` (migration 0009, RN-33).
**Onde:** `src/controllers/adminController.js`, `obterMetricas` — o
`select` de `cobrancas`; o filtro em `src/services/metricaService.js`.

## O que aconteceu

O filtro de negócio ficou onde devia ficar, no agregador puro:

```js
function eDeNegocio(c) {
  return c.ambiente === 'producao' && c.e_teste !== true;
}
```

A consulta que alimenta esse agregador lista as colunas uma a uma, e eu
não acrescentei as duas novas:

```js
.select('contratante_id, metodo_pagamento, status, valor_cobrado, criado_em, confirmado_em')
```

Coluna que não vem no `select` chega como `undefined`. E
`undefined !== 'producao'` é verdade, então **toda** cobrança sairia da
conta de negócio. A métrica de sucesso do projeto — "quantas
confirmadas ontem, por contratante" — passaria a ser zero para sempre,
sem erro, sem log, sem tela quebrada.

## Por que passou pelos testes, e pela conferência ao vivo

Duas camadas de coincidência, e as duas merecem nome:

1. **O autoteste do agregador passa linhas à mão.** Os dublês declaram
   `ambiente: 'producao'` porque eu os escrevi assim — eles exercitam a
   conta, não o caminho que traz os dados. A função pura estava certa; o
   defeito morava na fronteira com o banco, que autoteste de função pura
   não alcança por definição.
2. **A resposta errada era, hoje, igual à certa.** Rodei a métrica nova
   contra o banco de produção e vi "10 lidas, 0 de negócio, 10
   excluídas". É exatamente o resultado correto — porque hoje tudo é
   sandbox de verdade. O número certo por motivo errado é o pior tipo de
   evidência: ele encerra a investigação.

O defeito só apareceria no primeiro dia depois da troca para produção, e
apareceria como ausência — nada a investigar, nenhum sintoma além de um
zero plausível.

## A regra que fica

**Filtro que decide fora do banco depende de coluna que o `select`
traz, e isso se confere por teste, não por leitura.** A checagem que
entrou não confere as duas colunas de hoje: ela varre o código de
produção do agregador procurando todo campo lido de uma linha
(`c.<coluna>`) e exige cada um no `select` da rota. Assim a próxima
coluna esquecida cai no teste, não em produção.

É parente da lição de "coluna não criada por `create table if not
exists`" (11/09) e do `payment.cycle` que não existia em payload nenhum
(15/09): em todas as três, **um campo ausente foi lido como se
estivesse presente**, e o valor ausente tinha um significado plausível —
`undefined`, `null`, default do banco. O caminho de dinheiro não erra
com estrondo; erra com um zero que parece certo.

## O tropeço dentro do conserto

A primeira versão da checagem nova **passou em três sabotagens
seguidas**. Ela varria o trecho bruto do controlador entre
`.from('cobrancas')` e `.or(` — e o comentário que eu tinha escrito
logo acima do `select`, explicando por que `ambiente` e `e_teste`
entravam ali, contém essas duas palavras. O teste estava lendo o
comentário e achando que era a consulta.

Corrigido lendo só os literais de texto depois do `.select(`. E a marca
que delimita o fim do trecho (`'Autoteste' + ' —'`) é montada por
concatenação porque, escrita inteira, o `indexOf` a encontrava na
própria linha do teste em vez de no cabeçalho do autoteste — uma
checagem que não consegue falhar não é checagem.

**Ecossistema:** sim. Vale para todo projeto que tenha filtro em código
lendo linha vinda de consulta com colunas enumeradas.
