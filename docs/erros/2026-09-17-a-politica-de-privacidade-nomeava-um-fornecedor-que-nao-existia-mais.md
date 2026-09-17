# A política de privacidade nomeava um fornecedor que o projeto não usava mais

**Quando:** 17/09/2026, escrevendo o aviso do Web Analytics na política
— a correção de um documento achou outra, maior, no mesmo documento.
**Onde:** `public/privacidade.html` §15 e §18.2;
`docs/inventario-de-dados.md` §5.

## O que aconteceu

A política dizia, em duas seções:

> "A SAN & CO. utiliza infraestrutura tecnológica associada ao
> **Render** para componentes da aplicação."
> "**O Render poderá realizar processamento em infraestrutura
> localizada fora do Brasil.**"

A aplicação saiu do Render para a Northflank em **12/09/2026**, cinco
dias antes. E a região da Northflank onde ela roda é
`southamerica-east` — **Brasil**, medido pela API do provedor.

Ou seja: o documento que declara ao titular e à autoridade **para onde
os dados dele vão** nomeava o fornecedor errado, e afirmava
transferência internacional onde ela não acontece mais. O inventário de
dados, que é o registro de operações que a LGPD exige, repetia o mesmo
erro na mesma linha.

E havia um terceiro furo, na direção oposta: a política prometia
comunicações transacionais ao Pagador — "confirmação de pagamento",
"atualização de status" — que **o sistema não envia**. Não há
biblioteca de e-mail no `src/`, e as notificações da Asaas ao comprador
nascem desligadas (`notificationDisabled: true`). Declarar tratamento
que não existe é o espelho de omitir o que existe: nos dois casos o
documento deixa de descrever o sistema.

## Por que ficou assim, e por que ninguém viu

A migração de hospedagem foi tratada como mudança **técnica**. Ela é
também uma mudança de **subprocessador** — e a skill `legal` diz isso
com todas as letras na lista de gatilhos que reabrem o inventário
("integração nova com terceiro", "mudança de onde o dado fica").

O que faltou não foi o conhecimento da regra; foi ela ser parte da
tarefa. Trocar de provedor tem checklist técnico (variáveis, DNS,
webhook, CI) e o checklist parou aí. Os documentos legais não estão no
caminho de nenhum teste, nenhum CI, nenhuma tela — envelhecem em
silêncio absoluto.

E a descoberta foi por acidente: eu estava atrás de uma linha sobre
analytics e li a seção ao lado. Sem isso, o texto seguiria errado até a
Estação 7, que é exatamente quando ele seria lido por um advogado — e
teria sido revisado o documento errado.

## A regra que fica

**Trocar de provedor de infraestrutura não termina no deploy verde:
termina no inventário de dados e na política atualizados, na mesma
tarefa.** A pergunta a fazer no fim de toda migração é "qual documento
afirma onde este dado mora?", e ela tem resposta fixa aqui: o
`docs/inventario-de-dados.md` §5 e a política de privacidade.

**Ecossistema:** sim. Vale para todo projeto com documento legal
publicado e infraestrutura que muda — e é pior quanto mais o projeto
respeita os próprios documentos, porque um texto que ninguém lê engana
menos que um texto que todos citam.

## O que também aprendi sobre o Web Analytics

O beacon do Cloudflare Web Analytics **não estava no HTML**: a
Cloudflare o injeta sozinha (`auto_install`) nas páginas que ela serve.
Procurar `cloudflareinsights` no repositório devolve só a linha da CSP —
e foi essa linha que me fez perguntar. Serviço de terceiro pode estar
ativo num projeto **sem uma linha de código no repositório**; o que
prova é a API do provedor, não o `grep`.
