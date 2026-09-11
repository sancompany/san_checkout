# Cifrão em variável de ambiente do Render apaga o resto do valor

## O que aconteceu

Depois de subir o hash novo (N=2^17) em `CHECKOUT_ADMIN_PASS_HASH` no
Render, o login do admin continuou recusando a senha certa. Não dava 503
(variável ausente) nem 429 (limite de taxa) — dava 401 igual a senha
errada, e **na mesma velocidade** de uma rota sem verificação nenhuma.

## Como foi encontrado

Medi o tempo de duas chamadas: uma rota sem guard nenhum
(`/pedido/nao-existe`) e a rota de admin com credencial errada de
propósito (`/api/admin/contratantes`). `senhaConfere` sempre roda a
derivação scrypt, mesmo com usuário/senha errados — é assim de propósito,
pra não vazar por tempo se o usuário existe. As duas chamadas voltaram no
mesmo tempo (~230ms), sem o custo de ~800ms da derivação. Isso só
acontece se `senhaConfere` retornou `false` **antes** de tentar derivar —
ou seja, o teste de formato (`partes.length !== 6 || partes[0] !== 'scrypt'`)
falhou.

## Causa raiz

O Render trata `$` dentro do **valor** de uma variável de ambiente como
início de substituição de shell. O hash tem o formato
`scrypt$N$r$p$sal$hash` — cheio de `$` literais. Tudo depois do primeiro
`$` que não resolve como variável válida é apagado. O valor que chegava
no processo era só `scrypt` (ou similar), nunca as 6 partes esperadas.

Login certo e login errado davam o mesmo 401, na mesma velocidade —
indistinguível de fora, e só visível medindo o tempo de resposta.

## Correção

`gerarHashSenha` agora envelopa a linha inteira (`scrypt$N$r$p$sal$hash`)
em base64 antes de devolver — o alfabeto base64 (`A-Za-z0-9+/=`) não tem
`$`. `senhaConfere` decodifica o base64 primeiro, e só depois faz o split
por `$` como antes. Nada na variável de ambiente tem `$` nunca mais.

Ver `src/utils/senhaAdmin.js`.

## Como não repetir

Qualquer segredo guardado em variável de ambiente que tenha caracteres
especiais de shell (`$`, `` ` ``, `\`, aspas) é candidato ao mesmo
problema em qualquer provedor — não só Render. Formato seguro por
construção: codificar em base64 (ou hex) antes de guardar, decodificar
só dentro do processo.

## Fechado — 11/09/2026

Reverificado de duas formas: (1) medição ao vivo mostra a rota de admin
com credencial errada levando ~2,5s contra ~250ms da sonda sem
verificação — tempo compatível com derivação scrypt N=2^17 real
rodando num Render free tier, não mais o retorno instantâneo do formato
quebrado; (2) o dono do projeto testou o login com a senha real depois
de colar o novo valor (base64) no Render e confirmou que entrou.
