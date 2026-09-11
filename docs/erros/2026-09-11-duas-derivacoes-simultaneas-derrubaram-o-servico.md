# Duas derivações de senha simultâneas derrubaram o serviço

**Sintoma.** Aviso do Render: *"Web Service san_checkout exceeded its
memory limit, which triggered an automatic restart. While restarting, the
instance was temporarily unavailable."* O painel administrativo estava
sendo usado normalmente; nada no código de pagamento foi tocado.

**Causa raiz.** `senhaConfere` deriva scrypt a N=2^17, que pede **~128
MiB por derivação**, e a instância do Render tem **512 MiB** — free e
Starter de US$ 7 têm a mesma memória, conferido na página de preços. Uma
derivação cabe com folga; duas ao mesmo tempo, somadas ao Node e ao
cliente Supabase, não cabem.

O gatilho foi banal e do lado do cliente: a tela de arquivados chamava
`carregarContratantes()` e `carregarSubcontas()` **sem esperar a
primeira**, e cada uma é uma rota de `/api/admin` — ou seja, duas
derivações disparadas no mesmo instante. O código que fez isso foi
escrito na mesma sessão em que um comentário, duas funções acima,
avisava que paralelizar chamadas de admin estouraria a memória.

O rate limit de 10/min por IP que já existia **não protege disto**: ele
limita a TAXA, não a simultaneidade. Dez chamadas no mesmo segundo
passam pelo limite e pedem 1,28 GB juntas.

**Correção.** Fila de uma derivação por vez em `src/utils/senhaAdmin.js`
(`umaDerivacaoPorVez`), atravessada por toda derivação do processo —
`senhaConfere` e `gerarHashSenha`. Troca memória ilimitada por espera
ilimitada, que é o lado certo de ceder: requisição parada na fila custa
um socket, requisição derivando custa 128 MiB. Do lado do cliente, a
tela de arquivados passou a pedir uma lista de cada vez.

A fila fica no ponto por onde toda derivação passa, e não em quem chama:
guarda espalhada pelos chamadores é guarda que o próximo chamador
esquece — e este erro é exatamente o próximo chamador esquecendo.

**Guarda.** Teste no autoteste do `senhaAdmin.js` que instrumenta a fila
e afirma `pico === 1`: nenhuma tarefa entra antes da anterior sair.
Verificado por mutação — trocar a fila por `Promise.resolve().then()`
faz a suíte falhar. O teste afirma **serialização, não tempo**; medir por
relógio seria teste que falha sozinho em máquina lenta.

**Como evitar na origem.** Operação cara em memória precisa de teto de
**simultaneidade**, não só de taxa — e as duas coisas parecem a mesma
até o dia em que não são. A pergunta que faltou fazer: *quantas destas
cabem ao mesmo tempo na máquina?* Se a resposta for "três", o limite
tem que existir no código, porque nenhum rate limit por minuto o
garante.

E a específica deste projeto, já registrada e ignorada por quem a
escreveu: **chamada de `/api/admin` não se dispara em paralelo.** Ela não
é uma requisição HTTP qualquer — é 128 MiB de trabalho.

**Ecossistema:** sim. Vale para qualquer operação cara por chamada — KDF
de senha, geração de PDF, redimensionamento de imagem, importação de
planilha — em qualquer runtime com memória fixa. O padrão do erro é
sempre o mesmo: existe limite de taxa, não existe limite de
simultaneidade, e ninguém percebe a diferença até a instância reiniciar.
