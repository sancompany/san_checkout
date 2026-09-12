# Vazio bateu com vazio na comparação de credencial

**Sintoma.** Nenhum em produção. Apareceu ao escrever o primeiro
autoteste de `compararSeguro`: a asserção "nulo não bate com vazio"
falhou, e falhou porque estava errada — a função devolvia `true`.

**Causa raiz.** `compararSeguro(a, b)` normalizava os dois lados com
`String(x ?? '')` e comparava com `timingSafeEqual`. Dois valores
ausentes viram dois buffers **vazios**, de tamanho igual, e
`timingSafeEqual` de dois buffers vazios é verdadeiro.

Ou seja: credencial não configurada casando com header não enviado. A
falha abre em vez de fechar, e abre exatamente no cenário mais provável
que existe — uma variável de ambiente faltando num deploy.

Os dois chamadores de hoje (`verificarAdminKey` e
`verificarWebhookAsaas`) já respondem 503 antes de chegar na comparação
quando a env não existe, então não havia buraco aberto. O buraco era o
que o **terceiro** chamador herdaria por escrever uma linha a menos.

**Correção.** `if (bufA.length === 0 || bufB.length === 0) return false;`
dentro do `compararSeguro`, em `src/utils/validadores.js`.

**Guarda.** Autoteste novo do módulo, com quatro asserções sobre vazio e
nulo, registrado em `tests/executar.js`. Verificado por mutação:
removendo a linha da guarda, o teste quebra.

**Como evitar na origem.** Função que promete "comparação segura" cumpre
a promessa sozinha — não delega ao chamador a parte que faz dela segura.
E quando um autoteste falha, a primeira hipótese é que o código esteja
errado, não a asserção: aqui a asserção foi escrita descrevendo o
comportamento esperado, e foi ela que revelou o real.

**Ecossistema:** sim — todo projeto acaba com um utilitário de
comparação de credencial em tempo constante, e a normalização com
`?? ''` é o jeito padrão de escrever. O par
`timingSafeEqual(vazio, vazio) === true` é armadilha de plataforma, não
deste código.
