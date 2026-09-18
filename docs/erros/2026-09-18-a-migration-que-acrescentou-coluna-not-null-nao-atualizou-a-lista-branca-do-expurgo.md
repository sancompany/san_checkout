# A migration que acrescentou coluna `not null` não atualizou a lista branca do expurgo

**Quando:** 18/09/2026, no ciclo de `revisar` sobre o projeto inteiro,
numa varredura dedicada a "furos de lógica entre arquivos" (contrato
banco ↔ código).
**Onde:** `src/services/expurgoService.js` (`FICAM_EM_COBRANCAS`,
`FICAM_EM_ASSINATURAS`, e o retrato `COLUNAS_REAIS` do próprio
autoteste) contra `supabase/migrations/0009_ambiente_e_teste.sql` e
`0010_troca_de_plano.sql`.

## O que aconteceu

A migration 0009 (17/09/2026, RN-33) acrescentou `ambiente` e `e_teste`
a `cobrancas`, as duas `not null`. A migration 0010 (mesmo dia)
acrescentou `plano_anterior_id`, `trocado_em` e `trocando_em` a
`assinaturas`, nenhuma `not null`. **Nenhuma das cinco entrou na lista
branca do expurgo**, que decide o que sobrevive à anonimização de dado
pessoal (Lei 10).

`anonimizarLinha()` trata "não está na lista branca" como "sai" — para
toda coluna fora da lista, a menos que já valha o substituto, o patch
grava `null`. Para `ambiente`/`e_teste`, isso é uma constraint `not
null` quebrando: o `UPDATE` da linha inteira falharia, não só os dois
campos. E o erro nem apareceria — `expurgoService.aplicar()` já captura
por linha e empurra pra `relatorio.erros`, mas `server.js` só lê
`relatorios.reduce((soma, r) => soma + r.anonimizadas, 0)` e nunca olha
`erros`. O resultado seria: toda tentativa de anonimizar uma linha de
`cobrancas` falharia, silenciosamente, para sempre — nem log, nem linha
em `erros` (a captura de exceção da Lei 8 também não pega, porque isto
não lança, é um `error` de retorno já engolido antes de chegar lá).

## Por que passou despercebido

O autoteste do arquivo existe exatamente pra pegar isso — é a checagem
"AS DUAS LISTAS COBREM O BANCO REAL", que compara a lista branca contra
um retrato (`COLUNAS_REAIS`) descrito como "do `information_schema` de
produção em 17/09/2026". O problema: **o retrato foi tirado no mesmo dia
das duas migrations, mas antes delas**, e nunca foi atualizado depois. A
checagem então comparava a lista branca contra si mesma por um caminho
indireto — as duas ficaram cegas para a mesma coluna nova, ao mesmo
tempo, pelo mesmo motivo. Um teste que compara duas coisas escritas
juntas não prova nada sobre a terceira coisa (o banco real) que as duas
deveriam refletir.

Sem dano ATIVO até agora porque o projeto tem poucos dias de vida: não
existe cobrança confirmada há mais de cinco anos (o gatilho do prazo), e
nenhum titular pediu exclusão de dado velho o bastante para cair fora da
guarda fiscal (o gatilho do pedido, LGPD art. 18). Os dois caminhos que
chamam `anonimizarLinha('cobrancas', ...)` — `expurgarDadoPessoal()` (o
prazo) e `expurgarDadoPessoalDoTitular()` (o pedido) — já rodam de
verdade em produção (`server.js`, no boot e a cada 24h), só que sobre
zero linhas elegíveis hoje.

## A regra que fica

**Coluna nova entra na tabela e na lista branca do expurgo no MESMO
commit — nunca como acréscimo depois.** É a mesma decisão que a Lei 10
já pedia ("a lista branca falha fechada: coluna que ninguém decidiu é
anonimizada"), mas ela só vale se o retrato contra o qual o autoteste
compara for atualizado junto. O retrato de `COLUNAS_REAIS` foi corrigido
para incluir as cinco colunas das migrations 0009/0010, e as duas listas
(`FICAM_EM_COBRANCAS`/`FICAM_EM_ASSINATURAS`) ganharam as cinco, com a
decisão registrada por linha: `ambiente`/`e_teste` ficam (metadado
operacional, não identifica pessoa); `plano_anterior_id`/`trocado_em`
ficam (rastro técnico da troca, mesma razão de `plano_id`/`ciclo` já
ficarem); `trocando_em` fica (lock operacional, nunca dado de pessoa).

Duas asserções novas por coluna travam a causa e o efeito: o patch NÃO
tenta tocar a coluna, e o valor sobrevive depois do expurgo — sabotagem
verificada (remover as colunas da lista branca reprova o teste com a
mensagem certa, `ok(false, 'ambiente não entra no patch...')`).

**O buraco que deixava isso invisível também foi fechado.** `server.js`
só lia `relatorios.reduce((soma, r) => soma + r.anonimizadas, 0)` — o
array `relatorio.erros` de cada tabela nunca era olhado. Um erro de
constraint em QUALQUER coluna futura (não só esta) falharia do mesmo
jeito calado, de novo. Agora cada mensagem de `relatorio.erros` vira
`console.error` e uma linha em `erros` (Lei 8, via `registrarErro`) —
mesma rota que todo outro erro fora de requisição já usa.

**Ecossistema:** sim. Vale para todo projeto que tenha lista branca (ou
qualquer enumeração de colunas) mantida separada da migration que
desenha a tabela — o gatilho de revisão certo é "toda migration nova
revisita toda lista de colunas do projeto", não "alguém vai lembrar".
