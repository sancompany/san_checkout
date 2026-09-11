# A guarda de total zero derrubou a porta de entrada do admin

**Sintoma.** Em produção, o link que o operador usava para chegar no
painel administrativo passou a cair na tela *"Não foi possível calcular o
valor desta compra"*. Nada de erro no console, nada no log: a tela fazia
exatamente o que tinha sido programada para fazer. O que sumiu foi o
acesso do dono ao próprio painel.

**Causa raiz.** A porta do admin estava pendurada no formulário de
pagamento. O caminho era: um contratante de mentira (`admin-master`)
devolvia um pedido de **R$ 0,00** pelo backend real, o checkout
renderizava, e digitar um e-mail específico no campo de e-mail
redirecionava para `admin.html`. A guarda nova recusa total `<= 0` e
esconde o painel de pagamento — some o formulário, some o campo, some a
porta.

O erro não foi a guarda, que está certa: total zero não pode virar tela
comprável. O erro foi escrever `<= 0` **sem conferir quem produz zero de
propósito**. E a resposta estava escrita, em comentário, no
`masterController.js`, a um arquivo de distância: *"`valor: 0` COM
`isentarTaxa: true` … Tentar pagar aqui devolve 400 — de propósito"*. A
skill `depurar` tem esse passo com todas as letras — checar todos os
chamadores antes de editar — e ele foi pulado.

**Correção.** A guarda ficou como estava. O que saiu foi o aparato que
dependia dela: `masterController.js`, `masterRoutes.js`, a rota montada
na raiz do backend, o contratante `admin-master` no Supabase e o
`ligarAtalhoAdmin()` do `public/js/app.js`. O painel passou a ser
alcançado pela própria URL, protegido na borda (`CONSTRAINTS.md` §2.6) em
vez de escondido atrás de um formulário. Para ver a tela do checkout sem
pedido real existe agora `scripts/ver-checkout.mjs`, que roda local e não
toca em produção.

**Guarda.** A suíte cobre o comportamento da guarda, mas ela não teria
pego isto — o defeito não estava no código testado, estava em quem
dependia dele. O que pega é de processo: **antes de apertar uma
validação, procurar quem produz o valor que ela passa a recusar.** Um
`grep` pelo valor de borda (aqui, `valor: 0`) encontra os produtores
legítimos em segundos, e foi o passo que faltou.

**Como evitar na origem.** Validação nova é mudança de contrato com
quem chama, mesmo quando o diff toca um arquivo só — apertar o que é
aceito quebra quem dependia do que era aceito antes. E o padrão maior:
**acesso administrativo não se pendura em fluxo de produto.** A porta
ficou refém de uma tela de pagamento renderizar, de um pedido falso
existir e de uma validação não mudar; bastou uma das três mudar para o
dono perder o acesso. Porta de operação tem entrada própria e proteção
própria.

**Ecossistema:** sim — o par "obscuridade improvisada dentro de um fluxo
de produto" mais "validação apertada sem olhar os produtores do valor
recusado" não depende desta stack, e o segundo é o modo mais comum de um
diff pequeno e correto quebrar algo longe dele.
