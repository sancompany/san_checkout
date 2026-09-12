# A higiene de erro em produção dependia de uma variável de ambiente

**Sintoma.** `GET /api/checkout/naoexiste` respondia
`<pre>Cannot GET /api/checkout/naoexiste</pre>` — HTML, numa API que só
fala JSON. Corpo malformado respondia `<pre>Bad Request</pre>`.

**Causa raiz.** Não existia nenhum `app.use` de 404 nem de erro no fim da
pilha. Tudo caía nos tratadores embutidos do Express, e o embutido de
erro decide o que mostrar olhando `NODE_ENV`: fora de `'production'`, ele
devolve o **stack trace** na resposta — caminho de arquivo, nome de
módulo e versão de biblioteca, de graça, para quem estiver sondando.

Ou seja, a garantia de não vazar não estava no código: estava numa
variável de ambiente, num painel que ninguém revisa.

E não deu para provar o valor dela de fora. A única pista observável era
o redirecionamento HTTP→HTTPS que o próprio `server.js` faz quando
`NODE_ENV === 'production'`, e o proxy do Render sobrescreve o
`x-forwarded-proto` que esse teste precisaria forjar. "Provavelmente está
certo" não é verificação — e é o tipo de coisa que só se descobre errada
no dia do primeiro erro real.

**Correção.** Dois `app.use` no fim de `src/server.js`, depois de toda
rota: um 404 em JSON e um tratador de erro de quatro parâmetros que
registra o detalhe no log do servidor e devolve mensagem genérica, com
400 quando o erro é do cliente e 500 quando é nosso.

**Guarda.** O comentário acima dos dois explica por que eles existem
tendo o Express os seus, cita a tentativa frustrada de medir o
`NODE_ENV`, e avisa que remover o quarto parâmetro (`proximo`)
transforma o tratador de erro em middleware comum — o erro volta a cair
no embutido, calado.

**Como evitar na origem.** Propriedade de segurança que depende de
configuração do ambiente é propriedade não garantida. Quando dá para
fechar em código, fecha em código — aí o valor da variável deixa de
importar. E tratador de 404 e de erro são os **últimos** `app.use`,
sempre: o Express escolhe por ordem de registro, e um registrado cedo
demais nunca é alcançado.

**Ecossistema:** sim — vale para todo servidor Express/Fastify/Koa. O
comportamento "mostra stack fora de produção" é padrão, e a confiança de
que a variável está certa é universal.
