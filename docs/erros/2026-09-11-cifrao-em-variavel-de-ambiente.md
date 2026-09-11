# Cifrão em variável de ambiente do Render apaga o resto do valor

**Sintoma.** Depois de subir o hash novo (N=2^17) em
`CHECKOUT_ADMIN_PASS_HASH` no Render, o login do admin continuou
recusando a senha certa. Não dava 503 (variável ausente) nem 429 (limite
de taxa) — dava 401 igual a senha errada, e **na mesma velocidade** de
uma rota sem verificação nenhuma.

**Causa raiz.** O Render trata `$` dentro do **valor** de uma variável de
ambiente como início de substituição de shell. O hash tem o formato
`scrypt$N$r$p$sal$hash` — cheio de `$` literais. Tudo depois do primeiro
`$` que não resolve como variável válida é apagado, e o valor que chegava
no processo era só `scrypt`, nunca as 6 partes esperadas. Login certo e
login errado davam o mesmo 401 porque o teste de formato falhava antes de
qualquer derivação.

**Correção.** `gerarHashSenha` passou a envelopar a linha inteira em
base64 antes de devolver — o alfabeto base64 (`A-Za-z0-9+/=`) não tem
`$`. `senhaConfere` decodifica o base64 primeiro e só depois faz o split.
Nada na variável de ambiente tem `$` nunca mais. Ver
`src/utils/senhaAdmin.js`.

**Guarda.** A detecção foi por **tempo**, e é ela que vale guardar:
`senhaConfere` sempre roda a derivação scrypt, mesmo com usuário e senha
errados, de propósito, para não vazar por tempo se o usuário existe.
Então uma rota de admin com credencial errada **tem** que custar o mesmo
que uma derivação real (~800ms local, ~2,5s no Render free tier). Quando
ela voltou no mesmo tempo de uma rota sem guarda nenhuma (~230ms), isso
só podia significar retorno antes de derivar. Medir os dois tempos lado a
lado é a checagem que detecta a volta — e o autoteste de `senhaAdmin.js`
cobre o ida-e-volta do envelope base64.

**Como evitar na origem.** Qualquer segredo guardado em variável de
ambiente que tenha caractere especial de shell (`$`, `` ` ``, `\`,
aspas) é candidato ao mesmo problema em qualquer provedor — não só
Render. Formato seguro por construção: codificar em base64 (ou hex)
antes de guardar, decodificar só dentro do processo. E rota de segurança
que responde **rápido demais** é sinal tão forte quanto rota que
responde errado.

**Ecossistema:** sim — o mesmo apagamento silencioso acontece em qualquer
plataforma que expanda shell no valor da variável, e o formato
`alg$param$sal$hash` é o padrão de fato de hash de senha (PHC string
format), então a colisão é previsível e vai se repetir.
