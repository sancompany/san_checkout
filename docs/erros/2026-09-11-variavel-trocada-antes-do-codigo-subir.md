# Troquei a variável de ambiente antes do código que a lê subir

**Sintoma.** Depois de configurar `CHECKOUT_ADMIN_PASS_HASH` no Render e
remover a `CHECKOUT_ADMIN_PASS` antiga, o painel administrativo passou a
responder `503 — admin desativado` em produção.

**Causa raiz.** Ordem invertida entre dois passos que dependem um do
outro. A variável nova só é lida pelo código novo; o código novo não
tinha sido enviado (o bloco de comandos parou num `git rm` que falhou,
antes do commit). Resultado: o código **velho** rodando em produção
procurava a variável **velha**, que já não existia. Falha fechada
funcionando como projetado — e por isso o serviço caiu em vez de aceitar
qualquer senha.

**Como identificar rápido.** A mensagem do 503 diz qual variável o
código procura. Citando `CHECKOUT_ADMIN_PASS` é código velho no ar;
citando `CHECKOUT_ADMIN_PASS_HASH` é código novo com variável faltando.
São diagnósticos opostos, e a mensagem distingue sem adivinhação.

**Correção.** Subir o código. Nada a desfazer no Render.

**Como evitar na origem.** Mudança que troca o nome de uma variável de
ambiente tem uma ordem só que não derruba nada:

1. Subir o código que aceita a variável nova.
2. Criar a variável nova.
3. Só então remover a antiga.

Trocar a variável primeiro só é seguro quando o código aceita as duas —
e aqui, de propósito, ele não aceita: aceitar a antiga significaria
manter viva a senha em texto puro, que era exatamente o que a mudança
veio eliminar. Sem transição, a ordem acima não é preferência, é
requisito.
