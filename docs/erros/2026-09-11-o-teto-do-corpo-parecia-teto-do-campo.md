# O teto do corpo parecia teto do campo

**Sintoma.** `POST /api/checkout/pix/...` com um `nome` de **100 KB**
passava por toda a validação do servidor e seguia para a resolução do
pedido. Só não chegou na Asaas porque o contratante não existia.

**Causa raiz.** `nome` nunca teve validador: era checado por ser
verdadeiro e mais nada. Os outros campos tinham validador de FORMATO
(`documentoValido`, `emailValido`, `telefoneValido`, `cepValido`), e
formato não é tamanho — `String(valor).replace(/\D/g, '')` descarta
100 KB de lixo e devolve um CPF perfeitamente válido.

O único teto que existia era o `express.json()`, que limita o **corpo
inteiro** a 100 KB. Ele dá a sensação de teto de campo sem ser: um corpo
com um campo só transforma o limite do corpo no limite daquele campo.

O `maxlength` do formulário não entra na conta. Ele não existe para quem
chama a API direto — que é exatamente o caso que a validação de servidor
existe para cobrir.

**Correção.** Tabela `TETOS` em `src/utils/validadores.js`
(nome 150, e-mail 254, documento 32, telefone 32, CEP 16), aplicada
**antes** da normalização em cada validador, mais um `nomeValido` novo
ligado nos seis pontos de entrada de comprador.

**Guarda.** Autoteste com uma asserção por campo, incluindo os dois
casos finos — documento e telefone longos com um valor válido escondido
dentro, que passariam se o teto viesse depois do `replace`. Todas as
mutações foram detectadas.

**Como evitar na origem.** Validar formato não valida tamanho. E o teto
mora no validador, não em cada controller: eram seis arquivos chamando
os mesmos validadores, e regra repetida em seis lugares é regra que um
dia vale em cinco.

**Ecossistema:** sim — o limite de corpo do parser é o teto que quase
todo projeto tem, e é o que faz o teto por campo parecer redundante.
Vale para qualquer API que aceite texto livre de fora.
